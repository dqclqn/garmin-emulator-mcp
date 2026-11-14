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
import { processManager } from "../simulator/process-manager.js";
import { locateGarminSdk } from "../config/sdk-locator.js";
import { waitForDebugChannel } from "../debug/readiness.js";

type ToolResponse = { content: McpToolContent[]; isError?: boolean };

const RESET_MENU_IDS = {
  app: 6136,
  all_apps: 6137,
  simulator: 6138,
} as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function resetAppNames(args: { app_names?: string[]; prg_path?: string }): string[] {
  const explicit = args.app_names && args.app_names.length > 0 ? args.app_names : undefined;
  const fromPrg = args.prg_path
    ? [path.basename(args.prg_path, path.extname(args.prg_path))]
    : undefined;
  const names = explicit ?? fromPrg ?? [processManager.getLastRunPrgBasename() ?? "APP"];
  return names.map((name) => name.toUpperCase());
}

async function dialogStillOpen(hwnd: number): Promise<boolean> {
  try {
    const windows = await listSimulatorWindows();
    return (windows.windows ?? []).some(
      (window: any) => window.hwnd === hwnd && window.visible
    );
  } catch {
    return true;
  }
}

/**
 * Reset dialogs are wxWidgets windows whose buttons are not reliably exposed
 * to UI Automation. Try the keyboard default, then report exactly what
 * happened. Never claim a reset that was not confirmed.
 */
