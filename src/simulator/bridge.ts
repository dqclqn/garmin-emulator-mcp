import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { locateGarminSdk } from "../config/sdk-locator.js";
import type { Point, Rect, WindowInfoResponse } from "../types.js";

const execFileAsync = promisify(execFile);

let activeDesktop: string | undefined;

/** Sets the isolated desktop that all window and capture calls should target. */
export function setActiveDesktop(name: string | undefined): void {
  activeDesktop = name;
}

/** Returns the isolated desktop name, or undefined for the normal desktop. */
export function getActiveDesktop(): string | undefined {
  return activeDesktop;
}

/**
 * Resolves the path to the compiled macos-bridge binary.
 */
export function getBridgeBinaryPath(): string {
  // Try relative to this file
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidate1 = path.resolve(currentDir, "../../bin/macos-bridge");
  if (fs.existsSync(candidate1)) {
    return candidate1;
  }
  // Try relative to process.cwd()
  const candidate2 = path.resolve(process.cwd(), "bin/macos-bridge");
  if (fs.existsSync(candidate2)) {
    return candidate2;
  }
  // Fall back to candidate1
  return candidate1;
}

/**
 * Resolves the PowerShell bridge script for both source-tree and packaged layouts.
 * The build copies the script to dist/native, so a tarball install works without src/.
 */
export function getWindowsBridgeScriptPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, "../native/windows-bridge.ps1"),
    path.resolve(currentDir, "../../src/native/windows-bridge.ps1"),
    path.resolve(process.cwd(), "dist/native/windows-bridge.ps1"),
    path.resolve(process.cwd(), "src/native/windows-bridge.ps1")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

function simulatorExecutablePath(): string {
  try {
    return fs.realpathSync(locateGarminSdk().simulatorAppPath);
  } catch {
    return "";
  }
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Long-lived PowerShell host. Compiles the inline C# once and answers one JSON
 * request per stdin line, which removes roughly 0.7s of process startup per call.
 */
class WindowsBridgeHost {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private reader: readline.Interface | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private starting: Promise<void> | null = null;
  private disabled = false;
  private startFailures = 0;
  private lastStderr = "";

  constructor(private readonly scriptPath: string) {}

  isDisabled(): boolean {
    return this.disabled;
  }

  /**
   * Keeps the host process from holding the Node event loop open while idle,
   * but keeps it referenced for the duration of an in-flight request so a
   * standalone script cannot exit while awaiting a response.
   */
  private setReferenced(referenced: boolean): void {
    const proc = this.proc;
    if (!proc) return;
    const toggle = (handle: any) => {
      try {
        if (!handle) return;
        if (referenced && typeof handle.ref === "function") handle.ref();
        if (!referenced && typeof handle.unref === "function") handle.unref();
      } catch {
        // Handles can already be closed.
      }
    };
    toggle(proc);
    toggle(proc.stdin);
    toggle(proc.stdout);
    toggle(proc.stderr);
  }

  request(args: string[], timeoutMs = 60000): Promise<any> {
    if (this.disabled) {
      return Promise.reject(new Error("Windows bridge host is disabled"));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (this.pending.size === 0) this.setReferenced(false);
        reject(new Error(`Windows bridge host timed out after ${timeoutMs}ms (${args[0]})`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });

      this.start()
        .then(() => {
          this.setReferenced(true);
          const simulatorPath = args[0] === "ocr" ? "" : simulatorExecutablePath();
          const payload = Buffer.from(
            JSON.stringify({ id, args, simulatorPath })
          ).toString("base64");
          this.proc?.stdin.write(payload + "\n");
        })
        .catch((error) => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        });
    });
  }

  private start(): Promise<void> {
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
      return Promise.resolve();
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = new Promise<void>((resolve, reject) => {
      const proc = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          this.scriptPath,
          "-HostMode",
          "-SimulatorPath",
          simulatorExecutablePath()
        ],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
      this.proc = proc;
      proc.once("error", (error) => {
        this.failAll(error instanceof Error ? error : new Error(String(error)));
        reject(error);
      });
      proc.once("exit", (code) => {
        const detail = this.lastStderr ? `: ${this.lastStderr}` : "";
        this.failAll(new Error(`Windows bridge host exited (code ${code})${detail}`));
        this.proc = null;
        this.reader?.close();
        this.reader = null;
        if (code !== 0) {
          this.startFailures += 1;
          if (this.startFailures >= 2) {
            this.disabled = true;
          }
        }
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        this.lastStderr = chunk.toString("utf-8").trim().slice(-500);
      });
      this.reader = readline.createInterface({ input: proc.stdout });
      this.reader.on("line", (line) => this.onLine(line));
      resolve();
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: any;
    try {
      message = JSON.parse(trimmed);
    } catch {
      // Startup banner or non-protocol output; ignore.
      return;
    }
    const id = message?.id;
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(message.result);
    if (this.pending.size === 0) this.setReferenced(false);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  dispose(): void {
    this.reader?.close();
    this.reader = null;
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null) {
      try {
        proc.kill();
      } catch {
        // already gone
      }
    }
  }
}

