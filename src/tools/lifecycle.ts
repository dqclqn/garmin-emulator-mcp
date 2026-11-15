import path from "node:path";
import { locateGarminSdk } from "../config/sdk-locator.js";
import {
  listInstalledDevices,
  parseDeviceProfile,
} from "../metadata/device-parser.js";
import { getActiveDesktop, getWindowInfo, setActiveDesktop } from "../simulator/bridge.js";
import { launchIsolatedSimulator, terminateIsolatedSimulator } from "../simulator/isolated.js";
import { waitForStable } from "../simulator/receipts.js";
import { applyDebugConfig } from "./build-config.js";
import { processManager } from "../simulator/process-manager.js";
import { clearPersistedSession, readPersistedSession, writePersistedSession, sessionId } from "../session/session.js";
import {
  captureAndFormatScreenshot,
  getActiveDeviceId,
  resolveActiveDeviceProfile,
  setManualActiveDeviceId,
  type McpToolContent,
} from "./shared.js";
import type { DeviceProfile } from "../types.js";

export interface SimulatorStatusResult {
  session: {
    id: string;
    previousSessionId?: string;
    adopted: boolean;
    decision: "adopted-existing-simulator" | "current-session" | "no-simulator";
    desktop?: string;
  };
  running: boolean;
  port1234Open: boolean;
  windowId?: number;
  bounds?: { x: number; y: number; width: number; height: number };
  clientSize?: { width: number; height: number };
  foreground?: boolean;
  isolated?: boolean;
  desktop?: string;
  permissions: {
    screenRecording: boolean;
    accessibility: boolean;
  };
  activeDeviceId: string;
  device?: {
    displayName: string;
    resolution: { width: number; height: number };
    isTouch: boolean;
    shape: string;
    buttons: Array<{
      id: string;
      behavior?: string;
      isHold: boolean;
      aliases: string[];
    }>;
  };
}

/**
 * Checks the status of the Connect IQ simulator process, window, network port,
 * permissions, and active device profile.
 */
export async function getSimulatorStatus(): Promise<SimulatorStatusResult> {
  const persistedBefore = readPersistedSession();
  if (!getActiveDesktop() && persistedBefore?.running && persistedBefore.desktop) {
    // A server restart cannot see the previous hidden desktop until it is set.
    setActiveDesktop(persistedBefore.desktop);
  }
  let windowInfo = await getWindowInfo();
  if (!windowInfo.running && getActiveDesktop() && persistedBefore?.desktop) {
    // The persisted hidden desktop may be gone; retry the visible desktop.
    setActiveDesktop(undefined);
    windowInfo = await getWindowInfo();
  }
  const port1234Open = await processManager.isSimulatorPortOpen(1234);
  const activeDeviceId = getActiveDeviceId();

  let profile: DeviceProfile | undefined;
  try {
    profile = resolveActiveDeviceProfile(activeDeviceId);
  } catch {
    // Device profile might not be parsed if SDK root not yet available
  }

  const adoptedFrom =
    persistedBefore?.adoptedFrom ??
    (windowInfo.running && persistedBefore?.running && persistedBefore.sessionId !== sessionId
      ? persistedBefore.sessionId
      : undefined);
  const decision: SimulatorStatusResult["session"]["decision"] = !windowInfo.running
    ? "no-simulator"
    : adoptedFrom
      ? "adopted-existing-simulator"
      : "current-session";
  if (windowInfo.running) {
    writePersistedSession({
      sessionId,
      running: true,
      simulatorPid: windowInfo.pid,
      desktop: windowInfo.desktop ?? getActiveDesktop(),
      windowId: windowInfo.windowId,
      adoptedFrom,
    });
  }
  const result: SimulatorStatusResult = {
    session: {
      id: sessionId,
      previousSessionId: persistedBefore?.sessionId === sessionId ? persistedBefore?.adoptedFrom : persistedBefore?.sessionId,
      adopted: Boolean(adoptedFrom),
      decision,
      desktop: windowInfo.desktop ?? getActiveDesktop(),
    },
    running: windowInfo.running,
    port1234Open,
    windowId: windowInfo.windowId,
    bounds: windowInfo.bounds,
    clientSize: windowInfo.clientSize,
    foreground: windowInfo.foreground,
    isolated: windowInfo.isolated ?? getActiveDesktop() !== undefined,
    desktop: windowInfo.desktop ?? getActiveDesktop(),
    permissions: windowInfo.permissions,
    activeDeviceId,
  };

  if (profile) {
    result.device = {
      displayName: profile.displayName,
      resolution: {
        width: profile.display.location.width,
        height: profile.display.location.height,
      },
      isTouch: profile.display.isTouch,
      shape: profile.display.shape,
      buttons: profile.keys.map((k) => ({
        id: k.id,
        behavior: k.behavior,
        isHold: k.isHold,
        aliases: k.aliases,
      })),
    };
  }

  return result;
}

