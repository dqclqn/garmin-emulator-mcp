import { processManager } from "../simulator/process-manager.js";
import { runBridgeCommand } from "../simulator/bridge.js";
import { runDebugCommand } from "./channel.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for the app to poll the debug channel after a restart. Stopping and
 * restarting an app resets the simulator's "Use Device HTTPS Requirements"
 * setting, so a -1001 poll is repaired by toggling menu 6045 exactly once.
 */
export async function waitForDebugChannel(options: {
  hwndArgs?: string[];
  sinceSeq: number;
  timeoutMs?: number;
}): Promise<{ ready: boolean; httpsToggled: boolean; lastError?: string }> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const deadline = Date.now() + timeoutMs;
  let httpsToggled = false;
  let lastError: string | undefined;

  while (Date.now() < deadline) {
    try {
      const ping = await runDebugCommand("ping", [], 1200);
      if (ping.ok) {
        return { ready: true, httpsToggled };
      }
      lastError = ping.data;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (!httpsToggled) {
      const entries = processManager.getLogEntries({ sinceSeq: options.sinceSeq });
      if (entries.some((entry) => /DEBUG poll code=-1001/.test(entry.text))) {
        try {
          await runBridgeCommand([
            "menu-id",
            "--id",
            "6045",
            ...(options.hwndArgs ?? []),
          ]);
          httpsToggled = true;
          await sleep(1200);
          continue;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
    }

    await sleep(350);
  }

  return { ready: false, httpsToggled, lastError };
}
