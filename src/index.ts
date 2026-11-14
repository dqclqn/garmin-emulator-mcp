#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { testingResult, inspectUI, actOnUI, snapshotAppFiles, restoreAppFiles } from "./tools/testing.js";
import { runBridgeCommand } from "./simulator/bridge.js";
import { processManager } from "./simulator/process-manager.js";
import {
  handleBuildApp,
  handleLaunchSimulator,
  handleListDevices,
  handleRunApp,
  handleRunUnitTests,
  handleSetActiveDevice,
  handleSimulatorStatus,
  handleSessionStart,
  handleStopApp,
} from "./tools/lifecycle.js";
import {
  handleHoldScreen,
  handlePressButton,
  handlePressButtonSequence,
  handleSendKey,
  handleSwipeScreen,
  handleTapScreen,
} from "./tools/navigation.js";
import {
  handleGetAppLogs,
  handleGetScreenshot,
} from "./tools/visual.js";
import {
  handleSetGlanceMode,
  handleTriggerMenuAction,
} from "./tools/environment.js";
import { handleDoctor } from "./tools/doctor.js";
import {
  handleCaptureWindow,
  handleCloseWindow,
  handleListWindows,
} from "./tools/dialogs.js";
import { handleCalibrate, handleMatrixDiff, handleMatrixRun } from "./tools/matrix.js";
import { handleResetState } from "./tools/state.js";
import { handlePhoneMessage } from "./tools/phone.js";
import { handleDevLoop } from "./tools/dev-loop.js";
import {
  handleDebugCommand,
  handleDebugPing,
  handleDebugStatus,
  handleStateRead,
  handleStateReset,
  handleStateSeed,
  handleSetTime,
} from "./tools/debug.js";
import { handleDiff, handleWaitForStable } from "./tools/observation.js";
import { placeSimulatorWindow } from "./simulator/bridge.js";
import { killIsolatedSimulatorSync, terminateIsolatedSimulator } from "./simulator/isolated.js";
import { clearPersistedSession } from "./session/session.js";
import { acquireSessionLock, releaseSessionLock, sessionId } from "./session/session.js";

/**
 * Shared schema fragment for input receipts: every state-changing input can
 * assert that the screen changed (or deliberately did not).
 */
const receiptFields = {
  expect: z
    .enum(["change", "noop"])
    .optional()
    .describe(
      "Assert the outcome: 'change' fails with E_NO_CHANGE when the screen is identical, 'noop' fails with E_UNEXPECTED_CHANGE when it differs"
    ),
  settle_ms: z
    .number()
    .optional()
    .describe("Milliseconds to wait before the after-capture used for the receipt (default: 400)"),
};

