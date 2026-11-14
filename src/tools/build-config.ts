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
  enabled: boolean
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
  if (enabled) {
    await fs.promises.copyFile(templatePath, configPath);
  } else {
    await fs.promises.writeFile(configPath, await fs.promises.readFile(templatePath));
  }

  return async () => {
    try {
      await fs.promises.writeFile(configPath, original);
    } catch {
      // Restoring a build input must not mask the build result.
    }
  };
}
