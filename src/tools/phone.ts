import { runDebugCommand } from "../debug/channel.js";
import type { McpToolContent } from "./shared.js";

function failure(message: string): { content: McpToolContent[]; isError?: boolean } {
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function handlePhoneMessage(args: {
  title?: string;
  body?: string;
  timeout_ms?: number;
}): Promise<{ content: McpToolContent[]; isError?: boolean }> {
  try {
    const title = args.title ?? "";
    const body = args.body ?? "";
    if (title.includes(";") || body.includes(";")) {
      return failure("Phone message title and body cannot contain semicolons.");
    }
    const result = await runDebugCommand(
      "phone",
      [title, body],
      args.timeout_ms ?? 10000
    );
    if (!result.ok) {
      return failure(`The app rejected the phone message: ${result.data}`);
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              delivered: true,
              via: "debug-channel",
              title,
              body,
              result: result.data,
              note:
                "The app handler stored last_phone_message. Read it with state_read to verify the payload.",
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}