async function tryConfirmDialog(
  hwnd: number,
  desktop?: string
): Promise<{
  confirmed: boolean;
  method: string;
  error?: string;
}> {
  try {
    if (desktop) {
      await runBridgeCommand([
        "desktop-key",
        "--desktop",
        desktop,
        "--hwnd",
        String(hwnd),
        "--code",
        "13",
      ]);
    } else {
      await runBridgeCommand(["key", "--code", "13"]);
    }
    await sleep(900);
    const stillOpen = await dialogStillOpen(hwnd);
    return {
      confirmed: !stillOpen,
      method: "keyboard-enter",
      error: stillOpen ? "The dialog remained open after Enter; confirm it manually." : undefined,
    };
  } catch (error) {
    return {
      confirmed: false,
      method: "keyboard-enter",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function handleResetState(args: {
  scope?: keyof typeof RESET_MENU_IDS;
  confirm: boolean;
  snapshot?: boolean;
  snapshot_dir?: string;
  verify?: boolean;
  wait_ms?: number;
  stop_app?: boolean;
  app_names?: string[];
  prg_path?: string;
  device_id?: string;
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
      // Capture the original screen before stopping anything.
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

      const names = resetAppNames(args);
      if (args.snapshot !== false) {
        const lastRun = processManager.getLastRun();
        const prgPath = args.prg_path ?? lastRun?.prgPath;
        const deviceId = args.device_id ?? lastRun?.deviceId;
        if (!prgPath || !deviceId) {
          return {
            content: [
              {
                type: "text",
                text:
                  "Refusing to reset without a consistent snapshot: no last run PRG is recorded. " +
                  "Pass prg_path and device_id, or set snapshot: false to accept an inconsistent snapshot.",
              },
            ],
            isError: true,
          };
        }

        // Stop the app before copying DATA so onStop and periodic saves cannot
        // change files halfway through the snapshot.
        await runBridgeCommand(["menu-id", "--id", "6005", ...hwndArgs]);
        await sleep(800);
        evidence.appStoppedForSnapshot = true;

        const directory = path.resolve(
          args.snapshot_dir ?? path.join(capturesDir(), `reset-${stamp}`)
        );
        try {
          evidence.snapshot = await snapshotAppFiles(directory, names);
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Refusing to reset without a snapshot: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              },
            ],
            isError: true,
          };
        }

        // The channel lives in the app, so restart it for the clear command,
        // then stop it again immediately after the clear.
        const restartLogSeq = processManager.getLogSeq();
        const relaunch = await processManager.runAppInSimulator(locateGarminSdk(), {
          prgPath: path.resolve(prgPath),
          deviceId,
          waitMs: 3000,
        });
        if (!relaunch.launched) {
          return {
            content: [
              {
                type: "text",
                text: `Snapshot saved at ${directory}, but the app could not be restarted for the channel reset: ${
                  relaunch.fatalError ?? "launch failed"
                }`,
              },
            ],
            isError: true,
          };
        }
        const readiness = await waitForDebugChannel({
          hwndArgs,
          sinceSeq: restartLogSeq,
          timeoutMs: 15000,
        });
        if (!readiness.ready) {
          return {
            content: [
              {
                type: "text",
                text: `Snapshot saved at ${directory}, but the app did not poll the debug channel after restart: ${
                  readiness.lastError ?? "timeout"
                }. Reset was not attempted.`,
              },
            ],
            isError: true,
          };
        }
        evidence.appRestartedForReset = true;
        evidence.httpsToggled = readiness.httpsToggled;
      }

      const cleared = await runDebugCommand("reset", [], 8000);
      if (!cleared.ok) {
        return {
          content: [{ type: "text", text: `Debug-channel reset failed: ${cleared.data}` }],
          isError: true,
        };
      }
      await runBridgeCommand(["menu-id", "--id", "6005", ...hwndArgs]);
      await sleep(800);

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
      const names = resetAppNames(args);
      const directory = path.resolve(args.snapshot_dir ?? path.join(capturesDir(), `reset-${stamp}`));
      try {
        evidence.snapshot = await snapshotAppFiles(directory, names);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Refusing to reset without a snapshot: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          isError: true,
        };
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
    let dialogs = (windows.windows ?? []).filter(
      (window: any) =>
        window.visible &&
        window.hwnd !== info.windowId &&
        String(window.title ?? "").trim().length > 0 &&
        !String(window.title ?? "").startsWith("CIQ Simulator") &&
        !ignoredClasses.has(String(window.class ?? ""))
    );
    if (dialogs.length > 0) {
      const attempt = await tryConfirmDialog(dialogs[0].hwnd, info.desktop);
      evidence.confirmation = attempt;
      if (attempt.confirmed) {
        await sleep(600);
        const remaining = (await listSimulatorWindows()).windows ?? [];
        dialogs = remaining.filter(
          (window: any) =>
            window.visible &&
            window.hwnd !== info.windowId &&
            String(window.title ?? "").trim().length > 0 &&
            !String(window.title ?? "").startsWith("CIQ Simulator") &&
            !ignoredClasses.has(String(window.class ?? ""))
        );
      }
      if (dialogs.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ...evidence,
                  resetInvoked: true,
                  needsConfirmation: false,
                  confirmation: attempt,
                  note:
                    "The reset dialog was confirmed with the keyboard. Restart the app to observe the result.",
                },
                null,
                2
              ),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...evidence,
                resetInvoked: true,
                needsConfirmation: true,
                confirmation: attempt,
                dialogs: dialogs.map((window: any) => ({
                  hwnd: window.hwnd,
                  title: window.title,
                  class: window.class,
                })),
                next:
                  "The simulator opened a confirmation dialog and the keyboard fallback did not close it. Inspect it with inspect_ui { hwnd } and confirm with act_on_ui { hwnd, path, action: 'AXPress' }, or close_window to cancel.",
              },
              null,
              2
            ),
          },
        ],
      };
    }

    let verified: { state?: Record<string, string>; error?: string; skipped?: string } = {};
    if (args.verify !== false) {
      if (scope === "app" && channelAvailable) {
        try {
          const result = await runDebugCommand("state", [], 8000);
          verified = result.ok ? { state: parseState(result.data) } : { error: result.data };
        } catch (error) {
          verified = { error: error instanceof Error ? error.message : String(error) };
        }
      } else {
        verified = {
          skipped:
            "No debug channel is available for this reset scope, or the app was stopped before the reset.",
        };
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
