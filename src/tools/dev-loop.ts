import { handleBuildApp, handleRunApp } from "./lifecycle.js";
import { handleGetAppLogs } from "./visual.js";
import type { McpToolContent } from "./shared.js";

function textBlocks(content: McpToolContent[]): string {
  return content
    .filter((item) => item.type === "text")
    .map((item) => (item as { text: string }).text)
    .join("\n");
}

function firstText(content: McpToolContent[]): string {
  const item = content.find((entry) => entry.type === "text");
  return item && item.type === "text" ? item.text : "";
}

export async function handleDevLoop(args: {
  project_dir: string;
  device_id?: string;
  debug_channel?: boolean;
  wait_ms?: number;
  settle_ms?: number;
  log_lines?: number;
  jungle_file?: string;
  developer_key_path?: string;
}): Promise<{ content: McpToolContent[]; structuredContent?: Record<string, unknown>; isError?: boolean }> {
  const build = await handleBuildApp({
    project_dir: args.project_dir,
    device_id: args.device_id,
    debug_channel: args.debug_channel,
    jungle_file: args.jungle_file,
    developer_key_path: args.developer_key_path,
  });
  if (build.isError) {
    return {
      content: build.content,
      isError: true,
    };
  }

  let buildJson: Record<string, any> = {};
  try {
    buildJson = JSON.parse(firstText(build.content));
  } catch {
    buildJson = {};
  }
  const prgPath = buildJson.outputPrgPath as string | undefined;
  if (!prgPath) {
    return {
      content: [
        ...build.content,
        { type: "text", text: "Build succeeded but did not report outputPrgPath." },
      ],
      isError: true,
    };
  }

  const run = await handleRunApp({
    prg_path: prgPath,
    device_id: args.device_id,
    wait_ms: args.wait_ms,
    capture_after: true,
  });
  const logs = await handleGetAppLogs({ lines: args.log_lines ?? 40 });
  const summary = {
    build: buildJson,
    run: (() => {
      try {
        return JSON.parse(firstText(run.content));
      } catch {
        return { raw: textBlocks(run.content) };
      }
    })(),
    logs: textBlocks(logs.content),
  };
  return {
    content: [
      { type: "text", text: JSON.stringify(summary, null, 2) },
      ...run.content.filter((item) => item.type === "image"),
    ],
    structuredContent: summary,
    isError: run.isError || logs.isError,
  };
}
