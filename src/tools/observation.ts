import fs from "node:fs";
import { captureScreen, diffPngBuffers, waitForStable } from "../simulator/receipts.js";
import type { McpToolContent } from "./shared.js";

/**
 * Waits until the simulator screen stops changing, so screenshots and assertions
 * are not taken mid-animation.
 */
export async function handleWaitForStable(args?: {
  timeout_ms?: number;
  interval_ms?: number;
  settle_ms?: number;
}): Promise<{
  content: McpToolContent[];
  isError?: boolean;
}> {
  try {
    const result = await waitForStable({
      timeoutMs: args?.timeout_ms,
      intervalMs: args?.interval_ms,
      settleMs: args?.settle_ms,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
      isError: result.stable ? undefined : true,
    };
  } catch (err: any) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to wait for a stable screen: ${err?.message || err}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Compares two screenshots, or one screenshot against the current screen.
 */
export async function handleDiff(args: {
  before_path: string;
  after_path?: string;
  threshold?: number;
}): Promise<{
  content: McpToolContent[];
  isError?: boolean;
}> {
  try {
    if (!fs.existsSync(args.before_path)) {
      throw new Error(`Baseline image not found: ${args.before_path}`);
    }
    const before = fs.readFileSync(args.before_path);
    let after: Buffer;
    let afterSource: string;
    if (args.after_path) {
      if (!fs.existsSync(args.after_path)) {
        throw new Error(`Comparison image not found: ${args.after_path}`);
      }
      after = fs.readFileSync(args.after_path);
      afterSource = args.after_path;
    } else {
      const snapshot = await captureScreen();
      after = snapshot.buffer;
      afterSource = "live screen";
    }

    const diff = await diffPngBuffers(before, after, args.threshold ?? 12);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              before: args.before_path,
              after: afterSource,
              changed: diff.changedPixels > 0,
              changedPct: Number(diff.changedPct.toFixed(2)),
              changedPixels: diff.changedPixels,
              totalPixels: diff.totalPixels,
              bounds: diff.bounds,
              threshold: args.threshold ?? 12,
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
          text: `Failed to compare images: ${err?.message || err}`,
        },
      ],
      isError: true,
    };
  }
}