/**
 * Creates and configures the Garmin Emulator MCP Server with all automation tools.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "garmin-emulator-mcp",
    version: "0.1.0",
  });

  // Every tool that returns a JSON text block also exposes the same object as
  // MCP structured content. Tools may still set structuredContent explicitly.
  const originalTool = (server as any).tool.bind(server);
  (server as any).tool = (...args: any[]) => {
    const handler = args[args.length - 1];
    if (typeof handler === "function") {
      args[args.length - 1] = async (...handlerArgs: any[]) => {
        const result = await handler(...handlerArgs);
        if (result && Array.isArray(result.content) && result.structuredContent === undefined) {
          const text = result.content.find((item: any) => item?.type === "text")?.text;
          if (typeof text === "string" && text.trim().startsWith("{")) {
            try {
              const parsed = JSON.parse(text);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                result.structuredContent = parsed;
              }
            } catch {
              // Prose and non-JSON text stay as text only.
            }
          }
        }
        return result;
      };
    }
    return originalTool(...args);
  };

  // ==========================================
  // Lifecycle Tools
  // ==========================================

  server.tool(
    "session_start",
    "Report whether this server adopted a simulator left by an earlier session or started clean. Use reset: true to terminate the adopted simulator and clear the stored session.",
    {
      reset: z.boolean().optional().describe("Terminate the adopted simulator and clear session state (default: false)"),
    },
    async (args) => handleSessionStart(args)
  );

  server.tool(
    "simulator_status",
    "Inspect Connect IQ simulator process status, window ID, bounds, macOS Screen Recording and Accessibility permissions, TCP port 1234 status, and active device profile metadata.",
    {},
    async () => handleSimulatorStatus()
  );

  server.tool(
    "launch_simulator",
    "Launch the Garmin Connect IQ simulator, by default on a hidden Windows desktop where button input does not change your foreground window.",
    {
      wait_ms: z
        .number()
        .optional()
        .describe(
          "Maximum milliseconds to wait for the simulator window and TCP port 1234 (default: 25000 isolated, 15000 normal)"
        ),
      isolated: z
        .boolean()
        .optional()
        .describe(
          "Run on a hidden desktop (default: true on Windows). Set false to use the visible desktop and the focus lease."
        ),
    },
    async (args) => handleLaunchSimulator(args)
  );

  server.tool(
    "list_devices",
    "List all installed Garmin device profiles in Connect IQ SDK Devices directory with display resolutions, touch support, screen shape, and available buttons.",
    {
      query: z
        .string()
        .optional()
        .describe(
          "Filter devices by ID or display name substring (e.g. 'fenix', 'forerunner', 'venu', 'edge')"
        ),
      touch_only: z
        .boolean()
        .optional()
        .describe("Only return touchscreen-enabled devices"),
    },
    async (args) => handleListDevices(args)
  );

  server.tool(
    "set_active_device",
    "Set the active Garmin device ID for subsequent simulator commands, button presses, touch gestures, and screenshot cropping.",
    {
      device_id: z
        .string()
        .describe(
          "Target device ID (e.g. 'fenix847mm', 'venu3', 'fr965', 'epix2pro47mm')"
        ),
    },
    async (args) => handleSetActiveDevice(args)
  );

  server.tool(
    "dev_loop",
    "Build the project, run it, capture the first stable frame and return the latest log lines in one call.",
    {
      project_dir: z.string().describe("Monkey C project directory"),
      device_id: z.string().optional().describe("Device id (defaults to active device)"),
      debug_channel: z.boolean().optional().describe("Build with the debug automation channel (default: true)"),
      wait_ms: z.number().optional().describe("Monkeydo startup wait (default: 2500)"),
      settle_ms: z.number().optional().describe("Reserved settle time for future frame selection"),
      log_lines: z.number().optional().describe("Log lines to return (default: 40)"),
      jungle_file: z.string().optional().describe("Explicit jungle file"),
      developer_key_path: z.string().optional().describe("Explicit developer key"),
    },
    async (args) => handleDevLoop(args)
  );

  server.tool(
    "build_app",
    "Build a Monkey C project for a specified device using the SDK monkeyc compiler.",
    {
      project_dir: z
        .string()
        .describe(
          "Path to Monkey C project directory containing monkey.jungle or manifest.xml"
        ),
      device_id: z
        .string()
        .optional()
        .describe(
          "Garmin device ID to build for (e.g. 'fenix847mm'). Defaults to active device."
        ),
      jungle_file: z
        .string()
        .optional()
        .describe(
          "Path to jungle build file (defaults to project_dir/monkey.jungle)"
        ),
      developer_key_path: z
        .string()
        .optional()
        .describe(
          "Path to developer key (.der). Defaults to developer_key.der in project or SDK."
        ),
      output_prg_path: z
        .string()
        .optional()
        .describe("Destination file path for output .prg binary"),
      extra_args: z
        .array(z.string())
        .optional()
        .describe("Extra CLI flags to pass directly to monkeyc"),
      debug_channel: z
        .boolean()
        .optional()
        .describe(
          "Swap in the debug automation config before building (default: true). Set false for a release build with the channel disabled."
        ),
      timeout_ms: z
        .number()
        .optional()
        .describe("Hard build deadline; monkeyc is killed with E_TIMEOUT"),
    },
    async (args) => handleBuildApp(args)
  );

  server.tool(
    "run_app",
    "Push and run a compiled Monkey C executable (.prg) on the active device in the simulator using monkeydo, and stream logs.",
    {
      prg_path: z
        .string()
        .describe("Path to the compiled executable .prg file"),
      device_id: z
        .string()
        .optional()
        .describe("Garmin device ID to run on (defaults to active device)"),
      wait_ms: z
        .number()
        .optional()
        .describe(
          "Milliseconds to wait for app launch and initial log output (default: 2500)"
        ),
      capture_after: z
        .boolean()
        .optional()
        .describe(
          "Whether to capture and return an initial watch screenshot after launching (default: true)"
        ),
      startup_timeout_ms: z
        .number()
        .optional()
        .describe("Maximum wait for a stable frame and startup log marker (default: 8000)"),
      timeout_ms: z
        .number()
        .optional()
        .describe("Hard startup deadline that kills monkeydo with E_TIMEOUT"),
    },
    async (args) => handleRunApp(args)
  );

  server.tool(
    "stop_app",
    "Stop the currently running Garmin Monkey C app process in the simulator.",
    {},
    async () => handleStopApp()
  );

  server.tool(
    "run_unit_tests",
    "Run Monkey C unit tests for a compiled .prg test binary in the simulator using monkeydo -t.",
    {
      prg_path: z
        .string()
        .describe("Path to compiled test .prg executable"),
      device_id: z
        .string()
        .optional()
        .describe("Device ID to execute tests on (defaults to active device)"),
      test_name: z
        .string()
        .optional()
        .describe("Optional specific test name or suite prefix to execute"),
      timeout_ms: z
        .number()
        .optional()
        .describe("Maximum execution timeout in milliseconds (default: 30000)"),
    },
    async (args) => handleRunUnitTests(args)
  );

  // ==========================================
  // Navigation & User Input Tools
  // ==========================================

  server.tool(
    "press_button",
    "Press a physical bezel button on the active Garmin device (e.g. 'select', 'back', 'up', 'down', 'menu'). Supports short clicks or long-press holds, and returns the updated watch screen.",
    {
      button: z
        .string()
        .describe(
          "Button identifier or alias (e.g. 'select', 'enter', 'start', 'back', 'esc', 'up', 'down', 'menu')"
        ),
      hold: z
        .boolean()
        .optional()
        .describe("Perform a long press (hold) instead of short click"),
      hold_ms: z
        .number()
        .optional()
        .describe(
          "Custom hold duration in milliseconds (defaults to 1200ms for hold, 80ms for short click)"
        ),
      device_id: z
        .string()
        .optional()
        .describe(
          "Device profile ID to resolve button coordinates from (defaults to active device)"
        ),
      method: z
        .enum(["mouse", "key"])
        .optional()
        .describe(
          "Input synthesis method: 'mouse' clicks bezel hitbox center; 'key' sends macOS virtual keycode (default: 'mouse')"
        ),
      capture_after: z
        .boolean()
        .optional()
        .describe(
          "Whether to capture and return a screenshot after the button press (default: true)"
        ),
      wait_ms: z
        .number()
        .optional()
        .describe(
          "Milliseconds to wait after button press before capturing screenshot (default: 350)"
        ),
      ...receiptFields,
    },
    async (args) => handlePressButton(args)
  );

  server.tool(
    "press_button_sequence",
    "Execute a sequence of button presses in order with configurable delays, capturing the final watch screen.",
    {
      isolated: z
        .boolean()
        .optional()
        .describe("Launch on a hidden desktop when the simulator is not running (default: true on Windows)"),
      steps: z
        .array(
          z.object({
            button: z.string().describe("Button name"),
            hold: z.boolean().optional().describe("Long press"),
            hold_ms: z.number().optional().describe("Custom hold ms"),
            wait_ms: z
              .number()
              .optional()
              .describe("Delay after step (default: 300ms)"),
          })
        )
        .describe("List of button press steps to execute in sequence"),
      device_id: z
        .string()
        .optional()
        .describe("Device profile ID (defaults to active device)"),
      capture_after: z
        .boolean()
        .optional()
        .describe(
          "Whether to capture a screenshot after sequence completes (default: true)"
        ),
      ...receiptFields,
    },
    async (args) => handlePressButtonSequence(args)
  );

  server.tool(
    "send_key",
    "Send a platform virtual key code or named key ('enter', 'esc', 'up', 'down', 'menu', 'space') to the Connect IQ simulator window.",
    {
      key: z
        .string()
        .optional()
        .describe(
          "Key name or alias (e.g. 'enter', 'return', 'select', 'esc', 'back', 'up', 'down', 'menu', 'space')"
        ),
      key_code: z
        .number()
        .optional()
        .describe(
          "Platform virtual key code (Windows and macOS use different codes)"
        ),
      hold_ms: z
        .number()
        .optional()
        .describe("Key hold duration in milliseconds (default: 80)"),
      capture_after: z
        .boolean()
        .optional()
        .describe(
          "Whether to capture and return a screenshot after key press (default: false)"
        ),
      wait_ms: z
        .number()
        .optional()
        .describe(
          "Milliseconds to wait after key press before capturing screenshot (default: 350)"
        ),
      device_id: z
        .string()
        .optional()
        .describe("Device profile ID (defaults to active device)"),
      ...receiptFields,
    },
    async (args) => handleSendKey(args)
  );

  server.tool(
    "tap_screen",
    "Tap the watch touchscreen at specific display coordinates (X, Y) or normalized coordinates (0.0..1.0).",
    {
      x: z
        .number()
        .describe(
          "X coordinate: display pixels (0..width) or normalized ratio (0.0..1.0 if normalized: true)"
        ),
      y: z
        .number()
        .describe(
          "Y coordinate: display pixels (0..height) or normalized ratio (0.0..1.0 if normalized: true)"
        ),
      normalized: z
        .boolean()
        .optional()
        .describe(
          "Whether coordinates are normalized 0.0 to 1.0 (default: false)"
        ),
      device_id: z
        .string()
        .optional()
        .describe("Device profile ID (defaults to active device)"),
      capture_after: z
        .boolean()
        .optional()
        .describe(
          "Whether to capture a screenshot after tapping (default: true)"
        ),
      wait_ms: z
        .number()
        .optional()
        .describe(
          "Milliseconds to wait after tap before capturing screenshot (default: 350)"
        ),
      ...receiptFields,
    },
    async (args) => handleTapScreen(args)
  );

  server.tool(
    "swipe_screen",
    "Synthesize a touch drag gesture on the watch display in a cardinal direction ('up', 'down', 'left', 'right'), adhering to device gesture thresholds.",
    {
      direction: z
        .enum(["up", "down", "left", "right"])
        .describe(
          "Direction of swipe gesture: 'up' (next page), 'down' (previous page), 'right' (back/exit), 'left'"
        ),
      device_id: z
        .string()
        .optional()
        .describe("Device profile ID (defaults to active device)"),
      capture_after: z
        .boolean()
        .optional()
        .describe(
          "Whether to capture a screenshot after swiping (default: true)"
        ),
      wait_ms: z
        .number()
        .optional()
        .describe(
          "Milliseconds to wait after swipe before capturing screenshot (default: 350)"
        ),
      ...receiptFields,
    },
    async (args) => handleSwipeScreen(args)
  );

  server.tool(
    "hold_screen",
    "Long-press at specific coordinates on the watch touchscreen (e.g. to open a watchface complication or menu).",
    {
      x: z
        .number()
        .describe("X coordinate: display pixels or normalized ratio"),
      y: z
        .number()
        .describe("Y coordinate: display pixels or normalized ratio"),
      duration_ms: z
        .number()
        .optional()
        .describe("Touch hold duration in milliseconds (default: 1000)"),
      normalized: z
        .boolean()
        .optional()
        .describe(
          "Whether coordinates are normalized 0.0 to 1.0 (default: false)"
        ),
      device_id: z
        .string()
        .optional()
        .describe("Device profile ID (defaults to active device)"),
      capture_after: z
        .boolean()
        .optional()
        .describe(
          "Whether to capture a screenshot after holding (default: true)"
        ),
      wait_ms: z
        .number()
        .optional()
        .describe(
          "Milliseconds to wait after touch before capturing screenshot (default: 350)"
        ),
      ...receiptFields,
    },
    async (args) => handleHoldScreen(args)
  );

  // ==========================================
  // Visual Inspection & Logs Tools
  // ==========================================

  server.tool(
    "get_screenshot",
    "Capture a screenshot of the Connect IQ simulator. Supports watch display crop ('screen', 1:1 pixel mapping), full window with bezel ('bezel'), or annotated debug view with button hitboxes and coordinate grid ('annotated').",
    {
      view: z
        .enum(["screen", "bezel", "annotated"])
        .optional()
        .describe(
          "Screenshot view mode: 'screen' crops to watch display; 'bezel' captures device bezel; 'annotated' composites SVG debug overlay (default: 'screen')"
        ),
      device_id: z
        .string()
        .optional()
        .describe("Device profile ID (defaults to active device)"),
      save_path: z
        .string()
        .optional()
        .describe("Optional file path on disk to save the image"),
      format: z
        .enum(["png", "webp"])
        .optional()
        .describe("Output format (default: png)"),
      hash_only: z
        .boolean()
        .optional()
        .describe("Return the hash and metadata without the image payload"),
      region: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        })
        .optional()
        .describe("Crop region in processed screenshot pixels"),
      mask: z
        .enum(["round", "none"])
        .optional()
        .describe("Mask the screen view to a circle (round devices)"),
      inline_ocr: z
        .boolean()
        .optional()
        .describe("Run OCR on the captured image and include the text"),
      expect_text: z
        .string()
        .optional()
        .describe("Fail with E_TEXT_NOT_FOUND unless the OCR text contains this value"),
    },
    async (args) => handleGetScreenshot(args)
  );

  server.tool(
    "get_app_logs",
    "Retrieve console output, System.println logs, and crash traces from the running Monkey C application and simulator. Logs are also appended to a session file, so a reconnect does not lose history.",
    {
      lines: z
        .number()
        .optional()
        .describe(
          "Number of most recent log lines to retrieve (defaults to all)"
        ),
      clear: z
        .boolean()
        .optional()
        .describe(
          "Whether to clear the in-memory log buffer after reading (default: false); the session file is kept"
        ),
      since_seq: z
        .number()
        .optional()
        .describe(
          "Only return lines newer than this sequence number (use next_seq from a previous call)"
        ),
    },
    async (args) => handleGetAppLogs(args)
  );

  // ==========================================
  // Environment & Menu Automation Tools
  // ==========================================

  server.tool(
    "trigger_menu_action",
    "Trigger a macOS menu item in ConnectIQ.app via Accessibility (AXUIElement), such as simulation data or activity settings.",
    {
      menu_path: z
        .array(z.string())
        .describe(
          "Hierarchical menu path to click, e.g. ['Simulation', 'Activity Data'] or ['Settings', 'Glance View']"
        ),
      capture_after: z
        .boolean()
        .optional()
        .describe(
          "Whether to capture a screenshot after menu trigger (default: true)"
        ),
      wait_ms: z
        .number()
        .optional()
        .describe(
          "Milliseconds to wait after menu click before capturing screenshot (default: 400)"
        ),
    },
    async (args) => handleTriggerMenuAction(args)
  );

  server.tool(
    "set_glance_mode",
    "Toggle or set the simulator Glance View mode (Settings > Glance View) for testing widget glance summaries.",
    {
      enabled: z
        .boolean()
        .optional()
        .describe(
          "Target glance view state (true to enable, false to disable, or omitted to toggle)"
        ),
      capture_after: z
        .boolean()
        .optional()
        .describe(
          "Whether to capture a screenshot after toggling (default: true)"
        ),
      wait_ms: z
        .number()
        .optional()
        .describe(
          "Milliseconds to wait before capturing screenshot (default: 400)"
        ),
    },
    async (args) => handleSetGlanceMode(args)
  );

  server.tool("inspect_ui", "Read simulator Accessibility hierarchy, including menus and native dialogs. Pass hwnd to inspect a dialog from list_windows. Paths are ephemeral: inspect before acting.",
    {
      depth: z.number().int().min(1).max(14).default(7),
      hwnd: z.number().int().optional().describe("Window handle from list_windows; omit for the main simulator window"),
    },
    async ({ depth, hwnd }) => testingResult(() => inspectUI(depth, hwnd)));
  server.tool("act_on_ui", "Act on a freshly inspected native simulator element. set writes AXValue; AXPress activates controls. Pass hwnd for dialogs.",
    {
      path: z.array(z.number().int().nonnegative()).min(1),
      action: z.enum(["set", "select", "focus", "AXPress", "AXConfirm", "AXIncrement", "AXDecrement"]),
      value: z.string().optional(),
      hwnd: z.number().int().optional().describe("Window handle from list_windows; omit for the main simulator window"),
    },
    async (args) => testingResult(() => actOnUI(args.path, args.action, args.value, args.hwnd)));
  server.tool("snapshot_app_files", "Back up only files matching explicit PRG basenames from simulator APPS. Does not stop the app; use an idle/stopped session.",
    { directory: z.string(), app_names: z.array(z.string()) },
    async (args) => testingResult(() => snapshotAppFiles(args.directory, args.app_names)));
  server.tool("restore_app_files", "Restore a verified app-scoped snapshot. Requires explicit confirmation and a stopped app; never use while app/background writes are active.",
    { directory: z.string(), app_names: z.array(z.string()), confirm_stopped: z.literal(true) },
    async (args) => testingResult(() => restoreAppFiles(args.directory, args.app_names)));
  server.tool("terminate_simulator", "Terminate only ConnectIQ.app and destroy its isolated desktop if one was used. Force is for an unresponsive simulator. Does not delete stored data.",
    { force: z.boolean().default(false) },
    async ({ force }) => {
      try {
        const result = await terminateIsolatedSimulator(force);
        clearPersistedSession();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    });
  server.tool("recognize_image_text", "Recognize text in a saved simulator PNG using on-device OCR. Returns text and normalized bounds; confidence is available on macOS. OCR is evidence, not a replacement for storage assertions.",
    { image_path: z.string() },
    async ({ image_path }) => testingResult(() => runBridgeCommand(["ocr", image_path])));
  server.tool("close_storage_editor", "Close the simulator's persistent-storage editor and verify the window is gone. Safe when already closed.",
    {},
    async () => testingResult(() => runBridgeCommand(["storage-close"])));
  server.tool(
    "place_window",
    "Move or clamp the simulator window inside the nearest monitor work area. With no coordinates it only rescues a window that is mostly off-screen.",
    {
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
    },
    async (args) => testingResult(() => placeSimulatorWindow(args))
  );

  server.tool(
    "wait_for_stable",
    "Wait until two consecutive simulator captures are identical, so screenshots and assertions are not taken mid-animation.",
    {
      timeout_ms: z.number().optional().describe("Maximum wait in milliseconds (default: 3000)"),
      interval_ms: z.number().optional().describe("Poll interval in milliseconds (default: 150)"),
      settle_ms: z.number().optional().describe("Initial settle delay in milliseconds"),
    },
    async (args) => handleWaitForStable(args)
  );

  server.tool(
    "diff_screenshot",
    "Compare a baseline PNG with another PNG or with the current simulator screen. Returns the changed percentage and the bounding box of change.",
    {
      before_path: z.string().describe("Baseline PNG path"),
      after_path: z
        .string()
        .optional()
        .describe("Comparison PNG path; omit to capture the live simulator screen"),
      threshold: z
        .number()
        .optional()
        .describe("Per-pixel channel delta that counts as changed (default: 12)"),
    },
    async (args) => handleDiff(args)
  );

  server.tool(
    "doctor",
    "Check the SDK, toolchain, device profiles, developer key, simulator window, occlusion and session log before blaming an app failure on the app.",
    {
      project_dir: z
        .string()
        .optional()
        .describe("Project directory used to look for a developer key"),
    },
    async (args) => handleDoctor(args)
  );

  server.tool(
    "debug_status",
    "Report the local debug channel endpoint, whether the app has polled it, and the last command result.",
    {},
    async () => handleDebugStatus()
  );

  server.tool(
    "debug_ping",
    "Round-trip a ping through the in-app debug channel. Proves the app is running and polling without touching focus.",
    {
      timeout_ms: z.number().optional().describe("Timeout in milliseconds (default: 10000)"),
    },
    async (args) => handleDebugPing(args)
  );

  server.tool(
    "state_read",
    "Read the app's storage and property state through the in-app debug channel. Values are scalar summaries; arrays report size.",
    {
      keys: z
        .array(z.string())
        .optional()
        .describe("Only return these storage keys (property names are matched with or without the prop: prefix)"),
      timeout_ms: z.number().optional().describe("Timeout in milliseconds (default: 10000)"),
    },
    async (args) => handleStateRead(args)
  );

  server.tool(
    "state_seed",
    "Write storage keys through the in-app debug channel, then optionally read them back to verify. Use null to delete a key.",
    {
      values: z
        .record(z.any())
        .optional()
        .describe(
          "Storage values to write: scalar, string array, or a flat object. premium expects { active: boolean, code: string }; deck_list expects an array of ids."
        ),
      properties: z
        .record(z.any())
        .optional()
        .describe(
          "Debug property overrides to store as debug_prop_<key>. Supported keys: daily_goal, reveal_behavior, auto_advance, card_order, premium_enabled, deck_data, deck_2, deck_3, deck_4."
        ),
      verify: z.boolean().optional().describe("Read back and compare after writing (default: true)"),
      snapshot: z
        .boolean()
        .optional()
        .describe("Snapshot app storage before writing premium, license or deck keys (default: true)"),
      snapshot_dir: z.string().optional().describe("Directory for the snapshot"),
      app_names: z
        .array(z.string())
        .optional()
        .describe("Uppercase PRG basenames to snapshot; defaults to the last run PRG"),
      prg_path: z
        .string()
        .optional()
        .describe("PRG to restart after the snapshot; defaults to the last run PRG"),
      device_id: z
        .string()
        .optional()
        .describe("Device used when restarting after the snapshot; defaults to the last run device"),
      timeout_ms: z.number().optional().describe("Per-command timeout in milliseconds (default: 10000)"),
    },
    async (args) => handleStateSeed(args)
  );

  server.tool(
    "state_reset",
    "Clear every app storage key through the in-app debug channel and optionally report the resulting state.",
    {
      verify: z.boolean().optional().describe("Read state after clearing (default: true)"),
      timeout_ms: z.number().optional().describe("Timeout in milliseconds (default: 10000)"),
    },
    async (args) => handleStateReset(args)
  );

  server.tool(
    "set_time",
    "Shift the app's clock through the debug channel. Use an ISO timestamp or an offset in seconds. Only code paths using DebugClock follow the offset.",
    {
      offset_seconds: z.number().optional().describe("Seconds to add to the app clock"),
      iso: z.string().optional().describe("Target ISO timestamp to move the app clock to"),
      clear: z.boolean().optional().describe("Reset the offset to zero"),
      timeout_ms: z.number().optional().describe("Timeout in milliseconds (default: 10000)"),
    },
    async (args) => handleSetTime(args)
  );

  server.tool(
    "debug_command",
    "Send a raw command to the in-app debug channel. Verbs: ping, state, seed, premium, deck_list, list, map, time, phone, reset; arguments are semicolon-free strings.",
    {
      verb: z.string().describe("Command verb, for example state"),
      args: z.array(z.string()).optional().describe("Positional arguments after the verb"),
      timeout_ms: z.number().optional().describe("Timeout in milliseconds (default: 10000)"),
    },
    async (args) => handleDebugCommand(args)
  );

  server.tool(
    "phone_message",
    "Deliver a phone-app message to the running app through the debug channel and let the app handler store it. Use state_read to verify last_phone_message.",
    {
      title: z.string().optional().describe("Message title"),
      body: z.string().optional().describe("Message body"),
      timeout_ms: z.number().optional().describe("Timeout in milliseconds (default: 10000)"),
    },
    async (args) => handlePhoneMessage(args)
  );

  server.tool(
    "list_windows",
    "List top-level simulator windows, including storage, login, time and phone-message dialogs. IME and hidden wx windows are filtered unless include_hidden is true.",
    {
      include_hidden: z.boolean().optional().describe("Include IME, tooltip and hidden wx windows (default: false)"),
    },
    async (args) => handleListWindows(args)
  );

  server.tool(
    "capture_window",
    "Capture a simulator-owned dialog or window by hwnd. Returns the PNG image and optional saved path.",
    {
      hwnd: z.number().int().describe("Window handle from list_windows"),
      save_path: z.string().optional().describe("Optional file path to save the PNG"),
    },
    async (args) => handleCaptureWindow(args)
  );

  server.tool(
    "close_window",
    "Close a simulator-owned dialog by hwnd. Refuses to close the main simulator window.",
    {
      hwnd: z.number().int().describe("Window handle from list_windows"),
    },
    async (args) => handleCloseWindow(args)
  );

  server.tool(
    "reset_state",
    "Reset persisted app data through the simulator menu, with a screenshot and optional APPS snapshot first. Requires confirm: true. Restart the app afterwards to observe a clean launch.",
    {
      scope: z
        .enum(["app", "all_apps", "simulator"])
        .optional()
        .describe("app clears this app's data; all_apps deletes every app; simulator resets the simulator"),
      confirm: z.literal(true).describe("Must be true; this is destructive"),
      snapshot: z.boolean().optional().describe("Snapshot APP files before resetting (default: true for app scope)"),
      snapshot_dir: z.string().optional().describe("Directory for the snapshot"),
      verify: z.boolean().optional().describe("Read state through the debug channel after reset (default: true)"),
      wait_ms: z.number().optional().describe("Settle time after invoking the menu (default: 1200)"),
      stop_app: z
        .boolean()
        .optional()
        .describe("Kill the running app first so cached state cannot rewrite storage (default: true)"),
      app_names: z
        .array(z.string())
        .optional()
        .describe("Uppercase PRG basenames to snapshot; defaults to the last run PRG"),
    },
    async (args) => handleResetState(args)
  );

  server.tool(
    "matrix_run",
    "Build, run and capture one screen per device, optionally run a button/touch scenario, and compare each step against .ciq/baselines. Creates baselines when missing or when update_baselines is true.",
    {
      project_dir: z.string().describe("Monkey C project directory"),
      devices: z.array(z.string()).min(1).describe("Device ids from list_devices"),
      baseline_dir: z.string().optional().describe("Baseline directory (default: <project>/.ciq/baselines)"),
      output_dir: z.string().optional().describe("Current capture directory (default: <project>/.ciq/current)"),
      update_baselines: z.boolean().optional().describe("Overwrite baselines with this run"),
      wait_ms: z.number().optional().describe("Monkeydo startup wait per device (default: 3000)"),
      settle_ms: z.number().optional().describe("Extra settle time before capture (default: 1200)"),
      threshold: z.number().optional().describe("Per-pixel channel delta for diffs (default: 12)"),
      jungle_file: z.string().optional().describe("Explicit jungle file"),
      developer_key_path: z.string().optional().describe("Explicit developer key"),
      debug_channel: z
        .boolean()
        .optional()
        .describe("Build with the debug automation channel (default: true)"),
      reset_before_each: z
        .boolean()
        .optional()
        .describe("Clear app storage and stop the app before each device (default: true)"),
      isolated: z
        .boolean()
        .optional()
        .describe("Launch on a hidden desktop when the simulator is not running (default: true on Windows)"),
      steps: z
        .array(
          z.object({
            name: z.string().optional(),
            action: z.enum(["button", "tap", "swipe", "hold", "wait"]),
            button: z.string().optional(),
            hold: z.boolean().optional(),
            hold_ms: z.number().optional(),
            x: z.number().optional(),
            y: z.number().optional(),
            direction: z.enum(["up", "down", "left", "right"]).optional(),
            duration_ms: z.number().optional(),
            expect: z.enum(["change", "noop"]).optional(),
          })
        )
        .max(20)
        .optional()
        .describe("Optional input scenario run after the first capture, with a baseline per step"),
    },
    async (args) => handleMatrixRun(args)
  );

  server.tool(
    "matrix_diff",
    "Compare every baseline PNG in a directory with the matching current PNG and report changed percentage and bounds.",
    {
      baseline_dir: z.string().describe("Directory containing baseline PNGs"),
      output_dir: z.string().optional().describe("Directory containing current PNGs (default: sibling 'current')"),
      threshold: z.number().optional().describe("Per-pixel channel delta (default: 12)"),
    },
    async (args) => handleMatrixDiff(args)
  );

  server.tool(
    "calibrate",
    "Report window, bezel and display geometry plus every button centre mapped to screen coordinates, and check each point is inside the window. Optionally save a raw screenshot.",
    {
      device_id: z.string().optional().describe("Device id (defaults to active device)"),
      save_path: z.string().optional().describe("Optional file path for a raw simulator screenshot"),
      verify: z.boolean().optional().describe("Tap a grid and report changed pixels at each point"),
      grid: z.number().int().min(2).max(5).optional().describe("Grid size per axis for verify (default: 3)"),
    },
    async (args) => handleCalibrate(args)
  );

  return server;
}

/**
 * Server main function: starts the stdio transport.
 */
