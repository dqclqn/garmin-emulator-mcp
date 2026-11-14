import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  captureRawWindowPng,
  closeSimulatorWindow,
  getWindowInfo,
  listSimulatorWindows,
} from "../simulator/bridge.js";
import type { McpToolContent } from "./shared.js";

type ToolResponse = { content: McpToolContent[]; isError?: boolean };

export async function handleListWindows(args?: { include_hidden?: boolean }): Promise<ToolResponse> {
  try {
    const info = await getWindowInfo();
    if (!info.running) {
      return {
        content: [{ type: "text", text: "The simulator is not running." }],
        isError: true,
      };
    }
    const result = await listSimulatorWindows();
    if (!result.ok) {
      return { content: [{ type: "text", text: result.error ?? "Unable to list windows." }], isError: true };
    }
    const ignoredClasses = new Set([
      "IME",
      "MSCTFIME UI",
      "Default IME",
      "CiceroUIWndFrame",
      "TF_FloatingLangBar_WndTitle",
      "Tooltip",
      "wxTimerHiddenWindow",
      "wxDisplayHiddenWindow",
    ]);
    const all = (result.windows ?? []).map((window: any) => ({
      hwnd: window.hwnd,
      title: window.title,
      class: window.class,
      visible: window.visible,
      rect: window.rect,
      isMain: window.hwnd === info.windowId,
    }));
    const windows = args?.include_hidden === true
      ? all
      : all.filter(
          (window: any) =>
            window.isMain ||
            (window.visible !== false &&
              !ignoredClasses.has(String(window.class ?? "")) &&
              String(window.title ?? "").trim().length > 0)
        );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              mainWindowId: info.windowId,
              windows,
              filtered: all.length - windows.length,
              includeHidden: args?.include_hidden === true,
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

export async function handleCaptureWindow(args: {
  hwnd: number;
  save_path?: string;
}): Promise<ToolResponse> {
  try {
    const buffer = await captureRawWindowPng(args.hwnd);
    const metadata = await sharp(buffer).metadata();
    const content: McpToolContent[] = [];

    if (args.save_path) {
      const target = path.resolve(args.save_path);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, buffer);
      content.push({ type: "text", text: `Saved ${target}` });
    }

    content.push({
      type: "image",
      data: buffer.toString("base64"),
      mimeType: "image/png",
    });
    content.push({
      type: "text",
      text: JSON.stringify(
        {
          hwnd: args.hwnd,
          width: metadata.width,
          height: metadata.height,
          savePath: args.save_path ? path.resolve(args.save_path) : undefined,
        },
        null,
        2
      ),
    });
    return { content };
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

export async function handleCloseWindow(args: { hwnd: number }): Promise<ToolResponse> {
  try {
    const info = await getWindowInfo();
    if (args.hwnd === info.windowId) {
      return {
        content: [{ type: "text", text: "Refusing to close the main simulator window; use terminate_simulator." }],
        isError: true,
      };
    }
    const result = await closeSimulatorWindow(args.hwnd);
    if (!result.ok) {
      return { content: [{ type: "text", text: result.error ?? "Unable to close window." }], isError: true };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { closed: true, hwnd: args.hwnd, stillVisible: result.visible === true },
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