let windowsHost: WindowsBridgeHost | null = null;

function getWindowsHost(): WindowsBridgeHost {
  if (!windowsHost) {
    windowsHost = new WindowsBridgeHost(getWindowsBridgeScriptPath());
    process.once("exit", () => windowsHost?.dispose());
  }
  return windowsHost;
}

/** Test hook: stops the persistent host so a fresh script is picked up. */
export function disposeWindowsBridgeHost(): void {
  windowsHost?.dispose();
  windowsHost = null;
}

/**
 * Runs one bridge command in a throwaway PowerShell process.
 * Kept as a fallback when the persistent host cannot start.
 */
export async function runBridgeCommandLegacy(args: string[]): Promise<any> {
  const script = getWindowsBridgeScriptPath();
  const encoded = Buffer.from(JSON.stringify(args)).toString("base64");
  const simulatorPath = args[0] === "ocr" ? "" : simulatorExecutablePath();
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      encoded,
      simulatorPath
    ],
    { maxBuffer: 10 * 1024 * 1024 }
  );
  return JSON.parse(stdout.trim());
}

/**
 * Runs a subcommand on the native bridge (macOS CLI or Windows PowerShell host).
 */
export async function runBridgeCommand(args: string[]): Promise<any> {
  if (process.platform === "win32") {
    const host = getWindowsHost();
    if (host.isDisabled()) {
      return runBridgeCommandLegacy(args);
    }
    return host.request(args);
  }
  const binary = getBridgeBinaryPath();
  if (!fs.existsSync(binary)) {
    throw new Error(
      `macos-bridge binary not found at ${binary}. Build it first with: npm run build:swift`
    );
  }

  const { stdout, stderr } = await execFileAsync(binary, args);
  const trimmed = stdout.trim();
  if (!trimmed) {
    if (stderr.trim()) {
      throw new Error(`macos-bridge error: ${stderr.trim()}`);
    }
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `Failed to parse macos-bridge JSON output: ${trimmed}. Stderr: ${stderr}`
    );
  }
}

/**
 * Computes the client canvas origin inside the simulator window frame.
 * In ConnectIQ.app (wxWidgets on macOS), the window has a 28px macOS title bar at the top
 * and a 28px status bar at the bottom:
 * originX = Math.max(0, Math.round((windowBounds.width - bezelDimensions.width) / 2))
 * originY = top title bar height: if fallbackOffset is provided, use fallbackOffset.y;
 *           otherwise if windowBounds.height >= bezelDimensions.height + 28, use 28
 *           (the standard macOS title bar height, avoiding the bottom status bar);
 *           otherwise fallback to Math.max(0, windowBounds.height - bezelDimensions.height).
 */
