import {
  buildReceipt,
  captureScreen,
  type ScreenReceipt,
  type ScreenSnapshot,
} from "../simulator/receipts.js";
import { acquireInputLease, releaseInputLease } from "./lease.js";
import { formatScreenshotResult, type McpToolContent } from "./shared.js";

export type ScreenExpectation = "change" | "noop";

export interface RunWithReceiptOptions<T> {
  action: () => Promise<T>;
  deviceId?: string;
  settleMs?: number;
  captureAfter?: boolean;
  saveCapture?: boolean;
  tag?: string;
  focus?: "lease" | "none";
}

export interface RunWithReceiptResult<T> {
  result: T;
  receipt?: ScreenReceipt;
  content: McpToolContent[];
  focusPath?: string;
  inputMode?: "focus" | "posted";
}

async function safeCapture(): Promise<ScreenSnapshot | undefined> {
  try {
    return await captureScreen();
  } catch {
    return undefined;
  }
}

/**
 * Runs one input batch under a single focus lease and returns a screen receipt.
 * The "after" capture is reused for the optional screenshot, so a verified press
 * costs two captures rather than three.
 */
export async function runWithReceipt<T>(
  options: RunWithReceiptOptions<T>
): Promise<RunWithReceiptResult<T>> {
  const lease = options.focus === "none" ? undefined : await acquireInputLease();
  const settleMs = options.settleMs ?? 400;
  try {
    const before = await safeCapture();
    const result = await options.action();
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    const after = await safeCapture();
    const receipt =
      before && after
        ? await buildReceipt(before, after, {
            settleMs,
            save: options.saveCapture,
            tag: options.tag
          })
        : undefined;

    const content: McpToolContent[] = [];
    if (options.captureAfter !== false && after) {
      try {
        const screenshot = await formatScreenshotResult({
          rawWindowPng: after.buffer,
          windowInfo: after.windowInfo,
          view: "screen",
          deviceId: options.deviceId
        });
        content.push(...screenshot.mcpContent);
      } catch {
        // A screenshot failure must not turn a successful press into an error.
      }
    }

    return {
      result,
      receipt,
      content,
      focusPath: lease ? lease.path : "isolated-desktop",
      inputMode: lease ? "focus" : "posted",
    };
  } finally {
    if (lease) {
      await releaseInputLease(lease);
    }
  }
}

/** Human readable receipt summary appended to tool text. */
export function receiptLine(receipt?: ScreenReceipt, focusPath?: string): string {
  if (!receipt) {
    return "Receipt: unavailable (screen capture failed).";
  }
  const change = receipt.changed
    ? `changed ${receipt.changedPct}% of the window (${receipt.changedPixels} px)`
    : "no visual change";
  const bounds = receipt.bounds
    ? `, changed region ${receipt.bounds.width}x${receipt.bounds.height} at (${receipt.bounds.x}, ${receipt.bounds.y})`
    : "";
  const focus = focusPath ? `, focus ${focusPath}` : "";
  const inputMode = focusPath === "isolated-desktop" ? "posted" : "focus";
  return `Receipt: ${change}${bounds}, hash ${receipt.hashAfter.slice(0, 12)}, settle ${receipt.settleMs}ms, input ${inputMode}${focus}.`;
}

/**
 * Returns an error message when the receipt contradicts the caller's expectation.
 */
export function expectationError(
  receipt: ScreenReceipt | undefined,
  expect?: ScreenExpectation
): string | undefined {
  if (!receipt || !expect) return undefined;
  if (expect === "change" && !receipt.changed) {
    return `E_NO_CHANGE: no visual change was detected after the action (hash ${receipt.hashBefore.slice(0, 12)}). The button may not have reached the app.`;
  }
  if (expect === "noop" && receipt.changed) {
    return `E_UNEXPECTED_CHANGE: the screen changed by ${receipt.changedPct}% but no change was expected.`;
  }
  return undefined;
}
