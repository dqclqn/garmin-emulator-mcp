import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { captureRawWindowPng, getWindowInfo, listSimulatorWindows } from "../simulator/bridge.js";
import { runBridgeCommand } from "../simulator/bridge.js";
import { capturesDir } from "../session/session.js";
import { snapshotAppFiles } from "./testing.js";
import { runDebugCommand } from "../debug/channel.js";
import { parseState } from "./debug.js";
import type { McpToolContent } from "./shared.js";

type ToolResponse = { content: McpToolContent[]; isError?: boolean };

const RESET_MENU_IDS = {
  app: 6136,
  all_apps: 6137,
  simulator: 6138,
} as const;

export async function handleResetState(args: {
  scope?: keyof typeof RESET_MENU_IDS;
  confirm: boolean;
  snapshot?: boolean;
  snapshot_dir?: string;
  verify?: boolean;
  wait_ms?: number;
  stop_app?: boolean;
}): Promise<ToolResponse> {
  if (args.confirm !== true) {
    return {
      content: [
        {
          type: "text",
          text: "Refusing to reset without confirm: true. This clears persisted app data.",
        },
      ],
      isError: true,
    };
  }

  const scope = args.scope ?? "app";
  const menuId = RESET_MENU_IDS[scope];
  if (!menuId) {
    return { content: [{ type: "text", text: `Unknown reset scope: ${scope}` }], isError: true };
  }

  try {
    const info = await getWindowInfo();
    if (!info.running || !info.windowId) {
      return { content: [{ type: "text", text: "The simulator is not running." }], isError: true };
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const evidence: Record<string, unknown> = { scope, menuId };
    const hwndArgs = info.isolated && info.windowId ? ["--hwnd", String(info.windowId)] : [];

    let channelAvailable = false;
    if (scope === "app") {
      try {
        const ping = await runDebugCommand("ping", [], 1500);
        channelAvailable = ping.ok;
      } catch {
        channelAvailable = false;
      }
    }

    if (scope === "app" && channelAvailable) {
      // The debug channel can clear the object store while the app is running.
      // Kill the app immediately afterwards so a cached or onStop save cannot
      // write the old values back.
      if (args.snapshot !== false) {
        const directory = path.resolve(args.snapshot_dir ?? path.join(capturesDir(), `reset-${stamp}`));
        try {
          evidence.snapshot = await snapshotAppFiles(directory, ["APP"]);
        } catch (error) {
          evidence.snapshotError = error instanceof Error ? error.message : String(error);
        }
      }

      try {
        const png = await captureRawWindowPng(info.windowId);
        const target = path.join(capturesDir(), `before-reset-${stamp}.png`);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, png);
        const metadata = await sharp(png).metadata();
        evidence.beforeScreenshot = { path: target, width: metadata.width, height: metadata.height };
      } catch (error) {
        evidence.beforeScreenshotError = error instanceof Error ? error.message : String(error);
      }

      const cleared = await runDebugCommand("reset", [], 8000);
      if (!cleared.ok) {
        return {
          content: [{ type: "text", text: `Debug-channel reset failed: ${cleared.data}` }],
          isError: true,
        };
      }
      await runBridgeCommand(["menu-id", "--id", "6005", ...hwndArgs]);
      await new Promise((resolve) => setTimeout(resolve, 800));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...evidence,
                resetInvoked: true,
                resetVia: "debug-channel",
                appStopped: true,
                needsConfirmation: false,
                verified: {
                  note: "The app was stopped after clearing storage. Run it with run_app, then call state_read to confirm.",
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (args.stop_app !== false) {
      // Stop the app first so its periodic or onStop save cannot rewrite the
      // storage we are about to clear, and so the APPS snapshot is consistent.
      await runBridgeCommand(["menu-id", "--id", "6005", ...hwndArgs]);
      await new Promise((resolve) => setTimeout(resolve, 800));
      evidence.appStopped = true;
    }

    if (args.snapshot !== false && scope === "app") {
      const directory = path.resolve(args.snapshot_dir ?? path.join(capturesDir(), `reset-${stamp}`));
      try {
        const snapshot = await snapshotAppFiles(directory, ["APP"]);
        evidence.snapshot = snapshot;
      } catch (error) {
        evidence.snapshotError = error instanceof Error ? error.message : String(error);
      }
    }

    try {
      const png = await captureRawWindowPng(info.windowId);
      const target = path.join(capturesDir(), `before-reset-${stamp}.png`);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, png);
      const metadata = await sharp(png).metadata();
      evidence.beforeScreenshot = { path: target, width: metadata.width, height: metadata.height };
    } catch (error) {
      evidence.beforeScreenshotError = error instanceof Error ? error.message : String(error);
    }

    const invoked = await runBridgeCommand([
      "menu-id",
      "--id",
      String(menuId),
      ...hwndArgs,
    ]);
    if (!invoked.ok) {
      return {
        content: [
          { type: "text", text: `Reset menu command failed: ${invoked.error ?? "unknown error"}` },
        ],
        isError: true,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, args.wait_ms ?? 1200));

    const windows = await listSimulatorWindows();
    const ignoredClasses = new Set([
      "UAC_InputIndicatorOverlayWnd",
      "UAC Input Indicator",
      "MSCTFIME UI",
      "IME",
      "wxTimerHiddenWindow",
      "wxDisplayHiddenWindow",
    ]);
    const dialogs = (windows.windows ?? []).filter(
      (window: any) =>
        window.visible &&
        window.hwnd !== info.windowId &&
        String(window.title ?? "").trim().length > 0 &&
        !String(window.title ?? "").startsWith("CIQ Simulator") &&
        !ignoredClasses.has(String(window.class ?? ""))
    );
    if (dialogs.length > 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...evidence,
                resetInvoked: true,
                needsConfirmation: true,
                dialogs: dialogs.map((window: any) => ({
                  hwnd: window.hwnd,
                  title: window.title,
                  class: window.class,
                })),
                next:
                  "The simulator opened a confirmation dialog. Inspect it with inspect_ui { hwnd } and confirm with act_on_ui { hwnd, path, action: 'AXPress' }, or close_window to cancel.",
              },
              null,
              2
            ),
          },
        ],
      };
    }

    let verified: { state?: Record<string, string>; error?: string } = {};
    if (args.verify !== false) {
      try {
        const result = await runDebugCommand("state", [], 8000);
        verified = result.ok ? { state: parseState(result.data) } : { error: result.data };
      } catch (error) {
        verified = { error: error instanceof Error ? error.message : String(error) };
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ...evidence,
              resetInvoked: true,
              needsConfirmation: false,
              verified,
              note:
                "Storage was cleared while the app may still be running. Restart the app with run_app to observe a clean first launch.",
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