export function computeCanvasOrigin(
  windowBounds: Rect,
  bezelDimensions?: { width: number; height: number },
  fallbackOffset?: Point
): Point {
  const fallback = fallbackOffset ?? { x: 0, y: 28 };
  if (!bezelDimensions || bezelDimensions.width <= 0 || bezelDimensions.height <= 0) {
    return fallback;
  }

  const originX = Math.max(0, Math.round((windowBounds.width - bezelDimensions.width) / 2));
  let originY: number;
  if (fallbackOffset !== undefined) {
    originY = fallbackOffset.y;
  } else if (windowBounds.height >= bezelDimensions.height + 28) {
    originY = 28;
  } else {
    originY = Math.max(0, windowBounds.height - bezelDimensions.height);
  }

  return { x: originX, y: originY };
}

/**
 * Inspects running Connect IQ simulator window information, bounds, and permissions.
 */
export async function getWindowInfo(desktop = activeDesktop): Promise<WindowInfoResponse> {
  return await runBridgeCommand(["window-info", ...(desktop ? ["--desktop", desktop] : [])]);
}

/** Creates a hidden desktop, or reuses one already open in the bridge host. */
export async function createDesktop(name: string) {
  return runBridgeCommand(["create-desktop", "--name", name]);
}

/** Closes a hidden desktop after its simulator has stopped. */
export async function closeDesktop(name: string) {
  return runBridgeCommand(["close-desktop", "--name", name]);
}

/** Launches an executable on a hidden desktop and returns its process id. */
export async function launchOnDesktop(desktop: string, exe: string, args?: string) {
  return runBridgeCommand([
    "launch-on-desktop",
    "--desktop",
    desktop,
    "--exe",
    exe,
    ...(args ? ["--args", args] : []),
  ]);
}

/** Lists windows on a hidden desktop, including dialogs. */
export async function listWindowsOnDesktop(desktop: string) {
  return runBridgeCommand(["windows", "--desktop", desktop]);
}

/** Returns direct and nested children of a window handle. */
export async function getWindowChildren(hwnd: number, depth = 3) {
  return runBridgeCommand(["children", "--hwnd", String(hwnd), "--depth", String(depth)]);
}

/** Sends a mouse click to a window on a hidden desktop without focus. */
export async function desktopClick(
  desktop: string,
  hwnd: number,
  x: number,
  y: number,
  holdMs = 80
) {
  return runBridgeCommand([
    "desktop-click",
    "--desktop",
    desktop,
    "--hwnd",
    String(hwnd),
    "--x",
    String(x),
    "--y",
    String(y),
    "--hold-ms",
    String(holdMs),
  ]);
}

/** Sends a drag to a window on a hidden desktop without focus. */
export async function desktopDrag(
  desktop: string,
  hwnd: number,
  from: Point,
  to: Point,
  durationMs = 400
) {
  return runBridgeCommand([
    "desktop-drag",
    "--desktop",
    desktop,
    "--hwnd",
    String(hwnd),
    "--x1",
    String(from.x),
    "--y1",
    String(from.y),
    "--x2",
    String(to.x),
    "--y2",
    String(to.y),
    "--duration-ms",
    String(durationMs),
  ]);
}

/** Sends a key to a window on a hidden desktop without focus. */
export async function desktopKey(
  desktop: string,
  hwnd: number,
  code: number,
  holdMs = 80
) {
  return runBridgeCommand([
    "desktop-key",
    "--desktop",
    desktop,
    "--hwnd",
    String(hwnd),
    "--code",
    String(code),
    "--hold-ms",
    String(holdMs),
  ]);
}

export interface FocusResponse {
  ok: boolean;
  path?: "already" | "setforeground" | "alt" | "attach" | "denied" | string;
  windowId?: number;
  previousForegroundWindowId?: number;
  foregroundWindowId?: number;
  blockerTitle?: string;
  blockerPid?: number;
  error?: string;
}

