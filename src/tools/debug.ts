import {
  debugServerStatus,
  ensureDebugServer,
  runDebugCommand,
  type DebugResult,
} from "../debug/channel.js";
import type { McpToolContent } from "./shared.js";

function text(text: string): { content: McpToolContent[]; isError?: boolean } {
  return { content: [{ type: "text", text }] };
}

function failure(message: string): { content: McpToolContent[]; isError?: boolean } {
  return { content: [{ type: "text", text: message }], isError: true };
}

function describeResult(result: DebugResult): string {
  return JSON.stringify(
    {
      id: result.id,
      ok: result.ok,
      data: result.data,
      at: new Date(result.at).toISOString(),
    },
    null,
    2
  );
}

export function parseState(raw: string): Record<string, string> {
  const state: Record<string, string> = {};
  for (const part of raw.split("|")) {
    const split = part.indexOf("=");
    if (split > 0) {
      state[part.slice(0, split)] = part.slice(split + 1);
    }
  }
  return state;
}

type SeedScalar = string | number | boolean | null;
type SeedValue = SeedScalar | SeedScalar[] | Record<string, SeedScalar>;

const PROPERTY_KEYS = new Set([
  "daily_goal",
  "reveal_behavior",
  "auto_advance",
  "card_order",
  "premium_enabled",
  "deck_data",
  "deck_2",
  "deck_3",
  "deck_4",
]);

interface SeedPlan {
  verb: string;
  args: string[];
  checks: Array<{ field: string; expected: string | null }>;
}

function scalarText(value: SeedScalar): string | null {
  if (value === null || value === "__delete__") {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === "string") {
    return value.length > 80 ? `str:${value.length}` : value;
  }
  return null;
}

function safeToken(value: string): boolean {
  return !/[;,|=]/.test(value);
}

function planSeed(key: string, value: SeedValue): SeedPlan | string {
  if (value === null || value === "__delete__") {
    return { verb: "seed", args: [key, "delete", ""], checks: [{ field: key, expected: "null" }] };
  }
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    const text = scalarText(value);
    if (text === null) {
      return `Unsupported scalar for ${key}.`;
    }
    if (typeof value === "string" && value.includes(";")) {
      return `Strings cannot contain semicolons: ${key}.`;
    }
    const type = typeof value === "boolean" ? "bool" : typeof value === "number" ? "int" : "str";
    return { verb: "seed", args: [key, type, text], checks: [{ field: key, expected: text }] };
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item));
    if (items.some((item) => !safeToken(item))) {
      return `Array values for ${key} cannot contain commas, semicolons, pipes or equals signs.`;
    }
    if (key === "deck_list") {
      return {
        verb: "deck_list",
        args: [items.join(",")],
        checks: [
          { field: key, expected: `array:${items.length}` },
          { field: "deck_ids", expected: items.join(",") },
        ],
      };
    }
    return {
      verb: "list",
      args: [key, items.join(",")],
      checks: [{ field: key, expected: `array:${items.length}` }],
    };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (key === "premium") {
      const active = value.active;
      const code = value.code ?? "";
      if (typeof active !== "boolean" || typeof code !== "string" || !safeToken(code)) {
        return "premium expects { active: boolean, code: string } with a code free of commas, semicolons, pipes and equals signs.";
      }
      return {
        verb: "premium",
        args: [active ? "true" : "false", code],
        checks: [
          { field: key, expected: "dict:2" },
          { field: "premium_active", expected: active ? "true" : "false" },
        ],
      };
    }
    const pairs: string[] = [];
    for (const [entryKey, entryValue] of entries) {
      if (!safeToken(entryKey) || typeof entryValue === "object") {
        return `Map values for ${key} must be scalar and keys cannot contain separators.`;
      }
      const text = scalarText(entryValue);
      if (text === null || !safeToken(text)) {
        return `Unsupported map value for ${key}.${entryKey}.`;
      }
      pairs.push(`${entryKey}=${text}`);
    }
    return {
      verb: "map",
      args: [key, pairs.join("|")],
      checks: [{ field: key, expected: `dict:${entries.length}` }],
    };
  }
  return `Unsupported value for ${key}.`;
}

