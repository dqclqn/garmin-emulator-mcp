import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Copies native helper scripts into dist/native so a packaged install does not
 * depend on the source tree being present next to dist.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "src", "native");
const targetDir = path.join(root, "dist", "native");

fs.mkdirSync(targetDir, { recursive: true });
for (const file of ["windows-bridge.ps1", "macos-bridge.swift"]) {
  const source = path.join(sourceDir, file);
  if (!fs.existsSync(source)) continue;
  fs.copyFileSync(source, path.join(targetDir, file));
}
console.log(`Copied native helpers to ${path.relative(root, targetDir)}`);
