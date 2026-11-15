import * as net from "node:net";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { spawn, execFile, ChildProcess } from "node:child_process";
import type { GarminSdkPaths, Rect, WindowInfoResponse } from "../types.js";
import { parseUnitTestOutput, type UnitTestSummary } from "./unit-results.js";
import { getWindowInfo, placeSimulatorWindow } from "./bridge.js";
import { sessionLogPath } from "../session/session.js";

function spawnSdkTool(tool: string, args: string[], options?: { cwd?: string }): ChildProcess {
  if (process.platform !== "win32" || !/monkey(c|do)\.bat$/i.test(tool)) return spawn(tool, args, options);
  const bin = path.dirname(tool);
  const jar = path.join(bin, "monkeybrains.jar");
  if (/monkeyc\.bat$/i.test(tool)) return spawn("java", ["-Xms1g", "-Dfile.encoding=UTF-8", "-cp", jar, "com.garmin.monkeybrains.Monkeybrains", ...args], options);
  const [prg, device, ...rest] = args;
  return spawn("java", ["-classpath", jar, "com.garmin.monkeybrains.monkeydodeux.MonkeyDoDeux", "-f", prg, "-d", device, "-s", path.join(bin, "shell.exe"), ...rest], options);
}

export interface BuildProjectOptions {
  projectDir: string;
  deviceId: string;
  jungleFile?: string;
  developerKeyPath?: string;
  outputPrgPath?: string;
  extraArgs?: string[];
  timeoutMs?: number;
}

export interface BuildResult {
  success: boolean;
  exitCode: number;
  outputPrgPath: string;
  stdout: string;
  stderr: string;
  prgHash?: string;
}

export interface RunAppOptions {
  prgPath: string;
  deviceId: string;
  waitMs?: number;
  timeoutMs?: number;
}

export interface RunAppResult {
  launched: boolean;
  /** True only when the SDK printed an explicit deviceStarted/appStarted marker. */
  startupConfirmed?: boolean;
  activeDeviceId: string;
  initialLogs: string[];
  fatalError?: string;
}

export interface RunUnitTestsOptions {
  prgPath: string;
  deviceId: string;
  testName?: string;
  timeoutMs?: number;
}

export interface RunUnitTestsResult {
  passed: boolean;
  exitCode: number;
  output: string;
  summary: UnitTestSummary;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  /** Raw SDK exit code when it differs from the normalized exitCode. */
  sdkExitCode?: number;
}

export interface GetLogsOptions {
  lines?: number;
  clear?: boolean;
  sinceSeq?: number;
}

export interface LogEntry {
  seq: number;
  text: string;
}

export class SimulatorProcessManager {
  private logs: string[] = [];
  private logSeqs: number[] = [];
  private logSeq = 0;
  private logFilePath?: string;
  public readonly maxBufferSize: number;
  private currentDeviceId?: string;
  private activeProcess: ChildProcess | null = null;
  private lastBuildPath?: string;
  private lastBuildHash?: string;
  private lastRunInfo?: { prgPath: string; deviceId: string };

  constructor(maxBufferSize = 500) {
    this.maxBufferSize = maxBufferSize;
  }

