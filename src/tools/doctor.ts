import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { locateGarminSdk } from "../config/sdk-locator.js";
import { getWindowInfo, runBridgeCommand } from "../simulator/bridge.js";
import { processManager } from "../simulator/process-manager.js";
import { appDataDir, lockPath, logsDir } from "../session/session.js";
import type { McpToolContent } from "./shared.js";

const execFileAsync = promisify(execFile);

type CheckStatus = "pass" | "warn" | "fail";

interface DoctorCheck {
  id: string;
  status: CheckStatus;
  detail: string;
}

async function runVersion(command: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 8000 });
    return (stdout || stderr).trim().split(/\r?\n/)[0];
  } catch (error: any) {
    const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`.trim();
    return output ? output.split(/\r?\n/)[0] : undefined;
  }
}

function findDeveloperKey(projectDir?: string): string | undefined {
  const candidates: string[] = [];
  if (projectDir) {
    for (const name of ["developer_key.der", "developer_key", "developer_key.pem", "key.der"]) {
      candidates.push(path.join(projectDir, name));
    }
  }
  try {
    const sdk = locateGarminSdk();
    candidates.push(path.join(sdk.connectIqRoot, "developer_key.der"));
    candidates.push(path.join(sdk.connectIqRoot, "developer_key"));
  } catch {
    // SDK missing is reported by another check.
  }
  candidates.push(path.join(os.homedir(), ".garmin", "developer_key.der"));
  candidates.push(path.join(os.homedir(), "developer_key.der"));
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/**
 * Environment checks the agent can run before blaming a tool failure on the app.
 * Read-only: it never starts, stops or writes to the simulator.
 */
export async function handleDoctor(args?: { project_dir?: string }): Promise<{
  content: McpToolContent[];
  isError?: boolean;
}> {
  const checks: DoctorCheck[] = [];
  const add = (id: string, status: CheckStatus, detail: string) =>
    checks.push({ id, status, detail });

  add("node", "pass", `Node ${process.version} on ${process.platform} (${process.arch})`);

  let sdkPaths: ReturnType<typeof locateGarminSdk> | undefined;
  try {
    sdkPaths = locateGarminSdk();
    add("sdk", "pass", `Connect IQ SDK at ${sdkPaths.sdkPath}`);
  } catch (error: any) {
    add("sdk", "fail", error?.message || String(error));
  }

  if (sdkPaths) {
    for (const [id, file] of [
      ["simulator", sdkPaths.simulatorAppPath],
      ["monkeyc", sdkPaths.monkeycPath],
      ["monkeydo", sdkPaths.monkeydoPath],
      ["shell", sdkPaths.shellPath]
    ] as const) {
      add(
        `sdk.${id}`,
        fs.existsSync(file) ? "pass" : "fail",
        fs.existsSync(file) ? file : `Missing ${file}`
      );
    }

    if (fs.existsSync(sdkPaths.devicesDir)) {
      const count = fs
        .readdirSync(sdkPaths.devicesDir)
        .filter((entry) => fs.existsSync(path.join(sdkPaths!.devicesDir, entry, "simulator.json"))).length;
      add(
        "devices",
        count >= 10 ? "pass" : count > 0 ? "warn" : "fail",
        `${count} device profiles installed in ${sdkPaths.devicesDir}`
      );
    } else {
      add("devices", "fail", `Missing devices directory ${sdkPaths.devicesDir}`);
    }
  }

  const javaVersion = await runVersion("java", ["-version"]);
  add(
    "java",
    javaVersion ? "pass" : "fail",
    javaVersion ?? "java not found on PATH; monkeyc needs a JRE"
  );

  if (process.platform === "win32") {
    const psVersion = await runVersion("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$PSVersionTable.PSVersion.ToString()"
    ]);
    add(
      "powershell",
      psVersion ? "pass" : "fail",
      psVersion ?? "Windows PowerShell not found"
    );
  }

  const key = findDeveloperKey(args?.project_dir);
  add(
    "developerKey",
    key ? "pass" : "warn",
    key ?? "No developer key found; pass developer_key_path to build_app"
  );

  const portOpen = await processManager.isSimulatorPortOpen(1234);
  add(
    "simulator.port",
    portOpen ? "pass" : "warn",
    portOpen ? "TCP 1234 is accepting connections" : "TCP 1234 is closed (simulator not running)"
  );

  if (portOpen) {
    try {
      const windowInfo = await getWindowInfo();
      if (windowInfo.running && windowInfo.windowId && windowInfo.bounds) {
        const offscreen =
          windowInfo.bounds.x < -30000 ||
          windowInfo.bounds.y < -30000 ||
          windowInfo.bounds.width < 100;
        add(
          "simulator.window",
          offscreen ? "warn" : "pass",
          offscreen
            ? `Window geometry looks invalid: ${JSON.stringify(windowInfo.bounds)}`
            : `Window ${windowInfo.windowId} at ${JSON.stringify(windowInfo.bounds)}, client ${JSON.stringify(windowInfo.clientSize)}`
        );
        add(
          "simulator.foreground",
          windowInfo.foreground ? "pass" : "warn",
          windowInfo.foreground
            ? "Simulator currently owns foreground"
            : "Simulator is not foreground; input calls will try to activate it"
        );
        if (windowInfo.clientSize && windowInfo.contentOffset) {
          const probeX =
            windowInfo.bounds.x + windowInfo.contentOffset.x + Math.round(windowInfo.clientSize.width / 2);
          const probeY =
            windowInfo.bounds.y + windowInfo.contentOffset.y + Math.round(windowInfo.clientSize.height / 2);
          try {
            const probe = await runBridgeCommand(["probe-point", "--x", String(probeX), "--y", String(probeY)]);
            const occluded = probe?.hwnd && probe.hwnd !== windowInfo.windowId;
            add(
              "simulator.occlusion",
              occluded ? "warn" : "pass",
              occluded
                ? `Another window is on top at the client centre: "${probe.title}" (pid ${probe.pid})`
                : "No window occludes the simulator client centre"
            );
          } catch (error: any) {
            add("simulator.occlusion", "warn", `Could not probe the client centre: ${error?.message || error}`);
          }
        }
      } else {
        add("simulator.window", "warn", "Port 1234 is open but no simulator window was found");
      }
    } catch (error: any) {
      add("simulator.window", "warn", `Window lookup failed: ${error?.message || error}`);
    }
  }

  add("logs", "pass", processManager.getLogFilePath());
  add("state", "pass", appDataDir());
  const lock = lockPath();
  add(
    "sessionLock",
    fs.existsSync(lock) ? "pass" : "warn",
    fs.existsSync(lock) ? `Locked at ${lock}` : `No session lock at ${lock}`
  );

  const summary = {
    pass: checks.filter((check) => check.status === "pass").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: summary.fail === 0,
            summary,
            checks,
            logsDir: logsDir()
          },
          null,
          2
        )
      }
    ],
    isError: summary.fail > 0
  };
}
