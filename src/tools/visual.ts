import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { processManager } from "../simulator/process-manager.js";
import { runBridgeCommand } from "../simulator/bridge.js";
import { capturesDir } from "../session/session.js";
import {
  captureAndFormatScreenshot,
  type McpToolContent,
} from "./shared.js";
import type { ScreenshotViewMode } from "../types.js";

/**
 * Tool handler: get_screenshot
 */
export async function handleGetScreenshot(args?: {
  view?: ScreenshotViewMode;
  device_id?: string;
  save_path?: string;
  format?: "png" | "webp";
  hash_only?: boolean;
  region?: { x: number; y: number; width: number; height: number };
  mask?: "round" | "none";
  inline_ocr?: boolean;
  expect_text?: string;
}): Promise<{
  content: McpToolContent[];
  isError?: boolean;
}> {
  try {
    const result = await captureAndFormatScreenshot({
      view: args?.view ?? "screen",
      deviceId: args?.device_id,
      savePath: args?.save_path,
      format: args?.format,
      hashOnly: args?.hash_only,
      region: args?.region,
      mask: args?.mask,
    });

    const content = [...result.mcpContent];
    if (args?.inline_ocr || args?.expect_text) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const ocrPath = path.join(capturesDir(), `ocr-${stamp}.png`);
      const imageBuffer = Buffer.from(result.screenshot.base64Png, "base64");
      const pngBuffer = result.screenshot.format === "webp"
        ? await sharp(imageBuffer).png().toBuffer()
        : imageBuffer;
      fs.writeFileSync(ocrPath, pngBuffer);
      const ocr = await runBridgeCommand(["ocr", ocrPath]);
      const text = collectText(ocr);
      const expected = args.expect_text;
      const match = expected ? text.toLowerCase().includes(expected.toLowerCase()) : undefined;
      content.push({
        type: "text",
        text: JSON.stringify(
          {
            ocr: { path: ocrPath, text, expectText: expected, match },
            code: expected && !match ? "E_TEXT_NOT_FOUND" : undefined,
          },
          null,
          2
        ),
      });
      if (expected && !match) {
        return { content, isError: true };
      }
    }
    return { content };
  } catch (err: any) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to capture screenshot: ${err?.message || err}`,
        },
      ],
      isError: true,
    };
  }
}

function collectText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join(" ");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["text", "string", "value", "label"]) {
      if (key in record) {
        const found = collectText(record[key]);
        if (found) return found;
      }
    }
    return Object.values(record).map(collectText).filter(Boolean).join(" ");
  }
  return "";
}

/**
 * Tool handler: get_app_logs
 */
export async function handleGetAppLogs(args?: {
  lines?: number;
  clear?: boolean;
  since_seq?: number;
}): Promise<{
  content: McpToolContent[];
  isError?: boolean;
}> {
  try {
    const entries = processManager.getLogEntries({
      lines: args?.lines,
      clear: args?.clear,
      sinceSeq: args?.since_seq,
    });
    const logs = entries.map((entry) => entry.text);

    const body =
      logs.length === 0
        ? "No simulator or app logs recorded."
        : logs.join("\n");

    const nextSeq = processManager.getLogSeq();
    const logFile = processManager.getLogFilePath();

    return {
      content: [
        {
          type: "text",
          text:
            `Simulator & App Logs (${logs.length} line${logs.length === 1 ? "" : "s"}; ` +
            `next_seq=${nextSeq})\nlog file: ${logFile}\n\n${body}`,
        },
      ],
    };
  } catch (err: any) {
    return {
      content: [
        {
          type: "text",
          text: `Failed to retrieve logs: ${err?.message || err}`,
        },
      ],
      isError: true,
    };
  }
}
