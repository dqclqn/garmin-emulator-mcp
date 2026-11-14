import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Local state directory for the MCP server: session lock, logs and captures.
 * Windows uses LOCALAPPDATA; other platforms fall back to ~/.local/state.
 */
export function appDataDir(): string {
  if (process.env.CIQ_MCP_HOME) {
    return process.env.CIQ_MCP_HOME;
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ciq-mcp");
  }
  return path.join(os.homedir(), ".local", "state", "ciq-mcp");
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Stable id for this server process, used for log and capture folders. */
export const sessionId =
  process.env.CIQ_MCP_SESSION_ID ||
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;

export function logsDir(): string {
  return ensureDir(path.join(appDataDir(), "logs"));
}

export function capturesDir(): string {
  return ensureDir(path.join(appDataDir(), "captures", sessionId));
}

export function sessionLogPath(): string {
  return path.join(logsDir(), `${sessionId}.log`);
}

export function lockPath(): string {
  return path.join(appDataDir(), "session.lock");
}

export function sessionStatePath(): string {
  return path.join(appDataDir(), "session-state.json");
}

export interface PersistedSessionState {
  sessionId: string;
  updatedAt: string;
  running: boolean;
  simulatorPid?: number;
  desktop?: string;
  windowId?: number;
  adoptedFrom?: string;
}

export function readPersistedSession(): PersistedSessionState | undefined {
  try {
    const state = JSON.parse(fs.readFileSync(sessionStatePath(), "utf-8")) as PersistedSessionState;
    return state && typeof state === "object" ? state : undefined;
  } catch {
    return undefined;
  }
}

export function writePersistedSession(state: Omit<PersistedSessionState, "updatedAt">): void {
  ensureDir(appDataDir());
  const payload: PersistedSessionState = { ...state, updatedAt: new Date().toISOString() };
  fs.writeFileSync(sessionStatePath(), JSON.stringify(payload, null, 2));
}

export function clearPersistedSession(): void {
  try {
    fs.unlinkSync(sessionStatePath());
  } catch {
    // No persisted session.
  }
}

interface LockOwner {
  pid: number;
  sessionId: string;
  startedAt: string;
  cwd: string;
}

function processAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means the process exists but belongs to someone else.
    return error?.code === "EPERM";
  }
}

export interface LockResult {
  ok: boolean;
  owner?: LockOwner;
  path: string;
}

/**
 * Takes an exclusive lock so two MCP servers cannot drive one simulator.
 * A lock left by a dead process is reclaimed.
 */
export function acquireSessionLock(): LockResult {
  ensureDir(appDataDir());
  const file = lockPath();
  const owner: LockOwner = {
    pid: process.pid,
    sessionId,
    startedAt: new Date().toISOString(),
    cwd: process.cwd()
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(owner, null, 2), { flag: "wx" });
      return { ok: true, owner, path: file };
    } catch (error: any) {
      if (error?.code !== "EEXIST") {
        return { ok: false, path: file };
      }
      let existing: LockOwner | undefined;
      try {
        existing = JSON.parse(fs.readFileSync(file, "utf-8"));
      } catch {
        existing = undefined;
      }
      if (existing && existing.pid !== process.pid && processAlive(existing.pid)) {
        return { ok: false, owner: existing, path: file };
      }
      // Stale lock from a dead process; replace it.
      try {
        fs.unlinkSync(file);
      } catch {
        // Ignore and retry.
      }
    }
  }
  return { ok: false, path: file };
}

/** Releases the lock when this process owns it. */
export function releaseSessionLock(): void {
  const file = lockPath();
  try {
    const existing: LockOwner = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (existing.pid === process.pid) {
      fs.unlinkSync(file);
    }
  } catch {
    // No lock or unreadable; nothing to do.
  }
}
