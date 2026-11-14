import {
  computeSwipePoints,
  resolveDeviceButton,
} from "../metadata/device-parser.js";
import {
  clickScreenPoint,
  desktopClick,
  desktopDrag,
  dragScreenPoints,
  getActiveDesktop,
  getWindowChildren,
  getWindowInfo,
  sendKeyCode,
} from "../simulator/bridge.js";
import {
  bezelPointToScreenPoint,
  resolveActiveDeviceProfile,
  watchPointToScreenPoint,
  type McpToolContent,
} from "./shared.js";
import {
  expectationError,
  receiptLine,
  runWithReceipt,
  type ScreenExpectation,
} from "./action-receipt.js";
import { describeFocusFailure } from "./lease.js";
import type { DeviceKeyMapping, DeviceProfile, Point, Rect, WindowInfoResponse } from "../types.js";

/**
 * Maps semantic button IDs/aliases to virtual keycodes on macOS.
 */
export function getVirtualKeyCodeForButton(keyId: string): number | undefined {
  const lower = keyId.toLowerCase().trim();
  if (process.platform === "win32") {
    const keys: Record<string, number> = { enter: 13, return: 13, select: 13, start: 13, ok: 13, onselect: 13, esc: 27, escape: 27, back: 27, lap: 27, onback: 27, up: 38, prev: 38, previous: 38, previouspage: 38, down: 40, next: 40, nextpage: 40, left: 37, right: 39, menu: 77, onmenu: 77, space: 32 };
    return keys[lower] ?? (/^\d+$/.test(lower) ? Number(lower) : undefined);
  }
  switch (lower) {
    case "enter":
    case "return":
    case "select":
    case "start":
    case "ok":
    case "onselect":
      return 36; // kVK_Return
    case "esc":
    case "escape":
    case "back":
    case "lap":
    case "onback":
      return 53; // kVK_Escape
    case "up":
    case "prev":
    case "previous":
    case "previouspage":
      return 126; // kVK_UpArrow
    case "down":
    case "next":
    case "nextpage":
      return 125; // kVK_DownArrow
    case "left":
      return 123; // kVK_LeftArrow
    case "right":
      return 124; // kVK_RightArrow
    case "menu":
    case "onmenu":
      return 46; // kVK_ANSI_M
    case "space":
      return 49; // kVK_Space
    default:
      if (/^\d+$/.test(lower)) {
        return parseInt(lower, 10);
      }
      return undefined;
  }
}


interface IsolatedPanel {
  desktop: string;
  hwnd: number;
  rect: Rect;
  windowInfo: WindowInfoResponse;
}

/** Finds the custom watch canvas on the isolated desktop, if isolation is active. */
async function isolatedPanel(): Promise<IsolatedPanel | null> {
  const desktop = getActiveDesktop();
  if (!desktop) {
    return null;
  }
  const windowInfo = await getWindowInfo(desktop);
  if (!windowInfo.running || !windowInfo.windowId) {
    throw new Error(
      "The isolated simulator window is not available. Launch it again with launch_simulator."
    );
  }
  const children = await getWindowChildren(windowInfo.windowId, 2);
  const panels = ((children.children ?? []) as any[])
    .filter((child) => child.class === "wxWindowNR" && child.rect?.width > 0)
    .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
  const panel = panels[0];
  if (!panel) {
    throw new Error("Could not find the simulator canvas on the isolated desktop.");
  }
  return {
    desktop,
    hwnd: panel.hwnd,
    rect: panel.rect,
    windowInfo,
  };
}

function toPanelPoint(screenPoint: Point, panel: IsolatedPanel): Point {
  return {
    x: screenPoint.x - panel.rect.x,
    y: screenPoint.y - panel.rect.y,
  };
}

function focusMode(): "lease" | "none" {
  return getActiveDesktop() ? "none" : "lease";
}

