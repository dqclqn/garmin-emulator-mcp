import fs from "node:fs";
import path from "node:path";

/**
 * Swaps the app's DebugConfig.mc for the debug or release template before a
 * build, and returns a restore function for the original bytes.
 *
 * The templates use a .mct extension so the Monkey C compiler does not pick
 * them up as extra source files.
 */
export async function applyDebugConfig(
  projectDir: string,
  enabled: boolean,
  options?: { port?: number; token?: string }
): Promise<() => Promise<void>> {
  const configPath = path.join(projectDir, "source", "debug", "DebugConfig.mc");
  const templatePath = path.join(
    projectDir,
    "debug-configs",
    enabled ? "DebugConfig.debug.mct" : "DebugConfig.release.mct"
  );

  if (!fs.existsSync(configPath) || !fs.existsSync(templatePath)) {
    return async () => undefined;
  }

  const original = await fs.promises.readFile(configPath);
  const port = options?.port ?? Number(process.env.CIQ_DEBUG_PORT ?? 8799);
  const token = options?.token ?? process.env.CIQ_DEBUG_TOKEN ?? "ciq-local-token";
  const template = (await fs.promises.readFile(templatePath, "utf-8"))
    .replace(/__CIQ_DEBUG_PORT__/g, String(Number.isFinite(port) && port > 0 ? port : 8799))
    .replace(/__CIQ_DEBUG_TOKEN__/g, token.replace(/["\\]/g, ""));
  await fs.promises.writeFile(configPath, template, "utf-8");

  return async () => {
    try {
      await fs.promises.writeFile(configPath, original);
    } catch {
      // Restoring a build input must not mask the build result.
    }
  };
}