export async function main(): Promise<void> {
  if (process.env.CIQ_MCP_ALLOW_MULTI !== "1") {
    const lock = acquireSessionLock();
    if (!lock.ok) {
      console.error(
        `Another garmin-emulator-mcp instance is already driving the simulator ` +
          `(pid ${lock.owner?.pid ?? "unknown"}, session ${lock.owner?.sessionId ?? "unknown"}). ` +
          `Stop it first, or set CIQ_MCP_ALLOW_MULTI=1 to override.`
      );
      process.exit(2);
    }
    process.once("exit", releaseSessionLock);
  }
  process.once("exit", killIsolatedSimulatorSync);
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `garmin-emulator-mcp session ${sessionId}; logs at ${processManager.getLogFilePath()}`
  );
  // Do not leave a simulator launcher behind when this server exits; stale
  // monkeydo/shell processes accumulate and fight over port 1234.
  const killChild = () => {
    const child = processManager.getActiveProcess();
    if (child) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  };
  process.once("exit", killChild);
  process.once("SIGINT", () => { killChild(); process.exit(0); });
  process.once("SIGTERM", () => { killChild(); process.exit(0); });
  // A stdio client that just closes the pipe leaves no signal and no exit, so the
  // server used to outlive its client with the monkeydo child still attached.
  const shutdown = () => { killChild(); process.exit(0); };
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
}

// Run main if this is the entry script
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith("index.ts") || process.argv[1].endsWith("index.js"));

if (isMainModule) {
  main().catch((err) => {
    console.error("Fatal error starting Garmin Emulator MCP server:", err);
    process.exit(1);
  });
}