/** Clicks a screen point on the isolated desktop, or the visible desktop. */
async function inputClick(screenPoint: Point, holdMs: number): Promise<void> {
  const panel = await isolatedPanel();
  if (panel) {
    const point = toPanelPoint(screenPoint, panel);
    await desktopClick(panel.desktop, panel.hwnd, point.x, point.y, holdMs);
    return;
  }
  await clickScreenPoint(screenPoint.x, screenPoint.y, holdMs);
}

/** Drags between two screen points on the isolated desktop, or the visible desktop. */
async function inputDrag(
  start: Point,
  end: Point,
  durationMs: number
): Promise<void> {
  const panel = await isolatedPanel();
  if (panel) {
    await desktopDrag(
      panel.desktop,
      panel.hwnd,
      toPanelPoint(start, panel),
      toPanelPoint(end, panel),
      durationMs
    );
    return;
  }
  await dragScreenPoints(start.x, start.y, end.x, end.y, durationMs);
}

/**
 * Sends a virtual key on the visible desktop. Posted key messages are not
 * reliable on the isolated desktop because the simulator polls real key state,
 * so isolated callers must use the pointer path instead.
 */
async function inputKey(keyCode: number, holdMs: number): Promise<void> {
  const panel = await isolatedPanel();
  if (panel) {
    throw new Error(
      "Isolated desktop input uses pointer messages. Key injection is not reliable there; use press_button or tap_screen instead."
    );
  }
  await sendKeyCode(keyCode, holdMs);
}

interface PerformButtonPressResult {
  profile: DeviceProfile;
  keyMapping: DeviceKeyMapping;
  holdDuration: number;
  method: "mouse" | "key";
  screenPoint?: Point;
}

/**
 * Internal helper to resolve and synthesize a single physical or virtual button press.
 */
async function performButtonPress(options: {
  button: string;
  hold?: boolean;
  hold_ms?: number;
  device_id?: string;
  method?: "mouse" | "key";
}): Promise<PerformButtonPressResult> {
  const profile = resolveActiveDeviceProfile(options.device_id);
  const keyMapping = resolveDeviceButton(
    profile,
    options.button,
    options.hold
  );

  if (!keyMapping) {
    const available = profile.keys.map((k) => k.id).join(", ");
    throw new Error(
      `Button "${options.button}" not recognized on device "${profile.deviceId}". Available buttons: ${available}`
    );
  }

  const isLongPress = options.hold || keyMapping.isHold;
  const holdDuration = options.hold_ms ?? (isLongPress ? 1200 : 80);
  const preferredMethod = options.method ?? "mouse";

  if (preferredMethod === "key") {
    const keyCode =
      getVirtualKeyCodeForButton(keyMapping.id) ??
      getVirtualKeyCodeForButton(options.button);

    if (keyCode !== undefined) {
      await inputKey(keyCode, holdDuration);
      return {
        profile,
        keyMapping,
        holdDuration,
        method: "key",
      };
    }
    // Fall back to mouse click if keycode is not mapped
  }

  // The caller holds an input lease, so the window is already focused and restored.
  const windowInfo = await getWindowInfo();
  if (!windowInfo.running || !windowInfo.bounds) {
    throw new Error(
      "Connect IQ simulator window is not running or not visible. Launch it first using launch_simulator."
    );
  }

  const screenPt = bezelPointToScreenPoint(
    keyMapping.center,
    windowInfo.bounds,
    profile, windowInfo.scale ? windowInfo.contentOffset : undefined, windowInfo.scale
  );

  await inputClick(screenPt, holdDuration);

  return {
    profile,
    keyMapping,
    holdDuration,
    method: "mouse",
    screenPoint: screenPt,
  };
}

/**
 * Tool handler: press_button
 */