  /**
   * Appends text to the in-memory ring buffer and the session log file.
   * Splits multiline text into individual lines and timestamps them.
   */
  public appendLog(source: string, text: string): void {
    if (!text) return;
    const lines = text.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (line.length === 0) continue;
      const timestamp = new Date().toISOString();
      const formatted = `[${timestamp}] [${source}] ${line}`;
      this.logSeq += 1;
      this.logs.push(formatted);
      this.logSeqs.push(this.logSeq);
      if (this.logs.length > this.maxBufferSize) {
        this.logs.splice(0, this.logs.length - this.maxBufferSize);
        this.logSeqs.splice(0, this.logSeqs.length - this.maxBufferSize);
      }
      try {
        const file = this.getLogFilePath();
        fs.appendFileSync(file, `${this.logSeq}\t${formatted}\n`);
      } catch {
        // Logging must never break a build or an input call.
      }
    }
  }

  /** Path of the persistent session log, created on first use. */
  public getLogFilePath(): string {
    if (!this.logFilePath) {
      this.logFilePath = sessionLogPath();
      fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
    }
    return this.logFilePath;
  }

  /** Sequence number of the most recent log line. */
  public getLogSeq(): number {
    return this.logSeq;
  }

  /**
   * Retrieves lines from the ring buffer.
   * If `lines` is provided, returns the most recent N lines.
   * If `clear` is true, clears the buffer after retrieving.
   */
  public getLogs(options?: GetLogsOptions): string[] {
    const entries = this.getLogEntries(options);
    if (options?.clear) {
      this.clearLogs();
    }
    return entries.map((entry) => entry.text);
  }

  /**
   * Returns log lines with their monotonic sequence numbers.
   * `sinceSeq` filters to lines newer than the supplied cursor.
   */
  public getLogEntries(options?: GetLogsOptions): LogEntry[] {
    let entries: LogEntry[] = this.logs.map((text, index) => ({
      seq: this.logSeqs[index] ?? index + 1,
      text
    }));
    if (options?.sinceSeq !== undefined) {
      const cursor = options.sinceSeq;
      entries = entries.filter((entry) => entry.seq > cursor);
    }
    if (options?.lines !== undefined && options.lines > 0) {
      entries = entries.slice(-options.lines);
    }
    return entries;
  }

  /**
   * Clears the log ring buffer.
   */
  public clearLogs(): void {
    this.logs = [];
  }

  /**
   * Returns the most recently pushed device ID.
   */
  public getCurrentDeviceId(): string | undefined {
    return this.currentDeviceId;
  }

  /**
   * Returns whether an app process is currently active.
   */
  public isAppRunning(): boolean {
    return this.activeProcess !== null && !this.activeProcess.killed;
  }

  /**
   * Returns the active child process if any.
   */
  public getActiveProcess(): ChildProcess | null {
    return this.activeProcess;
  }

  /**
   * Checks whether the Connect IQ simulator TCP port (default 1234) is open and accepting connections.
   */
  public isSimulatorPortOpen(
    port = 1234,
    host = "127.0.0.1",
    timeoutMs = 800
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      let settled = false;

      const cleanup = (isOpen: boolean) => {
        if (!settled) {
          settled = true;
          socket.removeAllListeners();
          socket.destroy();
          resolve(isOpen);
        }
      };

      socket.setTimeout(timeoutMs);
      socket.once("connect", () => cleanup(true));
      socket.once("timeout", () => cleanup(false));
      socket.once("error", () => cleanup(false));
      socket.once("close", () => cleanup(false));

      try {
        socket.connect(port, host);
      } catch {
        cleanup(false);
      }
    });
  }

  /**
   * Launches ConnectIQ.app if not already running and waits for TCP port 1234 to be ready.
   * Also waits for the simulator window to report sane geometry, because a fresh launch
   * briefly returns the Windows -32000 minimized sentinel.
   */
  public async launchSimulatorApp(
    sdkPaths: GarminSdkPaths,
    waitTimeoutMs = 15000
  ): Promise<{
    started: boolean;
    portOpen: boolean;
    ready: boolean;
    window?: Rect;
    clientSize?: { width: number; height: number };
  }> {
    const alreadyOpen = await this.isSimulatorPortOpen(1234);
    if (alreadyOpen) {
      this.appendLog("system", "ConnectIQ simulator is already running on port 1234.");
      const existing = await this.waitForWindowReady();
      return {
        started: true,
        portOpen: true,
        ready: Boolean(existing),
        window: existing?.bounds,
        clientSize: existing?.clientSize
      };
    }

    this.appendLog("system", `Launching ConnectIQ simulator from ${sdkPaths.simulatorAppPath}...`);

    try {
      if (process.platform === "win32") {
        const child = spawn(sdkPaths.simulatorAppPath, [], { detached: true, stdio: "ignore" });
        await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
        child.unref();
      } else {
      await new Promise<void>((resolve, reject) => {
        execFile("open", ["-a", sdkPaths.simulatorAppPath], (err) => {
          if (err) {
            this.appendLog("system", `Failed to run open -a: ${err.message}`);
            reject(err);
          } else {
            resolve();
          }
        });
      });
      }
    } catch (err: any) {
      this.appendLog("stderr", `Could not launch simulator application: ${err?.message || err}`);
      return { started: false, portOpen: false, ready: false };
    }

    const startTime = Date.now();
    const pollIntervalMs = 400;

    while (Date.now() - startTime < waitTimeoutMs) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      const isOpen = await this.isSimulatorPortOpen(1234);
      if (isOpen) {
        this.appendLog("system", "ConnectIQ simulator port 1234 is ready.");
        const windowInfo = await this.waitForWindowReady();
        let window = windowInfo?.bounds;
        if (windowInfo) {
          try {
            const placed = await placeSimulatorWindow();
            if (placed?.moved) {
              this.appendLog(
                "system",
                `Simulator window was outside the visible work area; moved to ${JSON.stringify(placed.bounds)}.`
              );
            }
            if (placed?.bounds) window = placed.bounds;
          } catch (err: any) {
            this.appendLog("system", `Window placement skipped: ${err?.message || err}`);
          }
        }
        return {
          started: true,
          portOpen: true,
          ready: Boolean(windowInfo),
          window,
          clientSize: windowInfo?.clientSize
        };
      }
    }

    this.appendLog("system", `ConnectIQ simulator did not open port 1234 within ${waitTimeoutMs}ms.`);
    return { started: true, portOpen: false, ready: false };
  }

  /**
   * Polls the simulator window until it reports real geometry and a visible frame.
   */
  public async waitForWindowReady(timeoutMs = 8000): Promise<WindowInfoResponse | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const info = await getWindowInfo();
        if (
          info.running &&
          info.bounds &&
          info.bounds.width > 100 &&
          info.bounds.height > 100 &&
          info.bounds.x > -30000 &&
          info.bounds.y > -30000
        ) {
          return info;
        }
      } catch {
        // Window lookup can race with process start; retry until the deadline.
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return null;
  }

  /**
   * Resolves developer key by searching:
   * 1. Explicitly provided developerKeyPath
   * 2. projectDir (developer_key.der, developer_key, developer_key.pem, key.der)
   * 3. sdkmanager-config.ini in connectIqRoot or standard macOS path
   * 4. connectIqRoot (developer_key.der, developer_key)
   * 5. User home directory (~/.garmin/developer_key.der, ~/developer_key.der)
   */
  public async resolveDeveloperKey(
    customKeyPath?: string,
    projectDir?: string,
    connectIqRoot?: string
  ): Promise<string | undefined> {
    if (customKeyPath) {
      const resolved = projectDir && !path.isAbsolute(customKeyPath)
        ? path.resolve(projectDir, customKeyPath)
        : path.resolve(customKeyPath);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
      return customKeyPath;
    }

    // Check projectDir
    if (projectDir) {
      const candidates = [
        path.join(projectDir, "developer_key.der"),
        path.join(projectDir, "developer_key"),
        path.join(projectDir, "developer_key.pem"),
        path.join(projectDir, "key.der"),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    // Check sdkmanager-config.ini
    const configDirs = [
      connectIqRoot,
      path.join(os.homedir(), "Library", "Application Support", "Garmin", "ConnectIQ"),
    ].filter(Boolean) as string[];

    for (const dir of configDirs) {
      const configPath = path.join(dir, "sdkmanager-config.ini");
      if (fs.existsSync(configPath)) {
        try {
          const content = await fs.promises.readFile(configPath, "utf-8");
          const lines = content.split(/\r?\n/);
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("#") || trimmed.startsWith("[")) continue;
            const match = trimmed.match(/^(?:developer[-_]?key|key|signing[-_]?key)\s*=\s*(.*)$/i);
            if (match && match[1]) {
              const cleaned = match[1].trim().replace(/^["']|["']$/g, "");
              if (cleaned && fs.existsSync(cleaned)) {
                return cleaned;
              }
            }
          }
        } catch {
          // Ignore read error
        }
      }
    }

    // Check connectIqRoot
    for (const dir of configDirs) {
      const candidates = [
        path.join(dir, "developer_key.der"),
        path.join(dir, "developer_key"),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    // Check ~/.garmin or ~/
    const homeCandidates = [
      path.join(os.homedir(), ".garmin", "developer_key.der"),
      path.join(os.homedir(), "developer_key.der"),
    ];
    for (const candidate of homeCandidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  /**
   * Helper to construct arguments for monkeyc.
   */
  public buildMonkeyCArgs(options: {
    deviceId: string;
    jungleFile: string;
    outputPrgPath: string;
    developerKeyPath?: string;
    extraArgs?: string[];
  }): string[] {
    const args: string[] = [
      "-d", options.deviceId,
      "-f", options.jungleFile,
      "-o", options.outputPrgPath,
    ];
    if (options.developerKeyPath) {
      args.push("-y", options.developerKeyPath);
    }
    args.push("-w");
    if (options.extraArgs && options.extraArgs.length > 0) {
      args.push(...options.extraArgs);
    }
    return args;
  }

  /**
   * Builds a Monkey C project using `monkeyc`.
   */
  private async hashPrg(prgPath: string): Promise<string | undefined> {
    try {
      const data = await fs.promises.readFile(prgPath);
      return createHash("sha256").update(data).digest("hex");
    } catch {
      return undefined;
    }
  }

  public async buildMonkeyCProject(
    sdkPaths: GarminSdkPaths,
    options: BuildProjectOptions
  ): Promise<BuildResult> {
    const jungleFile = options.jungleFile ?? path.join(options.projectDir, "monkey.jungle");
    const outputPrgPath = options.outputPrgPath ?? path.join(options.projectDir, "bin", "app.prg");
    const devKey = await this.resolveDeveloperKey(
      options.developerKeyPath,
      options.projectDir,
      sdkPaths.connectIqRoot
    );

    await fs.promises.mkdir(path.dirname(outputPrgPath), { recursive: true });

    const args = this.buildMonkeyCArgs({
      deviceId: options.deviceId,
      jungleFile,
      outputPrgPath,
      developerKeyPath: devKey,
      extraArgs: options.extraArgs,
    });

    this.appendLog("system", `Compiling project: ${sdkPaths.monkeycPath} ${args.join(" ")}`);

    return new Promise<BuildResult>((resolve) => {
      const child = spawnSdkTool(sdkPaths.monkeycPath, args, {
        cwd: options.projectDir,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let buildTimedOut = false;
      const buildTimeout = options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            buildTimedOut = true;
            try { child.kill("SIGKILL"); } catch { /* already gone */ }
          }, options.timeoutMs)
        : undefined;

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
        this.appendLog("stdout", chunk.toString("utf-8"));
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
        this.appendLog("stderr", chunk.toString("utf-8"));
      });

      child.on("error", (err: Error) => {
        if (buildTimeout) clearTimeout(buildTimeout);
        const errorMsg = `Error executing monkeyc: ${err.message}`;
        this.appendLog("stderr", errorMsg);
        this.lastBuildPath = path.resolve(outputPrgPath);
        this.lastBuildHash = undefined;
        resolve({
          success: false,
          exitCode: 1,
          outputPrgPath,
          stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
          stderr: Buffer.concat(stderrChunks).toString("utf-8") + "\n" + errorMsg,
        });
      });

      child.on("close", async (code: number | null) => {
        if (buildTimeout) clearTimeout(buildTimeout);
        const exitCode = code ?? -1;
        const stdoutStr = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderrRaw = Buffer.concat(stderrChunks).toString("utf-8");
        const stderrStr = buildTimedOut
          ? `${stderrRaw}\nE_TIMEOUT: build exceeded ${options.timeoutMs}ms`
          : stderrRaw;
        const success = exitCode === 0 && !buildTimedOut;
        const prgHash = success ? await this.hashPrg(outputPrgPath) : undefined;

        this.lastBuildPath = path.resolve(outputPrgPath);
        this.lastBuildHash = prgHash;

        if (success) {
          this.appendLog("system", `monkeyc build succeeded: ${outputPrgPath} (${prgHash ?? "no hash"})`);
        } else {
          this.appendLog("system", `monkeyc build failed with exit code ${exitCode}`);
        }

        resolve({
          success,
          exitCode,
          outputPrgPath,
          stdout: stdoutStr,
          stderr: stderrStr,
          prgHash,
        });
      });
    });
  }

  /**
   * Helper to construct arguments for monkeydo.
   */
  public buildMonkeyDoArgs(
    prgPath: string,
    deviceId: string,
    options?: { test?: boolean; testName?: string }
  ): string[] {
    const args = [prgPath, deviceId];
    if (options?.test) {
      args.push("-t");
      if (options.testName) {
        args.push(options.testName);
      }
    }
    return args;
  }

  /**
   * Runs an app in the Connect IQ simulator via `monkeydo`.
   * Kills any previously running monkeydo process before starting a new one.
   * Streams stdout and stderr lines into the log ring buffer.
   * Waits until deviceStarted / appStarted is detected or waitMs elapses.
   */
  /** The most recent app launch, used by reset and seeding snapshots. */
  public getLastRun(): { prgPath: string; deviceId: string } | undefined {
    return this.lastRunInfo ? { ...this.lastRunInfo } : undefined;
  }

  /** PRG basename in the uppercase form the simulator uses for storage. */
  public getLastRunPrgBasename(): string | undefined {
    return this.lastRunInfo
      ? path.basename(this.lastRunInfo.prgPath, path.extname(this.lastRunInfo.prgPath)).toUpperCase()
      : undefined;
  }

  /** Compares a PRG on disk with the last successful build in this session. */
  public async verifyPrgHash(prgPath: string): Promise<{
    status: "matched" | "mismatch" | "no-build-recorded";
    expected?: string;
    actual?: string;
  }> {
    const actual = await this.hashPrg(prgPath);
    if (!this.lastBuildHash) {
      return { status: "no-build-recorded", actual };
    }
    return {
      status: actual === this.lastBuildHash ? "matched" : "mismatch",
      expected: this.lastBuildHash,
      actual,
    };
  }

  /** Waits for a log line matching `marker` after `sinceSeq`. */
  public async waitForLogMarker(
    marker: RegExp,
    timeoutMs: number,
    sinceSeq: number
  ): Promise<{ matched: boolean; line?: string; seq?: number; elapsedMs: number }> {
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      const entries = this.getLogEntries({ sinceSeq });
      for (const entry of entries) {
        if (marker.test(entry.text)) {
          return {
            matched: true,
            line: entry.text,
            seq: entry.seq,
            elapsedMs: Date.now() - started,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return { matched: false, elapsedMs: Date.now() - started };
  }

  public async runAppInSimulator(
    sdkPaths: GarminSdkPaths,
    options: RunAppOptions
  ): Promise<RunAppResult> {
    await this.stopActiveApp();

    this.currentDeviceId = options.deviceId;
    const waitMs = options.waitMs ?? 2500;

    if (!fs.existsSync(options.prgPath)) {
      const err = `Executable .prg file not found at ${options.prgPath}`;
      this.appendLog("stderr", err);
      return {
        launched: false,
        activeDeviceId: options.deviceId,
        initialLogs: [err],
      };
    }

    if (this.lastBuildPath && path.resolve(this.lastBuildPath) === path.resolve(options.prgPath)) {
      const currentHash = await this.hashPrg(options.prgPath);
      if (!this.lastBuildHash) {
        const err =
          "E_STALE_PRG: the last build for this path failed, so the existing PRG is stale. Rebuild before running.";
        this.appendLog("stderr", err);
        return {
          launched: false,
          activeDeviceId: options.deviceId,
          initialLogs: [err],
          fatalError: err,
        };
      }
      if (currentHash !== this.lastBuildHash) {
        const err =
          "E_STALE_PRG: the PRG on disk changed since the last successful build. Rebuild before running.";
        this.appendLog("stderr", err);
        return {
          launched: false,
          activeDeviceId: options.deviceId,
          initialLogs: [err],
          fatalError: err,
        };
      }
    }

    this.lastRunInfo = { prgPath: path.resolve(options.prgPath), deviceId: options.deviceId };
    const args = this.buildMonkeyDoArgs(options.prgPath, options.deviceId);
    this.appendLog("system", `Running app with monkeydo: ${sdkPaths.monkeydoPath} ${args.join(" ")}`);

    return new Promise<RunAppResult>((resolve) => {
      let settled = false;
      const initialLogs: string[] = [];
      // monkeydo consumes its deviceStarted/appStarted protocol messages internally and
      // normally prints nothing, so a marker alone cannot decide success.
      const triggerRegex = /deviceStarted|appStarted/i;
      const fatalRegex = /Unable to connect to simulator|Unable to launch|not properly signed|Encountered an app crash|Unable to find given PRG|Invalid PRG file|MonkeyDoDeuxException|Unhandled Exception/i;
      let fatal: string | undefined;

      const child = spawnSdkTool(sdkPaths.monkeydoPath, args);
      this.activeProcess = child;

      const finish = (launched: boolean, startupConfirmed = false) => {
        if (!settled) {
          settled = true;
          if (waitTimer) {
            clearTimeout(waitTimer);
          }
          if (hardTimeout) {
            clearTimeout(hardTimeout);
          }
          resolve({
            launched,
            startupConfirmed,
            activeDeviceId: options.deviceId,
            initialLogs: [...initialLogs],
            fatalError: fatal,
          });
        }
      };

      const stopChild = () => {
        if (this.activeProcess === child) this.activeProcess = null;
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
      };

      const hardTimeout = options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            this.appendLog("system", `E_TIMEOUT: app startup exceeded ${options.timeoutMs}ms.`);
            fatal = `E_TIMEOUT: app startup exceeded ${options.timeoutMs}ms`;
            stopChild();
            finish(false);
          }, options.timeoutMs)
        : undefined;

      const waitTimer = setTimeout(() => {
        // Flush any trailing partial lines before deciding.
        flushStdout();
        flushStderr();
        // Alive means the OS process has not exited; `killed` only tracks our own kill.
        const alive = this.activeProcess === child && child.exitCode === null && child.signalCode === null;
        if (fatal) { stopChild(); }
        this.appendLog("system", alive && !fatal
          ? `App startup inferred after ${waitMs}ms (process alive, no fatal output).`
          : `App failed to start within ${waitMs}ms.`);
        finish(alive && !fatal, false);
      }, waitMs);

      // Chunks can split a line. Keep one buffer per stream and flush on close/timeout.
      let bufferedStdout = "";
      let bufferedStderr = "";
      const handleLine = (source: "stdout" | "stderr", line: string) => {
        const trimmed = line.trimEnd();
        if (!trimmed || settled) return;
        initialLogs.push(`[${source}] ${trimmed}`);
        if (fatalRegex.test(trimmed)) {
          fatal = trimmed;
          this.appendLog("stderr", `Fatal launcher output: ${trimmed}`);
          stopChild();
          finish(false);
        } else if (triggerRegex.test(trimmed)) {
          this.appendLog("system", `Startup trigger detected: "${trimmed}"`);
          finish(true, true);
        }
      };
      const consume = (text: string, which: "out" | "err") => {
        let buffer = which === "out" ? bufferedStdout + text : bufferedStderr + text;
        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop() ?? "";
        if (which === "out") bufferedStdout = buffer; else bufferedStderr = buffer;
        for (const part of parts) handleLine(which === "out" ? "stdout" : "stderr", part);
      };
      const flushStdout = () => { const line = bufferedStdout; bufferedStdout = ""; handleLine("stdout", line); };
      const flushStderr = () => { const line = bufferedStderr; bufferedStderr = ""; handleLine("stderr", line); };

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        this.appendLog("stdout", text);
        consume(text, "out");
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        this.appendLog("stderr", text);
        consume(text, "err");
      });

      child.on("error", (err: Error) => {
        const errorMsg = `Failed to spawn monkeydo: ${err.message}`;
        this.appendLog("stderr", errorMsg);
        initialLogs.push(`[error] ${errorMsg}`);
        if (this.activeProcess === child) {
          this.activeProcess = null;
        }
        finish(false);
      });

      child.on("close", (code: number | null) => {
        if (this.activeProcess === child) {
          this.activeProcess = null;
        }
        this.appendLog("system", `monkeydo process exited with code ${code}`);
        if (!settled) {
          finish(false); // A launcher exit, even zero, is not proof of app startup.
        }
      });
    });
  }

  /**
   * Stops the currently active monkeydo app session.
   */
  public async stopActiveApp(): Promise<{ stopped: boolean }> {
    if (!this.activeProcess) {
      return { stopped: false };
    }

    const proc = this.activeProcess;
    this.activeProcess = null;

    if (proc.killed) {
      return { stopped: true };
    }

    return new Promise<{ stopped: boolean }>((resolve) => {
      let resolved = false;

      const finish = () => {
        if (!resolved) {
          resolved = true;
          this.appendLog("system", "Active app session stopped.");
          resolve({ stopped: true });
        }
      };

      const forceKillTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Ignore error
        }
        finish();
      }, 500);

      proc.once("close", () => {
        clearTimeout(forceKillTimer);
        finish();
      });

      try {
        proc.kill("SIGTERM");
      } catch {
        clearTimeout(forceKillTimer);
        finish();
      }
    });
  }

  /**
   * Runs unit tests on a compiled PRG using `monkeydo -t [testName]`.
   * Waits for completion up to `timeoutMs` (default 30000ms) and parses pass/fail results.
   */
  public async runUnitTests(
    sdkPaths: GarminSdkPaths,
    options: RunUnitTestsOptions
  ): Promise<RunUnitTestsResult> {
    const timeoutMs = options.timeoutMs ?? 30000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive finite number.");
    }
    const args = this.buildMonkeyDoArgs(options.prgPath, options.deviceId, {
      test: true,
      testName: options.testName,
    });

    this.appendLog("system", `Running unit tests: ${sdkPaths.monkeydoPath} ${args.join(" ")}`);

    return new Promise<RunUnitTestsResult>((resolve) => {
      let settled = false;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const child = spawnSdkTool(sdkPaths.monkeydoPath, args);

      const finish = (result: RunUnitTestsResult) => {
        if (!settled) {
          settled = true;
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
          }
          resolve(result);
        }
      };

      const timeoutTimer = setTimeout(() => {
        this.appendLog("system", `Unit tests timed out after ${timeoutMs}ms.`);
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore
        }
        const currentOutput = [Buffer.concat(stdoutChunks), Buffer.concat(stderrChunks)]
          .map((buffer) => buffer.toString("utf-8")).filter(Boolean).join("\n");
        finish({
          passed: false,
          exitCode: -1,
          output: currentOutput + `\n[TEST TIMEOUT: Exceeded ${timeoutMs}ms]`,
          summary: parseUnitTestOutput(currentOutput),
          timedOut: true,
        });
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
        this.appendLog("stdout", chunk.toString("utf-8"));
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
        this.appendLog("stderr", chunk.toString("utf-8"));
      });

      child.on("error", (err: Error) => {
        const errorMsg = `Failed to spawn test runner: ${err.message}`;
        this.appendLog("stderr", errorMsg);
        finish({
          passed: false,
          exitCode: 1,
          output: errorMsg,
          summary: parseUnitTestOutput(errorMsg),
        });
      });

      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        const exitCode = code ?? -1;
        const stdoutStr = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderrStr = Buffer.concat(stderrChunks).toString("utf-8");
        const combinedOutput = [stdoutStr, stderrStr].filter(Boolean).join("\n");

        const summary = parseUnitTestOutput(combinedOutput);
        const fatalRunnerOutput = /Encountered an app crash|Unable to communicate with the simulator|Unable to launch|MonkeyDoDeuxException/i.test(combinedOutput);
        // SDK 9.3.0's monkeydo wrapper exits 1 even on a complete PASSED summary.
        // Accept only that specific quirk; any other status or fatal output fails.
        const exitAcceptable = exitCode === 0 || exitCode === 1;
        const passed = !signal && exitAcceptable && !fatalRunnerOutput && summary.complete &&
          summary.executed > 0 && summary.failed === 0 && summary.errors === 0;
        // Normalize the known SDK 9.x wrapper quirk without hiding the raw
        // exit code. A passing summary means the runner result is trustworthy.
        const normalizedExitCode = passed && exitCode === 1 ? 0 : exitCode;

        this.appendLog(
          "system",
          `Unit tests completed with exitCode=${exitCode}, normalizedExitCode=${normalizedExitCode}, passed=${passed}`
        );

        finish({
          passed,
          exitCode: normalizedExitCode,
          output: combinedOutput,
          summary,
          signal,
          sdkExitCode: normalizedExitCode !== exitCode ? exitCode : undefined,
        });
      });
    });
  }
}

export const processManager = new SimulatorProcessManager();
export function getProcessManager(): SimulatorProcessManager {
  return processManager;
}