/**
 * Attempts to bring the simulator to the foreground using the activation ladder:
 * SetForegroundWindow, ALT pulse, then AttachThreadInput.
 */
export async function focusSimulatorWindow(): Promise<FocusResponse> {
  return await runBridgeCommand(["activate"]);
}

/**
 * Activates the Connect IQ simulator application window.
 */
export async function activateSimulator(): Promise<void> {
  const res = await focusSimulatorWindow();
  if (!res.ok) {
    throw new Error(res.error ?? "Windows did not focus the simulator");
  }
}

/** Raises and focuses the simulator window (independent of app activation). */
export async function raiseSimulatorWindow(): Promise<FocusResponse> {
  const res = await focusSimulatorWindow();
  if (res && res.ok === false && res.error) {
    throw new Error(res.error);
  }
  return res;
}

/** Restores focus to a previously focused window after an input lease. */
export async function restoreFocus(windowId: number): Promise<{ ok: boolean; foregroundWindowId?: number }> {
  if (process.platform !== "win32") return { ok: true };
  return await runBridgeCommand(["restore-focus", "--hwnd", String(windowId)]);
}

/**
 * Moves or clamps the simulator window inside the nearest monitor work area.
 */
export async function placeSimulatorWindow(options?: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}): Promise<{
  ok: boolean;
  moved?: boolean;
  visibleRatio?: number;
  bounds?: Rect;
  workArea?: Rect;
  error?: string;
}> {
  const args = ["place"];
  if (typeof options?.x === "number") args.push("--x", String(options.x));
  if (typeof options?.y === "number") args.push("--y", String(options.y));
  if (typeof options?.width === "number") args.push("--width", String(options.width));
  if (typeof options?.height === "number") args.push("--height", String(options.height));
  return await runBridgeCommand(args);
}

/**
 * Synthesizes a mouse click at macOS screen coordinates (x, y).
 */
export async function clickScreenPoint(
  x: number,
  y: number,
  holdMs?: number
): Promise<void> {
  const args = ["click", "--x", String(x), "--y", String(y)];
  if (typeof holdMs === "number") {
    args.push("--hold-ms", String(holdMs));
  }
  const res = await runBridgeCommand(args);
  if (res && res.ok === false) {
    throw new Error(res.error ?? `Failed to click screen point (${x}, ${y})`);
  }
}

/**
 * Synthesizes a smooth mouse drag from (x1, y1) to (x2, y2).
 */
export async function dragScreenPoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs?: number
): Promise<void> {
  const args = [
    "drag",
    "--x1",
    String(x1),
    "--y1",
    String(y1),
    "--x2",
    String(x2),
    "--y2",
    String(y2)
  ];
  if (typeof durationMs === "number") {
    args.push("--duration-ms", String(durationMs));
  }
  const res = await runBridgeCommand(args);
  if (res && res.ok === false) {
    throw new Error(
      res.error ?? `Failed to drag from (${x1}, ${y1}) to (${x2}, ${y2})`
    );
  }
}

/**
 * Synthesizes a keyboard key press by virtual key code.
 */
export async function sendKeyCode(keyCode: number, holdMs?: number): Promise<void> {
  const args = ["key", "--code", String(keyCode)];
  if (typeof holdMs === "number") {
    args.push("--hold-ms", String(holdMs));
  }
  const res = await runBridgeCommand(args);
  if (res && res.ok === false) {
    throw new Error(res.error ?? `Failed to send key code ${keyCode}`);
  }
}

/**
 * Triggers a menu item via macOS Accessibility (AXUIElement).
 */
export async function triggerMenu(
  menuPath: string[]
): Promise<{ ok: boolean; error?: string }> {
  const desktop = activeDesktop;
  if (desktop) {
    const info = await getWindowInfo(desktop);
    if (!info.windowId) {
      return { ok: false, error: "The isolated simulator window is not available." };
    }
    return await runBridgeCommand([
      "menu",
      "--path",
      ...menuPath,
      "--hwnd",
      String(info.windowId),
    ]);
  }
  return await runBridgeCommand(["menu", "--path", ...menuPath]);
}