export async function handlePressButton(args: {
  button: string;
  hold?: boolean;
  hold_ms?: number;
  device_id?: string;
  method?: "mouse" | "key";
  capture_after?: boolean;
  wait_ms?: number;
  expect?: ScreenExpectation;
  settle_ms?: number;
}): Promise<{
  content: McpToolContent[];
  isError?: boolean;
}> {
  try {
    const settleMs = args.settle_ms ?? args.wait_ms ?? 400;
    const outcome = await runWithReceipt({
      deviceId: args.device_id,
      settleMs,
      captureAfter: args.capture_after !== false,
      tag: `press-${args.button}`,
      focus: focusMode(),
      action: async () =>
        performButtonPress({
          button: args.button,
          hold: args.hold,
          hold_ms: args.hold_ms,
          device_id: args.device_id,
          method: args.method,
        }),
    });

    const result = outcome.result;
    const statusText =
      `Pressed button "${result.keyMapping.id}" on "${result.profile.deviceId}" ` +
      `via ${result.method}${result.screenPoint ? ` at (${result.screenPoint.x}, ${result.screenPoint.y})` : ""} ` +
      `(hold: ${result.holdDuration}ms).\n${receiptLine(outcome.receipt, outcome.focusPath)}`;

    const expectation = expectationError(outcome.receipt, args.expect);
    const content: McpToolContent[] = [{ type: "text", text: statusText }];
    if (expectation) {
      content.push({ type: "text", text: expectation });
    }
    content.push(...outcome.content);

    return {
      content,
      isError: expectation ? true : undefined,
    };
  } catch (err: any) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to press button "${args.button}": ${describeFocusFailure(err)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Tool handler: press_button_sequence
 */
export async function handlePressButtonSequence(args: {
  steps: Array<{
    button: string;
    hold?: boolean;
    hold_ms?: number;
    wait_ms?: number;
  }>;
  device_id?: string;
  capture_after?: boolean;
  expect?: ScreenExpectation;
  settle_ms?: number;
}): Promise<{
  content: McpToolContent[];
  isError?: boolean;
}> {
  try {
    const steps = args.steps;
    if (!steps || steps.length === 0) {
      throw new Error("press_button_sequence requires at least one step.");
    }

    const executedSteps: string[] = [];
    const outcome = await runWithReceipt({
      deviceId: args.device_id,
      settleMs: args.settle_ms ?? 400,
      captureAfter: args.capture_after !== false,
      tag: "sequence",
      focus: focusMode(),
      action: async () => {
        let lastDeviceId = args.device_id;
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          const result = await performButtonPress({
            button: step.button,
            hold: step.hold,
            hold_ms: step.hold_ms,
            device_id: args.device_id,
          });
          lastDeviceId = result.profile.deviceId;
          executedSteps.push(
            `Step ${i + 1}: pressed "${result.keyMapping.id}" (${result.holdDuration}ms)`
          );
          if (i < steps.length - 1) {
            await new Promise((r) => setTimeout(r, step.wait_ms ?? 300));
          }
        }
        return lastDeviceId;
      },
    });

    const summaryText =
      `Executed button sequence (${steps.length} steps):\n` +
      executedSteps.join("\n") +
      `\n${receiptLine(outcome.receipt, outcome.focusPath)}`;

    const expectation = expectationError(outcome.receipt, args.expect);
    const content: McpToolContent[] = [{ type: "text", text: summaryText }];
    if (expectation) {
      content.push({ type: "text", text: expectation });
    }
    content.push(...outcome.content);

    return {
      content,
      isError: expectation ? true : undefined,
    };
  } catch (err: any) {
    return {
      content: [
        {
          type: "text",
          text: `Button sequence execution failed: ${describeFocusFailure(err)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Tool handler: tap_screen
 */
export async function handleTapScreen(args: {
  x: number;
  y: number;
  normalized?: boolean;
  device_id?: string;
  capture_after?: boolean;
  wait_ms?: number;
  expect?: ScreenExpectation;
  settle_ms?: number;
}): Promise<{
  content: McpToolContent[];
  isError?: boolean;
}> {
  try {
    const profile = resolveActiveDeviceProfile(args.device_id);

    const watchX = args.normalized
      ? Math.round(args.x * profile.display.location.width)
      : Math.round(args.x);
    const watchY = args.normalized
      ? Math.round(args.y * profile.display.location.height)
      : Math.round(args.y);

    const outcome = await runWithReceipt({
      deviceId: profile.deviceId,
      settleMs: args.settle_ms ?? args.wait_ms ?? 400,
      captureAfter: args.capture_after !== false,
      tag: "tap",
      focus: focusMode(),
      action: async () => {
        const windowInfo = await getWindowInfo();
        if (!windowInfo.running || !windowInfo.bounds) {
          throw new Error(
            "Connect IQ simulator window is not running or not visible. Launch it first using launch_simulator."
          );
        }
        const screenPt = watchPointToScreenPoint(
          { x: watchX, y: watchY },
          windowInfo.bounds,
          profile, windowInfo.scale ? windowInfo.contentOffset : undefined, windowInfo.scale
        );
        await inputClick(screenPt, 80);
        return screenPt;
      },
    });

    const screenPt = outcome.result;
    const statusText =
      `Tapped screen on "${profile.deviceId}" at display point (${watchX}, ${watchY})` +
      ` [screen point (${screenPt.x}, ${screenPt.y})]` +
      (!profile.display.isTouch ? " (Note: device display is not marked touch-enabled)" : "") +
      `.` +
      `\n${receiptLine(outcome.receipt, outcome.focusPath)}`;

    const expectation = expectationError(outcome.receipt, args.expect);
    const content: McpToolContent[] = [{ type: "text", text: statusText }];
    if (expectation) {
      content.push({ type: "text", text: expectation });
    }
    content.push(...outcome.content);

    return {
      content,
      isError: expectation ? true : undefined,
    };
  } catch (err: any) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to tap screen at (${args.x}, ${args.y}): ${describeFocusFailure(err)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Tool handler: swipe_screen
 */
export async function handleSwipeScreen(args: {
  direction: "up" | "down" | "left" | "right";
  device_id?: string;
  capture_after?: boolean;
  wait_ms?: number;
  expect?: ScreenExpectation;
  settle_ms?: number;
}): Promise<{
  content: McpToolContent[];
  isError?: boolean;
}> {
  try {
    const profile = resolveActiveDeviceProfile(args.device_id);
    const { startWatch, endWatch, durationMs } = computeSwipePoints(
      profile,
      args.direction
    );

    const outcome = await runWithReceipt({
      deviceId: profile.deviceId,
      settleMs: args.settle_ms ?? args.wait_ms ?? 400,
      captureAfter: args.capture_after !== false,
      tag: `swipe-${args.direction}`,
      focus: focusMode(),
      action: async () => {
        const windowInfo = await getWindowInfo();
        if (!windowInfo.running || !windowInfo.bounds) {
          throw new Error(
            "Connect IQ simulator window is not running or not visible. Launch it first using launch_simulator."
          );
        }
        const startScreen = watchPointToScreenPoint(
          startWatch,
          windowInfo.bounds,
          profile, windowInfo.scale ? windowInfo.contentOffset : undefined, windowInfo.scale
        );
        const endScreen = watchPointToScreenPoint(
          endWatch,
          windowInfo.bounds,
          profile, windowInfo.scale ? windowInfo.contentOffset : undefined, windowInfo.scale
        );
        await inputDrag(startScreen, endScreen, durationMs);
        return { startScreen, endScreen };
      },
    });

    const statusText =
      `Swiped ${args.direction} on "${profile.deviceId}" from display (${startWatch.x}, ${startWatch.y}) ` +
      `to (${endWatch.x}, ${endWatch.y}) over ${durationMs}ms.` +
      `\n${receiptLine(outcome.receipt, outcome.focusPath)}`;

    const expectation = expectationError(outcome.receipt, args.expect);
    const content: McpToolContent[] = [{ type: "text", text: statusText }];
    if (expectation) {
      content.push({ type: "text", text: expectation });
    }
    content.push(...outcome.content);

    return {
      content,
      isError: expectation ? true : undefined,
    };
  } catch (err: any) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to swipe screen ${args.direction}: ${describeFocusFailure(err)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Tool handler: hold_screen
 */
export async function handleHoldScreen(args: {
  x: number;
  y: number;
  duration_ms?: number;
  normalized?: boolean;
  device_id?: string;
  capture_after?: boolean;
  wait_ms?: number;
  expect?: ScreenExpectation;
  settle_ms?: number;
}): Promise<{
  content: McpToolContent[];
  isError?: boolean;
}> {
  try {
    const profile = resolveActiveDeviceProfile(args.device_id);

    const watchX = args.normalized
      ? Math.round(args.x * profile.display.location.width)
      : Math.round(args.x);
    const watchY = args.normalized
      ? Math.round(args.y * profile.display.location.height)
      : Math.round(args.y);

    const duration = args.duration_ms ?? 1000;
    const outcome = await runWithReceipt({
      deviceId: profile.deviceId,
      settleMs: args.settle_ms ?? args.wait_ms ?? 400,
      captureAfter: args.capture_after !== false,
      tag: "hold",
      focus: focusMode(),
      action: async () => {
        const windowInfo = await getWindowInfo();
        if (!windowInfo.running || !windowInfo.bounds) {
          throw new Error(
            "Connect IQ simulator window is not running or not visible. Launch it first using launch_simulator."
          );
        }
        const screenPt = watchPointToScreenPoint(
          { x: watchX, y: watchY },
          windowInfo.bounds,
          profile, windowInfo.scale ? windowInfo.contentOffset : undefined, windowInfo.scale
        );
        await inputClick(screenPt, duration);
        return screenPt;
      },
    });

    const statusText =
      `Held screen touch on "${profile.deviceId}" at display (${watchX}, ${watchY}) ` +
      `for ${duration}ms.` +
      `\n${receiptLine(outcome.receipt, outcome.focusPath)}`;

    const expectation = expectationError(outcome.receipt, args.expect);
    const content: McpToolContent[] = [{ type: "text", text: statusText }];
    if (expectation) {
      content.push({ type: "text", text: expectation });
    }
    content.push(...outcome.content);

    return {
      content,
      isError: expectation ? true : undefined,
    };
  } catch (err: any) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to hold screen at (${args.x}, ${args.y}): ${describeFocusFailure(err)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Tool handler: send_key
 */
export async function handleSendKey(args: {
  key?: string;
  key_code?: number;
  hold_ms?: number;
  capture_after?: boolean;
  wait_ms?: number;
  device_id?: string;
  expect?: ScreenExpectation;
  settle_ms?: number;
}): Promise<{
  content: McpToolContent[];
  isError?: boolean;
}> {
  try {
    let keyCode = args.key_code;
    if (keyCode === undefined && args.key) {
      keyCode = getVirtualKeyCodeForButton(args.key);
    }
    if (keyCode === undefined) {
      throw new Error(
        `Invalid or unspecified key. Provide either a valid 'key_code' (e.g. 36 for Return) or 'key' (e.g. 'enter', 'esc', 'up', 'down', 'menu', 'space'). Provided: key=${args.key}, key_code=${args.key_code}`
      );
    }

    const holdDuration = args.hold_ms ?? 80;
    const outcome = await runWithReceipt({
      deviceId: args.device_id,
      settleMs: args.settle_ms ?? args.wait_ms ?? 400,
      captureAfter: args.capture_after === true,
      tag: "key",
      focus: focusMode(),
      action: () => inputKey(keyCode as number, holdDuration),
    });

    const statusText =
      `Sent virtual keycode ${keyCode}${args.key ? ` ('${args.key}')` : ""} (hold: ${holdDuration}ms).` +
      `\n${receiptLine(outcome.receipt, outcome.focusPath)}`;

    const expectation = expectationError(outcome.receipt, args.expect);
    const content: McpToolContent[] = [{ type: "text", text: statusText }];
    if (expectation) {
      content.push({ type: "text", text: expectation });
    }
    content.push(...outcome.content);

    return {
      content,
      isError: expectation ? true : undefined,
    };
  } catch (err: any) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to send key: ${describeFocusFailure(err)}`,
        },
      ],
      isError: true,
    };
  }
}

