import http from "node:http";
import { URL } from "node:url";

export interface DebugResult {
  id: string;
  ok: boolean;
  data: string;
  at: number;
}

interface QueuedCommand {
  id: string;
  command: string;
}

interface PendingCommand {
  id: string;
  resolve: (result: DebugResult) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_PORT = 8799;

let server: http.Server | null = null;
let queue: QueuedCommand[] = [];
const pending = new Map<string, PendingCommand>();
let lastPollAt = 0;
let lastResult: DebugResult | null = null;
let sequence = 0;

function port(): number {
  const value = Number(process.env.CIQ_DEBUG_PORT ?? DEFAULT_PORT);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PORT;
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function status() {
  return {
    running: server !== null,
    port: port(),
    url: `http://127.0.0.1:${port()}`,
    queued: queue.length,
    pending: pending.size,
    lastPollAt: lastPollAt || null,
    lastPollAgeMs: lastPollAt ? Date.now() - lastPollAt : null,
    lastResult,
  };
}

export function debugServerStatus() {
  return status();
}

export async function ensureDebugServer(): Promise<ReturnType<typeof status>> {
  if (server) {
    return status();
  }

  const listener = (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.method !== "GET") {
      sendText(res, 405, "method not allowed");
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port()}`);

    if (url.pathname === "/poll") {
      lastPollAt = Date.now();
      const next = queue.shift();
      sendText(res, 200, next ? next.command : "none");
      return;
    }

    if (url.pathname === "/result") {
      const id = url.searchParams.get("id") ?? "";
      const result: DebugResult = {
        id,
        ok: url.searchParams.get("ok") === "1",
        data: url.searchParams.get("data") ?? "",
        at: Date.now(),
      };
      lastResult = result;
      const waiting = pending.get(id);
      if (waiting) {
        clearTimeout(waiting.timer);
        pending.delete(id);
        waiting.resolve(result);
      }
      sendText(res, 200, "ok");
      return;
    }

    if (url.pathname === "/health") {
      sendJson(res, 200, status());
      return;
    }

    sendText(res, 404, "not found");
  };

  server = http.createServer(listener);
  const created = server;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      created.removeListener("listening", onListening);
      if (server === created) {
        server = null;
      }
      reject(error);
    };
    const onListening = () => {
      created.removeListener("error", onError);
      resolve();
    };
    created.once("error", onError);
    created.once("listening", onListening);
    created.listen(port(), "127.0.0.1");
  });

  return status();
}

export async function runDebugCommand(
  verb: string,
  args: string[] = [],
  timeoutMs = 10000
): Promise<DebugResult> {
  await ensureDebugServer();
  const id = `c${++sequence}`;
  const command = [id, verb, ...args].join(";");

  return new Promise<DebugResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        new Error(
          `Debug channel timed out after ${timeoutMs}ms. Check that the app is running with DEBUG_CHANNEL_ENABLED=true and that the simulator has "Use Device HTTPS Requirements" disabled.`
        )
      );
    }, timeoutMs);

    pending.set(id, { id, resolve, timer });
    queue.push({ id, command });
  });
}

export async function stopDebugServer(): Promise<void> {
  for (const [, waiting] of pending) {
    clearTimeout(waiting.timer);
  }
  pending.clear();
  queue = [];
  const current = server;
  server = null;
  if (current) {
    await new Promise<void>((resolve) => current.close(() => resolve()));
  }
}