/**
 * Tool handler: session_start. Reports whether this server adopted a running
 * simulator or started clean, and can explicitly reset the adoption.
 */
export async function handleSessionStart(args?: {
  reset?: boolean;
}): Promise<{ content: McpToolContent[]; isError?: boolean }> {
  try {
    if (args?.reset === true) {
      const terminated = await terminateIsolatedSimulator(true);
      clearPersistedSession();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                sessionId,
                decision: "reset",
                adopted: false,
                terminated,
              },
              null,
              2
            ),
          },
        ],
      };
    }
    const status = await getSimulatorStatus();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sessionId,
              decision: status.session.decision,
              adopted: status.session.adopted,
              previousSessionId: status.session.previousSessionId,
              running: status.running,
              isolated: status.isolated,
              desktop: status.desktop,
              activeDeviceId: status.activeDeviceId,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

/**
 * Tool handler: simulator_status
 */
export async function handleSimulatorStatus(): Promise<{
  content: McpToolContent[];
  isError?: boolean;
}> {
  try {
    const status = await getSimulatorStatus();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(status, null, 2),
        },
      ],
    };
  } catch (err: any) {
    return {
      content: [
        {
          type: "text",
          text: `Error checking simulator status: ${err?.message || err}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Tool handler: launch_simulator
 */
export async function handleLaunchSimulator(args?: {
  wait_ms?: number;
  isolated?: boolean;
}): Promise<{
  content: McpToolContent[];
  isError?: boolean;
}> {
  try {
    const sdkPaths = locateGarminSdk();
    const activeDeviceId = getActiveDeviceId();

    const existing = await getWindowInfo();
    if (existing.running) {
      const status = await getSimulatorStatus();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                alreadyRunning: true,
                isolated: existing.isolated ?? getActiveDesktop() !== undefined,
                desktop: existing.desktop ?? getActiveDesktop(),
                activeDeviceId,
                windowId: existing.windowId,
                bounds: existing.bounds,
                clientSize: existing.clientSize,
                permissions: status.permissions,
                note: existing.isolated
                  ? "The simulator is already running on an isolated desktop."
                  : "The simulator is already running on the normal desktop. Terminate it first to relaunch isolated.",
              },
              null,
              2
            ),
          },
        ],
      };
    }

    const wantIsolated = args?.isolated !== false && process.platform === "win32";

    if (wantIsolated) {
      let expectedWidth: number | undefined;
      try {
        expectedWidth = resolveActiveDeviceProfile(activeDeviceId).bezelDimensions?.width;
      } catch {
        // The SDK may not be fully initialised yet.
      }

      const isolated = await launchIsolatedSimulator({
        simulatorPath: sdkPaths.simulatorAppPath,
        expectedClientWidth: expectedWidth,
        waitMs: args?.wait_ms ?? 25000,
      });
      const status = await getSimulatorStatus();
      const portOpen = await processManager.isSimulatorPortOpen(1234);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                started: true,
                isolated: true,
                desktop: isolated.desktop,
                portOpen,
                processReady: portOpen && isolated.windowStable,
                ready: portOpen && isolated.windowStable && !isolated.placeholderSize,
                geometryReady: !isolated.placeholderSize,
                windowStable: isolated.windowStable,
                placeholderSize: isolated.placeholderSize,
                expectedClientWidth: isolated.expectedClientWidth,
                activeDeviceId,
                window: isolated.bounds,
                clientSize: isolated.clientSize,
                permissions: status.permissions,
                note: isolated.placeholderSize
                  ? "The simulator is running on a hidden desktop but its window still has the pre-app placeholder size. Run the app before using calibrated display geometry."
                  : "The simulator runs on a hidden desktop. Button input is delivered there without changing your foreground window.",
              },
              null,
              2
            ),
          },
        ],
        isError: !portOpen,
      };
    }

    setActiveDesktop(undefined);
    const result = await processManager.launchSimulatorApp(
      sdkPaths,
      args?.wait_ms ?? 15000
    );
    const status = await getSimulatorStatus();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: result.started && result.portOpen && result.ready,
              started: result.started,
              portOpen: result.portOpen,
              ready: result.ready,
              isolated: false,
              activeDeviceId,
              window: result.window,
              clientSize: result.clientSize,
              permissions: status.permissions
            },
            null,
            2
          ),
        },
      ],
      isError: !result.started || !result.portOpen,
    };
  } catch (err: any) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to launch Connect IQ simulator: ${err?.message || err}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Tool handler: list_devices
 */
export async function handleListDevices(args?: {
  query?: string;
  touch_only?: boolean;
}): Promise<{
  content: McpToolContent[];
  isError?: boolean;
}> {
  try {
    const devices = listInstalledDevices({
      query: args?.query,
      touchOnly: args?.touch_only,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              total: devices.length,
              devices,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (err: any) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to list installed devices: ${err?.message || err}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Tool handler: set_active_device
 */
export async function handleSetActiveDevice(args: {
  device_id: string;
}): Promise<{
  content: McpToolContent[];
  isError?: boolean;
}> {
  try {
    const profile = parseDeviceProfile(args.device_id);
    const previous = processManager.getCurrentDeviceId() ?? getActiveDeviceId();
    const running = await getWindowInfo();
    if (running.running && previous !== profile.deviceId) {
      return {
        content: [
          {
            type: "text",
            text:
              `E_DEVICE_BINDING_REQUIRED: the simulator is running as ${previous}. ` +
              `Terminate it before switching to ${profile.deviceId}, then launch again, ` +
              `or pass device_id to run_app so the running device matches the metadata.`,
          },
        ],
        isError: true,
      };
    }
    setManualActiveDeviceId(profile.deviceId);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              activeDeviceId: profile.deviceId,
              displayName: profile.displayName,
              resolution: {
                width: profile.display.location.width,
                height: profile.display.location.height,
              },
              isTouch: profile.display.isTouch,
              shape: profile.display.shape,
              buttons: profile.keys.map((k) => ({
                id: k.id,
                behavior: k.behavior,
                isHold: k.isHold,
                aliases: k.aliases,
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (err: any) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to set active device to "${args.device_id}": ${err?.message || err}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Tool handler: build_app
 */
export async function handleBuildApp(args: {
  project_dir: string;
  device_id?: string;
  jungle_file?: string;
  developer_key_path?: string;
  output_prg_path?: string;
  extra_args?: string[];
  debug_channel?: boolean;
  timeout_ms?: number;
}): Promise<{
  content: McpToolContent[];
  isError?: boolean;
}> {
  try {
    const sdkPaths = locateGarminSdk();
    const deviceId = getActiveDeviceId(args.device_id);
    const resolvedProjectDir = path.resolve(args.project_dir);
    const restoreConfig = await applyDebugConfig(
      resolvedProjectDir,
      args.debug_channel !== false
    );

    try {
      const result = await processManager.buildMonkeyCProject(sdkPaths, {
        projectDir: resolvedProjectDir,
        deviceId,
        jungleFile: args.jungle_file
          ? path.resolve(args.jungle_file)
          : undefined,
        developerKeyPath: args.developer_key_path
          ? path.resolve(args.developer_key_path)
          : undefined,
        outputPrgPath: args.output_prg_path
          ? path.resolve(args.output_prg_path)
          : undefined,
        timeoutMs: args.timeout_ms,
        extraArgs: args.extra_args,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: result.success,
                exitCode: result.exitCode,
                deviceId,
                debugChannel: args.debug_channel !== false,
                outputPrgPath: result.outputPrgPath,
                prgHash: result.prgHash,
                code: result.success ? undefined : "E_BUILD_FAILED",
                stdout: result.stdout,
                stderr: result.stderr,
              },
              null,
              2
            ),
          },
        ],
        isError: !result.success,
      };
    } finally {
      await restoreConfig();
    }
  } catch (err: any) {
    return {
      content: [
        {
          type: "text",
          text: `Build failed with error: ${err?.message || err}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Tool handler: run_app
 */
export async function handleRunApp(args: {
  prg_path: string;
  device_id?: string;
  wait_ms?: number;
  capture_after?: boolean;
  startup_timeout_ms?: number;
  timeout_ms?: number;
}): Promise<{
  content: McpToolContent[];
  isError?: boolean;
}> {
  try {
    const sdkPaths = locateGarminSdk();
    const deviceId = getActiveDeviceId(args.device_id);
    const resolvedPrgPath = path.resolve(args.prg_path);
    const runLogSeq = processManager.getLogSeq();
    const startedAt = Date.now();

    const result = await processManager.runAppInSimulator(sdkPaths, {
      prgPath: resolvedPrgPath,
      deviceId,
      waitMs: args.wait_ms ?? 2500,
      timeoutMs: args.timeout_ms,
    });

    let startup: Record<string, unknown> | undefined;
    let startupConfirmed = result.startupConfirmed ?? false;
    if (result.launched) {
      const timeout = args.startup_timeout_ms ?? 8000;
      const prgHash = await processManager.verifyPrgHash(resolvedPrgPath);
      let stable: { stable: boolean; hash?: string; frames?: number; ms?: number } = { stable: false };
      try {
        stable = await waitForStable({ timeoutMs: Math.min(timeout, 5000), intervalMs: 150, settleMs: 250 });
      } catch {
        stable = { stable: false };
      }
      const marker = await processManager.waitForLogMarker(
        /FLASHCARDS_APP_STARTED|\.onShow|onStart/i,
        timeout,
        runLogSeq
      );
      const info = await getWindowInfo();
      startup = {
        prgHash: prgHash.status,
        prgHashExpected: prgHash.expected,
        prgHashActual: prgHash.actual,
        stableFrame: stable.stable,
        stableHash: stable.hash,
        stableFrames: stable.frames,
        logMarker: marker.matched,
        logLine: marker.line,
        windowTitle: info.title ?? null,
        elapsedMs: Date.now() - startedAt,
      };
      // A mismatched hash is fatal. A prebuilt PRG with no build hash and a
      // marker plus a stable frame is still a confirmed start.
      startupConfirmed =
        prgHash.status !== "mismatch" && stable.stable && marker.matched;
    }

    const content: McpToolContent[] = [
      {
        type: "text",
        text: JSON.stringify(
          {
            launched: result.launched,
            startupConfirmed,
            startup,
            code: result.launched ? undefined : "E_APP_NOT_LAUNCHED",
            fatalError: result.fatalError,
            deviceId: result.activeDeviceId,
            initialLogs: result.initialLogs,
          },
          null,
          2
        ),
      },
    ];

    if (result.launched && args.capture_after !== false) {
      try {
        // Allow simulator a brief moment to render first frame
        await new Promise((r) => setTimeout(r, 400));
        const screenshotResult = await captureAndFormatScreenshot({
          view: "screen",
          deviceId,
        });
        content.push(...screenshotResult.mcpContent);
      } catch (screenshotErr: any) {
        content.push({
          type: "text",
          text: `Note: App launched, but could not capture initial screenshot: ${screenshotErr?.message || screenshotErr}`,
        });
      }
    }

    return {
      content,
      isError: !result.launched,
    };
  } catch (err: any) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to run app in simulator: ${err?.message || err}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Tool handler: stop_app
 */
export async function handleStopApp(): Promise<{
  content: McpToolContent[];
  isError?: boolean;
}> {
  try {
    const result = await processManager.stopActiveApp();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err: any) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to stop app: ${err?.message || err}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Tool handler: run_unit_tests
 */
export async function handleRunUnitTests(args: {
  prg_path: string;
  device_id?: string;
  test_name?: string;
  timeout_ms?: number;
}): Promise<{
  content: McpToolContent[];
  isError?: boolean;
}> {
  try {
    const sdkPaths = locateGarminSdk();
    const deviceId = getActiveDeviceId(args.device_id);
    const resolvedPrgPath = path.resolve(args.prg_path);

    const result = await processManager.runUnitTests(sdkPaths, {
      prgPath: resolvedPrgPath,
      deviceId,
      testName: args.test_name,
      timeoutMs: args.timeout_ms ?? 30000,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              passed: result.passed,
              exitCode: result.exitCode,
              deviceId,
              output: result.output,
              summary: result.summary,
              signal: result.signal,
              timedOut: result.timedOut ?? false,
              sdkExitCode: result.sdkExitCode,
            },
            null,
            2
          ),
        },
      ],
      isError: !result.passed,
    };
  } catch (err: any) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to execute unit tests: ${err?.message || err}`,
        },
      ],
      isError: true,
    };
  }
}
