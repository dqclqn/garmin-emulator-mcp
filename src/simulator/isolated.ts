import {
  closeDesktop,
  createDesktop,
  getActiveDesktop,
  getWindowInfo,
  launchOnDesktop,
  runBridgeCommand,
  setActiveDesktop,
} from "./bridge.js";
import { sessionId } from "../session/session.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let isolatedPid: number | undefined;

/** A desktop name that is valid on Windows and unique to this session. */
export function isolatedDesktopName(): string {
  const suffix = sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(-16) || String(process.pid);
  return `ciq-mcp-${suffix}`;
}

export interface IsolatedLaunchResult {
  desktop: string;
  pid?: number;
  windowId?: number;
  bounds?: { x: number; y: number; width: number; height: number };
  clientSize?: { width: number; height: number };
  expectedClientWidth?: number;
}

/**
 * Creates a hidden desktop, launches the simulator there, and waits until the
 * window has its final client size. Input on this desktop does not change the
 * foreground window on the user's desktop.
 */
export async function launchIsolatedSimulator(options: {
  simulatorPath: string;
  expectedClientWidth?: number;
  waitMs?: number;
}): Promise<IsolatedLaunchResult> {
  if (process.platform !== "win32") {
    throw new Error("Isolated desktop mode is only implemented on Windows.");
  }

  const desktop = isolatedDesktopName();
  await createDesktop(desktop);

  let launchedPid: number | undefined;
  try {
    const launched = await launchOnDesktop(desktop, options.simulatorPath);
    if (!launched.ok) {
      throw new Error(launched.error ?? "Unable to launch the simulator on the isolated desktop.");
    }
    launchedPid = launched.pid;

    const deadline = Date.now() + (options.waitMs ?? 25000);
    let stable: { width: number; height: number } | undefined;
    let stableCount = 0;
    let firstWindowAt: number | undefined;
    let info = await getWindowInfo(desktop);

    while (Date.now() < deadline) {
      await sleep(350);
      info = await getWindowInfo(desktop);
      if (!info.running || !info.windowId) {
        continue;
      }
      if (!firstWindowAt) {
        firstWindowAt = Date.now();
      }
      // The simulator may open at a placeholder size and only resize when the
      // device app runs. Require a real client area, not the final bezel width;
      // run_app waits for the first stable device frame.
      const widthOk = (info.clientSize?.width ?? 0) > 0;
      const size = info.bounds
        ? { width: info.bounds.width, height: info.bounds.height }
        : undefined;
      const settled = Date.now() - firstWindowAt >= 5000;
      if (widthOk && settled && size && size.width > 0 && size.height > 0) {
        if (stable && stable.width === size.width && stable.height === size.height) {
          stableCount += 1;
        } else {
          stable = size;
          stableCount = 1;
        }
        if (stableCount >= 3) {
          break;
        }
      }
    }

    if (!info.running || !info.windowId) {
      throw new Error(
        `The simulator did not create a window on isolated desktop ${desktop} within ${
          options.waitMs ?? 25000
        }ms.`
      );
    }

    isolatedPid = info.pid ?? launchedPid;
    setActiveDesktop(desktop);
    return {
      desktop,
      pid: info.pid ?? launchedPid,
      windowId: info.windowId,
      bounds: info.bounds,
      clientSize: info.clientSize,
      expectedClientWidth: options.expectedClientWidth,
    };
  } catch (error) {
    setActiveDesktop(undefined);
    try {
      await runBridgeCommand(["terminate", "--force"]);
    } catch {
      // The simulator may never have started.
    }
    try {
      await closeDesktop(desktop);
    } catch {
      // The desktop may already be gone.
    }
    throw error;
  }
}

/** Terminates the isolated simulator and destroys its desktop. */
export async function terminateIsolatedSimulator(force = false) {
  const desktop = getActiveDesktop();
  const result = await runBridgeCommand([
    "terminate",
    ...(force ? ["--force"] : []),
  ]);
  isolatedPid = undefined;
  setActiveDesktop(undefined);
  if (desktop) {
    try {
      await closeDesktop(desktop);
    } catch {
      // Desktop teardown is best effort after the process exits.
    }
  }
  return { ...result, desktop };
}

/** Kills the isolated simulator during process exit. Desktop handles close with the bridge host. */
export function killIsolatedSimulatorSync(): void {
  if (isolatedPid === undefined) {
    return;
  }
  try {
    process.kill(isolatedPid);
  } catch {
    // The process may already be gone.
  }
  isolatedPid = undefined;
}

/** Destroys the isolated desktop without touching the simulator process. */
export async function closeIsolatedDesktop(): Promise<void> {
  const desktop = getActiveDesktop();
  if (!desktop) {
    return;
  }
  setActiveDesktop(undefined);
  await closeDesktop(desktop);
}