export async function handleDebugStatus(): Promise<{
  content: McpToolContent[];
  isError?: boolean;
}> {
  try {
    // Starting the server is intentional: a status call should tell the agent
    // whether the host endpoint is live and whether the app has polled it.
    const status = await ensureDebugServer();
    return text(
      JSON.stringify(
        {
          ...status,
          hint:
            status.lastPollAt === null
              ? "No app has polled yet. Run the app with DEBUG_CHANNEL_ENABLED=true and disable Simulation > Use Device HTTPS Requirements."
              : undefined,
        },
        null,
        2
      )
    );
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

export async function handleDebugPing(args?: {
  timeout_ms?: number;
}): Promise<{ content: McpToolContent[]; isError?: boolean }> {
  try {
    const result = await runDebugCommand("ping", [], args?.timeout_ms ?? 10000);
    if (!result.ok) {
      return failure(`The app rejected ping: ${result.data}`);
    }
    return text(describeResult(result));
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

export async function handleStateRead(args?: {
  keys?: string[];
  timeout_ms?: number;
}): Promise<{ content: McpToolContent[]; isError?: boolean }> {
  try {
    const requested = (args?.keys ?? []).filter((key) => key.trim().length > 0);
    const result = await runDebugCommand(
      "state",
      requested.length > 0 ? [requested.join(",")] : [],
      args?.timeout_ms ?? 10000
    );
    if (!result.ok) {
      return failure(`The app could not read state: ${result.data}`);
    }
    const state = parseState(result.data);
    const wanted = new Set(requested);
    if (wanted.has("premium")) {
      wanted.add("premium_active");
    }
    if (wanted.has("deck_list")) {
      wanted.add("deck_ids");
    }
    const filtered = requested.length > 0
      ? Object.fromEntries(
          Object.entries(state).filter(([key]) => {
            if (wanted.has(key)) {
              return true;
            }
            return key.startsWith("prop:") && wanted.has(key.slice(5));
          })
        )
      : state;
    return text(
      JSON.stringify(
        {
          state: filtered,
          raw: result.data,
          note:
            "Values are scalar summaries. Arrays and dictionaries report their size, and strings over 80 characters report their length.",
        },
        null,
        2
      )
    );
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

export async function handleStateSeed(args: {
  values: Record<string, SeedValue>;
  verify?: boolean;
  timeout_ms?: number;
}): Promise<{ content: McpToolContent[]; isError?: boolean }> {
  try {
    const entries = Object.entries(args.values ?? {});
    if (entries.length === 0) {
      return failure("Pass at least one value to seed.");
    }

    const plans: Array<{ key: string; plan: SeedPlan }> = [];
    const seeded: string[] = [];
    for (const [key, value] of entries) {
      if (key.startsWith("prop:") || PROPERTY_KEYS.has(key)) {
        return failure(
          `${key} is an app property, not storage, and cannot be written at runtime. ` +
            `Change resources/properties.xml and rebuild, or seed a storage key instead.`
        );
      }
      const plan = planSeed(key, value);
      if (typeof plan === "string") {
        return failure(plan);
      }
      const result = await runDebugCommand(
        plan.verb,
        plan.args,
        args.timeout_ms ?? 10000
      );
      if (!result.ok) {
        return failure(`Seeding ${key} failed: ${result.data}`);
      }
      plans.push({ key, plan });
      seeded.push(key);
    }

    const verification: Record<
      string,
      {
        match: boolean;
        checks: Array<{ field: string; expected: string | null; actual: string | null; match: boolean }>;
      }
    > = {};
    if (args.verify !== false) {
      const read = await runDebugCommand(
        "state",
        [plans.map((entry) => entry.key).join(",")],
        args.timeout_ms ?? 10000
      );
      const state = read.ok ? parseState(read.data) : {};
      for (const { key, plan } of plans) {
        const checks = plan.checks.map((check) => {
          const actual = state[check.field] ?? null;
          return {
            field: check.field,
            expected: check.expected,
            actual,
            match: check.expected !== null && actual === check.expected,
          };
        });
        verification[key] = {
          match: checks.every((check) => check.match),
          checks,
        };
      }
    }

    return text(
      JSON.stringify(
        {
          seeded,
          verification: args.verify === false ? undefined : verification,
        },
        null,
        2
      )
    );
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

export async function handleStateReset(args?: {
  verify?: boolean;
  timeout_ms?: number;
}): Promise<{ content: McpToolContent[]; isError?: boolean }> {
  try {
    const result = await runDebugCommand("reset", [], args?.timeout_ms ?? 10000);
    if (!result.ok) {
      return failure(`Reset failed: ${result.data}`);
    }
    let state: Record<string, string> | undefined;
    if (args?.verify !== false) {
      const read = await runDebugCommand("state", [], args?.timeout_ms ?? 10000);
      state = read.ok ? parseState(read.data) : undefined;
    }
    return text(JSON.stringify({ reset: true, state }, null, 2));
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

export async function handleSetTime(args: {
  offset_seconds?: number;
  iso?: string;
  clear?: boolean;
  timeout_ms?: number;
}): Promise<{ content: McpToolContent[]; isError?: boolean }> {
  try {
    let offset: number;
    if (args.clear === true) {
      offset = 0;
    } else if (args.iso) {
      const target = Date.parse(args.iso);
      if (!Number.isFinite(target)) {
        return failure(`Could not parse iso timestamp: ${args.iso}`);
      }
      offset = Math.round(target / 1000 - Date.now() / 1000);
    } else if (typeof args.offset_seconds === "number" && Number.isFinite(args.offset_seconds)) {
      offset = Math.round(args.offset_seconds);
    } else {
      return failure("Pass offset_seconds, iso, or clear: true.");
    }

    const result = await runDebugCommand("time", [String(offset)], args.timeout_ms ?? 10000);
    if (!result.ok) {
      return failure(`The app rejected the time offset: ${result.data}`);
    }

    return text(
      JSON.stringify(
        {
          offsetSeconds: offset,
          appNow: new Date(Date.now() + offset * 1000).toISOString(),
          channel: result.data,
          note:
            "Only code paths using DebugClock follow the offset. Reset clears it along with other storage.",
        },
        null,
        2
      )
    );
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

export async function handleDebugCommand(args: {
  verb: string;
  args?: string[];
  timeout_ms?: number;
}): Promise<{ content: McpToolContent[]; isError?: boolean }> {
  try {
    if (!args.verb || args.verb.includes(";")) {
      return failure("verb must be a non-empty string without semicolons.");
    }
    const parts = args.args ?? [];
    if (parts.some((part) => part.includes(";"))) {
      return failure("Command arguments cannot contain semicolons.");
    }
    const result = await runDebugCommand(
      args.verb,
      parts,
      args.timeout_ms ?? 10000
    );
    return text(describeResult(result));
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

export { debugServerStatus };