/**
 * Triggers a menu item by numeric command id (Windows). Menu commands work
 * without focus, which makes them suitable for unattended state changes.
 */
export async function triggerMenuId(id: number): Promise<{ ok: boolean; error?: string }> {
  const desktop = activeDesktop;
  if (desktop) {
    const info = await getWindowInfo(desktop);
    if (!info.windowId) {
      return { ok: false, error: "The isolated simulator window is not available." };
    }
    return await runBridgeCommand([
      "menu-id",
      "--id",
      String(id),
      "--hwnd",
      String(info.windowId),
    ]);
  }
  return await runBridgeCommand(["menu-id", "--id", String(id)]);
}

/**
 * Lists top-level windows owned by the simulator process, including dialogs.
 */
export async function listSimulatorWindows() {
  const desktop = activeDesktop;
  return runBridgeCommand(["windows", ...(desktop ? ["--desktop", desktop] : [])]);
}

/**
 * Closes a simulator-owned window (a dialog, not the main window).
 */
export async function closeSimulatorWindow(hwnd: number) {
  return runBridgeCommand(["close-window", "--hwnd", String(hwnd)]);
}

/**
 * Captures raw window PNG buffer for a given CGWindowID using macOS /usr/sbin/screencapture.
 */
export async function captureRawWindowPng(windowId: number, windowScale = 1): Promise<Buffer> {
  const tmpFile = path.join(
    os.tmpdir(),
    `garmin-capture-${windowId}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`
  );

  try {
    if (process.platform === "win32") {
      const result = await runBridgeCommand(["capture", String(windowId), tmpFile, String(windowScale)]);
      if (!result.ok) throw new Error(result.error);
      return await fs.promises.readFile(tmpFile);
    }
    await execFileAsync("/usr/sbin/screencapture", [
      "-l",
      String(windowId),
      "-o",
      "-x",
      tmpFile
    ]);

    if (!fs.existsSync(tmpFile)) {
      throw new Error(`screencapture did not produce output at ${tmpFile}`);
    }

    const buffer = await fs.promises.readFile(tmpFile);
    if (buffer.length === 0) {
      throw new Error(`screencapture produced an empty image for window ID ${windowId}`);
    }

    return buffer;
  } finally {
    try {
      if (fs.existsSync(tmpFile)) {
        await fs.promises.unlink(tmpFile);
      }
    } catch {
      // Ignore cleanup error
    }
  }
}

/**
 * Object-oriented wrapper class for the macOS simulator bridge.
 */
export class SimulatorBridge {
  constructor(private bridgeBinaryPath: string = getBridgeBinaryPath()) {}

  getWindowInfo(): Promise<WindowInfoResponse> {
    return getWindowInfo();
  }

  activateSimulator(): Promise<void> {
    return activateSimulator();
  }

  clickScreenPoint(x: number, y: number, holdMs?: number): Promise<void> {
    return clickScreenPoint(x, y, holdMs);
  }

  dragScreenPoints(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs?: number
  ): Promise<void> {
    return dragScreenPoints(x1, y1, x2, y2, durationMs);
  }

  sendKeyCode(keyCode: number, holdMs?: number): Promise<void> {
    return sendKeyCode(keyCode, holdMs);
  }

  triggerMenu(menuPath: string[]): Promise<{ ok: boolean; error?: string }> {
    return triggerMenu(menuPath);
  }

  captureRawWindowPng(windowId: number): Promise<Buffer> {
    return captureRawWindowPng(windowId);
  }

  computeCanvasOrigin(
    windowBounds: Rect,
    bezelDimensions?: { width: number; height: number },
    fallbackOffset?: Point
  ): Point {
    return computeCanvasOrigin(windowBounds, bezelDimensions, fallbackOffset);
  }
}
