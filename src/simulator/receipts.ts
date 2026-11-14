import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { captureRawWindowPng, getWindowInfo } from "./bridge.js";
import { capturesDir } from "../session/session.js";
import type { Rect, WindowInfoResponse } from "../types.js";

export interface ScreenSnapshot {
  buffer: Buffer;
  hash: string;
  width: number;
  height: number;
  windowInfo: WindowInfoResponse;
}

export interface ScreenReceipt {
  changed: boolean;
  changedPct: number;
  changedPixels: number;
  totalPixels: number;
  bounds: Rect | null;
  hashBefore: string;
  hashAfter: string;
  settleMs: number;
  screenshotPath?: string;
  warning?: string;
}

export function hashBuffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Captures the simulator window as a raw PNG and hashes it.
 */
export async function captureScreen(): Promise<ScreenSnapshot> {
  const windowInfo = await getWindowInfo();
  if (!windowInfo.running || !windowInfo.windowId) {
    throw new Error("Connect IQ simulator window is not running or not visible.");
  }
  const buffer = await captureRawWindowPng(windowInfo.windowId, windowInfo.scale);
  const metadata = await sharp(buffer).metadata();
  return {
    buffer,
    hash: hashBuffer(buffer),
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    windowInfo
  };
}

/**
 * Saves a snapshot under the session capture directory.
 */
export function saveSnapshot(snapshot: ScreenSnapshot, tag: string): string {
  const dir = capturesDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}-${tag}.png`);
  fs.writeFileSync(file, snapshot.buffer);
  return file;
}

export interface DiffResult {
  changedPct: number;
  changedPixels: number;
  totalPixels: number;
  bounds: Rect | null;
}

/**
 * Compares two PNG buffers pixel by pixel. Identical images return 0 percent.
 * A per-pixel channel delta above `threshold` counts as changed.
 */
export async function diffPngBuffers(
  before: Buffer,
  after: Buffer,
  threshold = 12
): Promise<DiffResult> {
  const a = await sharp(before).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(after).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = Math.min(a.info.width, b.info.width);
  const height = Math.min(a.info.height, b.info.height);
  const channelsA = a.info.channels;
  const channelsB = b.info.channels;
  let changedPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ia = (y * a.info.width + x) * channelsA;
      const ib = (y * b.info.width + x) * channelsB;
      const delta =
        Math.abs(a.data[ia] - b.data[ib]) +
        Math.abs(a.data[ia + 1] - b.data[ib + 1]) +
        Math.abs(a.data[ia + 2] - b.data[ib + 2]);
      if (delta > threshold) {
        changedPixels++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  const totalPixels = width * height;
  return {
    changedPixels,
    totalPixels,
    changedPct: totalPixels === 0 ? 0 : (100 * changedPixels) / totalPixels,
    bounds:
      maxX >= 0
        ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
        : null
  };
}

/**
 * Builds the receipt for one input action.
 */
export async function buildReceipt(
  before: ScreenSnapshot,
  after: ScreenSnapshot,
  options?: { settleMs?: number; save?: boolean; tag?: string }
): Promise<ScreenReceipt> {
  const diff = await diffPngBuffers(before.buffer, after.buffer);
  const receipt: ScreenReceipt = {
    changed: before.hash !== after.hash,
    changedPct: Number(diff.changedPct.toFixed(2)),
    changedPixels: diff.changedPixels,
    totalPixels: diff.totalPixels,
    bounds: diff.bounds,
    hashBefore: before.hash,
    hashAfter: after.hash,
    settleMs: options?.settleMs ?? 0
  };
  if (options?.save) {
    receipt.screenshotPath = saveSnapshot(after, options.tag ?? "after");
  }
  return receipt;
}

export interface StableResult {
  stable: boolean;
  frames: number;
  hash: string;
  ms: number;
  changedBetweenFrames: boolean;
}

/**
 * Waits until two consecutive captures hash identically, which is what makes
 * screenshot assertions safe while an animation is running.
 */
export async function waitForStable(options?: {
  timeoutMs?: number;
  intervalMs?: number;
  settleMs?: number;
}): Promise<StableResult> {
  const timeoutMs = options?.timeoutMs ?? 3000;
  const intervalMs = options?.intervalMs ?? 150;
  const started = Date.now();
  if (options?.settleMs) {
    await new Promise((resolve) => setTimeout(resolve, options.settleMs));
  }
  let previous = await captureScreen();
  let frames = 1;
  let changedBetweenFrames = false;
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const next = await captureScreen();
    frames++;
    if (next.hash === previous.hash) {
      return {
        stable: true,
        frames,
        hash: next.hash,
        ms: Date.now() - started,
        changedBetweenFrames
      };
    }
    changedBetweenFrames = true;
    previous = next;
  }
  return {
    stable: false,
    frames,
    hash: previous.hash,
    ms: Date.now() - started,
    changedBetweenFrames
  };
}
