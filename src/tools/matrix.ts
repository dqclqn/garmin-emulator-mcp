import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { locateGarminSdk } from "../config/sdk-locator.js";
import { processManager } from "../simulator/process-manager.js";
import { getWindowInfo, captureRawWindowPng } from "../simulator/bridge.js";
import { captureScreen, diffPngBuffers } from "../simulator/receipts.js";
import { runDebugCommand } from "../debug/channel.js";
import { formatScreenshotResult, resolveActiveDeviceProfile, structuredResult, type McpToolContent } from "./shared.js";
import { applyDebugConfig } from "./build-config.js";
import { launchIsolatedSimulator } from "../simulator/isolated.js";
import { getActiveDeviceId } from "./shared.js";
import { handleHoldScreen, handlePressButton, handleSwipeScreen, handleTapScreen } from "./navigation.js";

type ToolResponse = { content: McpToolContent[]; isError?: boolean };

export interface MatrixStep {
  name?: string;
  action: "button" | "tap" | "swipe" | "hold" | "wait";
  button?: string;
  hold?: boolean;
  hold_ms?: number;
  x?: number;
  y?: number;
  direction?: "up" | "down" | "left" | "right";
  duration_ms?: number;
  expect?: "change" | "noop";
}

function text(value: unknown): ToolResponse {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string): ToolResponse {
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function handleMatrixRun(args: {
  project_dir: string;
  devices: string[];
  baseline_dir?: string;
  output_dir?: string;
  update_baselines?: boolean;
  wait_ms?: number;
  settle_ms?: number;
  threshold?: number;
  jungle_file?: string;
  developer_key_path?: string;
  debug_channel?: boolean;
  reset_before_each?: boolean;
  isolated?: boolean;
  steps?: MatrixStep[];
}): Promise<ToolResponse> {
  let restoreConfig: (() => Promise<void>) | undefined;
  try {
    if (!args.project_dir) {
      return failure("project_dir is required.");
    }
    if (!args.devices || args.devices.length === 0) {
      return failure("Pass at least one device id.");
    }
    if (args.steps && args.steps.length > 20) {
      return failure("A matrix scenario supports at most 20 steps.");
    }

    const sdk = locateGarminSdk();
    const projectDir = path.resolve(args.project_dir);
    const baselineDir = path.resolve(args.baseline_dir ?? path.join(projectDir, ".ciq", "baselines"));
    const outputDir = path.resolve(args.output_dir ?? path.join(projectDir, ".ciq", "current"));
    await fs.promises.mkdir(baselineDir, { recursive: true });
    await fs.promises.mkdir(outputDir, { recursive: true });
    restoreConfig = await applyDebugConfig(projectDir, args.debug_channel !== false);

    const infoBefore = await getWindowInfo();
    if (!infoBefore.running) {
      if (process.platform === "win32" && args.isolated !== false) {
        const profile = resolveActiveDeviceProfile(getActiveDeviceId());
        await launchIsolatedSimulator({
          simulatorPath: sdk.simulatorAppPath,
          expectedClientWidth: profile.bezelDimensions?.width,
          waitMs: 25000,
        });
      } else {
        const launch = await processManager.launchSimulatorApp(sdk, 20000);
        if (!launch.ready) {
          return failure("The simulator did not become ready.");
        }
      }
    }

    const report: Array<Record<string, unknown>> = [];
    let channelAvailable = false;
    try {
      const ping = await runDebugCommand("ping", [], 1500);
      channelAvailable = ping.ok;
    } catch {
      channelAvailable = false;
    }

    for (const deviceId of args.devices) {
      const entry: Record<string, unknown> = { deviceId };
      const startedBuild = Date.now();
      const prgPath = path.join(projectDir, "bin", `app-${deviceId}.prg`);

      if (args.reset_before_each !== false) {
        if (channelAvailable) {
          try {
            await runDebugCommand("reset", [], 2500);
            entry.stateReset = true;
          } catch {
            entry.stateReset = false;
          }
        } else {
          entry.stateReset = false;
        }
        await processManager.stopActiveApp();
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      try {
        const build = await processManager.buildMonkeyCProject(sdk, {
          projectDir,
          deviceId,
          jungleFile: args.jungle_file ? path.resolve(args.jungle_file) : undefined,
          developerKeyPath: args.developer_key_path ? path.resolve(args.developer_key_path) : undefined,
          outputPrgPath: prgPath,
        });
        entry.build = {
          success: build.success,
          exitCode: build.exitCode,
          ms: Date.now() - startedBuild,
          outputPrgPath: build.outputPrgPath,
          stderrTail: build.stderr ? build.stderr.split(/\r?\n/).slice(-3).join("\n") : "",
        };
        if (!build.success) {
          report.push(entry);
          continue;
        }
      } catch (error) {
        entry.build = { success: false, error: error instanceof Error ? error.message : String(error) };
        report.push(entry);
        continue;
      }

      const startedRun = Date.now();
      const run = await processManager.runAppInSimulator(sdk, {
        prgPath,
        deviceId,
        waitMs: args.wait_ms ?? 3000,
      });
      entry.run = {
        launched: run.launched,
        startupConfirmed: run.startupConfirmed ?? false,
        ms: Date.now() - startedRun,
        fatalError: run.fatalError,
      };
      if (!run.launched) {
        report.push(entry);
        continue;
      }

      await new Promise((resolve) => setTimeout(resolve, args.settle_ms ?? 1200));

      let snapshot = await captureScreen();
      for (let attempt = 0; attempt < 6; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const next = await captureScreen();
        if (next.hash === snapshot.hash) {
          snapshot = next;
          break;
        }
        snapshot = next;
      }
      const info = snapshot.windowInfo;
      if (!info.running || !info.windowId) {
        entry.capture = { error: "The simulator window disappeared after launch." };
        report.push(entry);
        continue;
      }

      const currentPath = path.join(outputDir, `${deviceId}.png`);
      const formatted = await formatScreenshotResult({
        rawWindowPng: snapshot.buffer,
        windowInfo: info,
        view: "screen",
        deviceId,
        savePath: currentPath,
      });

      entry.capture = {
        path: currentPath,
        width: formatted.screenshot.width,
        height: formatted.screenshot.height,
        display: resolveActiveDeviceProfile(deviceId).display,
      };

      const baselinePath = path.join(baselineDir, `${deviceId}.png`);
      const currentBuffer = await fs.promises.readFile(currentPath);
      if (args.update_baselines === true || !fs.existsSync(baselinePath)) {
        await fs.promises.writeFile(baselinePath, currentBuffer);
        entry.baseline = { path: baselinePath, status: "written" };
      } else {
        const baselineBuffer = await fs.promises.readFile(baselinePath);
        const diff = await diffPngBuffers(baselineBuffer, currentBuffer, args.threshold ?? 12);
        entry.baseline = {
          path: baselinePath,
          status: diff.changedPixels > 0 ? "differs" : "matches",
          changedPercent: diff.changedPct,
          changedPixels: diff.changedPixels,
          bounds: diff.bounds,
        };
      }

      if (args.steps && args.steps.length > 0) {
        const stepResults: Array<Record<string, unknown>> = [];
        for (let index = 0; index < args.steps.length; index++) {
          const step = args.steps[index];
          const name = step.name ?? `step-${String(index + 1).padStart(2, "0")}`;
          const slug = name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "") || `step-${index + 1}`;
          const stepEntry: Record<string, unknown> = { index, name, action: step.action };

          if (step.action === "wait") {
            await new Promise((resolve) => setTimeout(resolve, step.duration_ms ?? 500));
            stepEntry.ok = true;
          } else {
            let response: ToolResponse | undefined;
            try {
              if (step.action === "button") {
                if (!step.button) throw new Error("button steps need a button name");
                response = await handlePressButton({
                  button: step.button,
                  hold: step.hold,
                  hold_ms: step.hold_ms,
                  device_id: deviceId,
                  capture_after: false,
                  expect: step.expect ?? "change",
                  settle_ms: args.settle_ms ?? 700,
                });
              } else if (step.action === "tap") {
                if (step.x === undefined || step.y === undefined) throw new Error("tap steps need x and y");
                response = await handleTapScreen({
                  x: step.x,
                  y: step.y,
                  device_id: deviceId,
                  capture_after: false,
                  expect: step.expect,
                  settle_ms: args.settle_ms ?? 700,
                });
              } else if (step.action === "hold") {
                if (step.x === undefined || step.y === undefined) throw new Error("hold steps need x and y");
                response = await handleHoldScreen({
                  x: step.x,
                  y: step.y,
                  duration_ms: step.duration_ms,
                  device_id: deviceId,
                  capture_after: false,
                  expect: step.expect,
                  settle_ms: args.settle_ms ?? 700,
                });
              } else {
                if (!step.direction) throw new Error("swipe steps need a direction");
                response = await handleSwipeScreen({
                  direction: step.direction,
                  device_id: deviceId,
                  capture_after: false,
                  expect: step.expect,
                  settle_ms: args.settle_ms ?? 700,
                });
              }
            } catch (error) {
              stepEntry.ok = false;
              stepEntry.error = error instanceof Error ? error.message : String(error);
            }
            if (response) {
              stepEntry.ok = !response.isError;
              stepEntry.details = response.content
                .filter((item) => item.type === "text")
                .map((item) => (item as { text: string }).text)
                .join("\n")
                .slice(0, 800);
            }
          }

          if (stepEntry.ok !== false) {
            const stepSnapshot = await captureScreen();
            const stepPath = path.join(outputDir, `${deviceId}-${slug}.png`);
            const formattedStep = await formatScreenshotResult({
              rawWindowPng: stepSnapshot.buffer,
              windowInfo: stepSnapshot.windowInfo,
              view: "screen",
              deviceId,
              savePath: stepPath,
            });
            const stepBaselinePath = path.join(baselineDir, `${deviceId}-${slug}.png`);
            const stepBuffer = await fs.promises.readFile(stepPath);
            let stepBaseline: Record<string, unknown>;
            if (args.update_baselines === true || !fs.existsSync(stepBaselinePath)) {
              await fs.promises.writeFile(stepBaselinePath, stepBuffer);
              stepBaseline = { path: stepBaselinePath, status: "written" };
            } else {
              const diff = await diffPngBuffers(
                await fs.promises.readFile(stepBaselinePath),
                stepBuffer,
                args.threshold ?? 12
              );
              stepBaseline = {
                path: stepBaselinePath,
                status: diff.changedPixels > 0 ? "differs" : "matches",
                changedPercent: diff.changedPct,
                changedPixels: diff.changedPixels,
                bounds: diff.bounds,
              };
            }
            stepEntry.capture = {
              path: stepPath,
              width: formattedStep.screenshot.width,
              height: formattedStep.screenshot.height,
              baseline: stepBaseline,
            };
          }
          stepResults.push(stepEntry);
        }
        entry.steps = stepResults;
      }

      report.push(entry);
    }

    const failed = report.filter(
      (entry) =>
        (entry.build as any)?.success === false ||
        (entry.run as any)?.launched === false ||
        (Array.isArray(entry.steps) && (entry.steps as any[]).some((step) => step.ok === false))
    ).length;

    return text({
      projectDir,
      baselineDir,
      outputDir,
      devices: args.devices,
      ok: failed === 0,
      failed,
      report,
    });
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  } finally {
    if (restoreConfig) {
      await restoreConfig();
    }
  }
}

export async function handleMatrixDiff(args: {
  baseline_dir: string;
  output_dir?: string;
  threshold?: number;
}): Promise<ToolResponse> {
  try {
    const baselineDir = path.resolve(args.baseline_dir);
    const outputDir = path.resolve(args.output_dir ?? path.join(path.dirname(baselineDir), "current"));
    if (!fs.existsSync(baselineDir)) {
      return failure(`Baseline directory does not exist: ${baselineDir}`);
    }
    const files = (await fs.promises.readdir(baselineDir)).filter((file) => file.toLowerCase().endsWith(".png"));
    const results: Array<Record<string, unknown>> = [];

    for (const file of files) {
      const currentPath = path.join(outputDir, file);
      const baselinePath = path.join(baselineDir, file);
      if (!fs.existsSync(currentPath)) {
        results.push({ file, status: "missing-current" });
        continue;
      }
      const diff = await diffPngBuffers(
        await fs.promises.readFile(baselinePath),
        await fs.promises.readFile(currentPath),
        args.threshold ?? 12
      );
      results.push({
        file,
        status: diff.changedPixels > 0 ? "differs" : "matches",
        changedPercent: diff.changedPct,
        changedPixels: diff.changedPixels,
        bounds: diff.bounds,
      });
    }

    return text({
      baselineDir,
      outputDir,
      matched: results.filter((result) => result.status === "matches").length,
      differing: results.filter((result) => result.status === "differs").length,
      missing: results.filter((result) => result.status === "missing-current").length,
      results,
    });
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

export async function handleCalibrate(args?: {
  device_id?: string;
  save_path?: string;
  verify?: boolean;
  grid?: number;
}): Promise<ToolResponse> {
  try {
    const deviceId = getActiveDeviceId(args?.device_id);
    const info = await getWindowInfo();
    if (!info.running || !info.bounds) {
      return failure("The simulator is not running.");
    }
    const profile = resolveActiveDeviceProfile(deviceId);
    const scale = info.scale ?? 1;
    const bounds = info.bounds;
    const offset = info.contentOffset ?? { x: 0, y: 28 };
    const origin = {
      x: bounds.x + offset.x,
      y: bounds.y + offset.y,
    };

    const keys = profile.keys.map((key) => {
      const point = {
        x: origin.x + Math.round(key.center.x * scale),
        y: origin.y + Math.round(key.center.y * scale),
      };
      return {
        id: key.id,
        center: key.center,
        windowPoint: point,
        insideWindow:
          point.x >= bounds.x &&
          point.y >= bounds.y &&
          point.x < bounds.x + bounds.width &&
          point.y < bounds.y + bounds.height,
      };
    });

    const display = profile.display;
    const displayOrigin = display ? { x: display.location.x, y: display.location.y } : { x: 0, y: 0 };
    const result: Record<string, unknown> = {
      deviceId,
      windowId: info.windowId,
      bounds,
      clientSize: info.clientSize,
      contentOffset: offset,
      scale,
      bezel: profile.bezelDimensions,
      display: {
        width: display?.location.width ?? 0,
        height: display?.location.height ?? 0,
        origin: displayOrigin,
        windowBox: {
          x: origin.x + Math.round(displayOrigin.x * scale),
          y: origin.y + Math.round(displayOrigin.y * scale),
          width: Math.round((display?.location.width ?? 0) * scale),
          height: Math.round((display?.location.height ?? 0) * scale),
        },
      },
      keys,
      allKeysInside: keys.every((key) => key.insideWindow),
      note:
        "Geometry is computed from the window rect, content offset and profile. It validates coordinates, not rendered pixels; use a baseline screenshot for visual confirmation.",
    };

    if (args?.save_path) {
      const raw = await captureRawWindowPng(info.windowId!);
      const target = path.resolve(args.save_path);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, raw);
      const metadata = await sharp(raw).metadata();
      result.saved = { path: target, width: metadata.width, height: metadata.height };
    }

    if (args?.verify === true) {
      if (!profile.display.isTouch) {
        result.verification = {
          method: "tap-grid-visual",
          skipped: "The active device has no touch screen.",
        };
      } else {
        const grid = Math.max(2, Math.min(args.grid ?? 3, 5));
        const points: Array<Record<string, unknown>> = [];
        for (let row = 0; row < grid; row++) {
          for (let column = 0; column < grid; column++) {
            const x = (column + 0.5) / grid;
            const y = (row + 0.5) / grid;
            const before = await captureScreen();
            await handleTapScreen({
              x,
              y,
              normalized: true,
              device_id: deviceId,
              capture_after: false,
              settle_ms: 250,
            });
            await new Promise((resolve) => setTimeout(resolve, 250));
            const after = await captureScreen();
            const diff = await diffPngBuffers(before.buffer, after.buffer, 12);
            points.push({
              column,
              row,
              normalized: { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 },
              changedPct: diff.changedPct,
              changedPixels: diff.changedPixels,
              bounds: diff.bounds,
            });
          }
        }
        result.verification = {
          method: "tap-grid-visual",
          grid,
          points,
          changedPoints: points.filter((point) => (point.changedPixels as number) > 0).length,
          anyChange: points.some((point) => (point.changedPixels as number) > 0),
          note:
            "Each grid point is tapped through the same coordinate mapping as tap_screen. A changed screen proves the tap reached the app; a blank point proves only that the screen did not change.",
        };
      }
    }

    return text(result);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}
