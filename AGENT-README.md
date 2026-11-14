# Garmin Simulator MCP: Agent Reference

This file is the operating reference for an AI agent driving this server. The human-facing overview lives in [README.md](README.md).

- Transport: stdio, one JSON-RPC session.
- Entry point: `node /path/to/garmin-simulator-mcp/dist/index.js`.
- Tools: 46. Optional parameters are marked `?`.
- One server may drive the simulator at a time. A second instance exits with code 2 and names the lock owner.

## Suggested loop

1. `doctor` with the project directory.
2. `launch_simulator` and wait for `ready: true`.
3. `build_app`, then `run_app` with the returned `outputPrgPath`.
4. `wait_for_stable`, then `get_screenshot`.
5. `press_button` (or `press_button_sequence`) with `expect: "change"`.
6. `get_app_logs` for `System.println` output and crashes.
7. Optionally `debug_ping` and `state_read` to confirm app state without focus.
8. `terminate_simulator` when finished.

## Response contract

- Text tools return human-readable text, usually with a JSON body, plus image blocks for screenshots.
- Input tools return a **receipt** line: before and after screen hashes, changed percentage, changed region, settle time and the focus path used.
- `expect: "change"` turns an unchanged screen into `isError: true` with `E_NO_CHANGE`.
- `expect: "noop"` turns an unexpected change into `isError: true` with `E_UNEXPECTED_CHANGE`.
- Refused input returns `E_FOCUS_DENIED` with the blocking window title and pid, or an explicit "no foreground window" when the desktop is locked.
- `E_STALE_PRG` means the PRG on disk no longer matches the last successful build; rebuild before running.
- `E_INTEGRITY_MISMATCH` means the server and simulator run at different elevation levels; messages would be dropped.
- `E_TIMEOUT`, `E_BUILD_FAILED`, `E_APP_NOT_LAUNCHED`, `E_SIMULATOR_NOT_RUNNING`, `E_SNAPSHOT_FAILED`, `E_STATE_TIMEOUT`, `E_DEVICE_BINDING_REQUIRED`, `E_DIALOG_UNCONFIRMED` and `E_TEXT_NOT_FOUND` cover the other failures.
- A changed screen means pixels moved, not that the app reached the intended state. Combine receipts with logs.

## Environment

| Item | Value |
|---|---|
| Connect IQ root (Windows) | `%APPDATA%\Garmin\ConnectIQ` |
| Connect IQ root (macOS) | `~/Library/Application Support/Garmin/ConnectIQ` |
| Override | `GARMIN_CONNECTIQ_ROOT` points at the root containing `Devices/` and `current-sdk.cfg` or `Sdks/`, not at an SDK `bin/` |
| SDK selection | `current-sdk.cfg`, falling back to the newest folder under `Sdks/` |
| Tools | `monkeyc`, `monkeydo`, `shell`, and `simulator.exe` (Windows) or `ConnectIQ.app` (macOS) |
| Developer key | `developer_key_path`, project key files, SDK Manager config, Connect IQ root, `~/.garmin/developer_key.der` |
| State directory | `%LOCALAPPDATA%\ciq-mcp` (Windows) or `~/.local/state/ciq-mcp`; override with `CIQ_MCP_HOME` |
| State files | `session.lock`, `logs/<session>.log`, `captures/<session>/` |
| Concurrency override | `CIQ_MCP_ALLOW_MULTI=1` skips the session lock |
| Debug channel port | `CIQ_DEBUG_PORT` (default 8799); `build_app` writes the same value into the app |
| Debug channel token | `CIQ_DEBUG_TOKEN` (default `ciq-local-token`); sent as `x-ciq-token` on `/poll` and `/result` |

macOS needs Screen Recording and Accessibility permissions for the terminal or IDE hosting the server. Windows needs PowerShell 5.1 and an unlocked interactive desktop for input.

## Tool catalog

### Lifecycle and devices

| Tool | Parameters | Behaviour |
|---|---|---|
| `simulator_status` | none | Running state, window id, bounds, client size, foreground flag, `isolated`, `desktop`, TCP 1234 state, permission fields, active device profile and the `session` adoption decision. |
| `session_start` | `reset?` (false) | Reports whether this server adopted a simulator left by an earlier session. `reset: true` terminates it and clears `session-state.json`. |
| `launch_simulator` | `wait_ms?` (25000), `isolated?` (true on Windows) | Creates a hidden desktop and launches the simulator there, then waits for the final client size. Returns `started`, `portOpen`, `ready`, `isolated`, `desktop`, `window`, `clientSize`. Set `isolated: false` for the visible desktop and the focus lease. If a simulator is already running, it reports `alreadyRunning` instead of relaunching. |
| `list_devices` | `query?`, `touch_only?` | Installed profiles with resolution, touch support, shape and buttons. |
| `set_active_device` | `device_id` | Sets the metadata profile when the simulator is stopped. While it is running and the id differs, returns `E_DEVICE_BINDING_REQUIRED`; terminate first or pass `device_id` to `run_app`. |
| `build_app` | `project_dir`, `device_id?`, `jungle_file?`, `developer_key_path?`, `output_prg_path?`, `extra_args?`, `debug_channel?` (true), `timeout_ms?` | Compiles with `monkeyc`, swapping in the debug or release automation config first. A timeout kills the compiler with `E_TIMEOUT`. Returns `success`, `exitCode`, `deviceId`, `debugChannel`, `outputPrgPath`, `prgHash`, `stdout`, `stderr`. |
| `run_app` | `prg_path`, `device_id?`, `wait_ms?` (2500), `capture_after?` (true), `startup_timeout_ms?` (8000), `timeout_ms?` | Pushes the PRG with `monkeydo` and streams logs. Refuses a PRG whose hash differs from the last successful build with `E_STALE_PRG`. Returns `startupConfirmed` plus a `startup` object with the PRG hash match, stable frame, log marker and window title. |
| `dev_loop` | `project_dir`, `device_id?`, `debug_channel?` (true), `wait_ms?`, `settle_ms?`, `log_lines?` (40), `jungle_file?`, `developer_key_path?` | Builds, runs, captures the first frame and returns the log tail in one call. |
| `stop_app` | none | Stops the managed launcher only. The app can keep running in the simulator. |
| `run_unit_tests` | `prg_path`, `device_id?`, `test_name?`, `timeout_ms?` (30000) | Runs `monkeydo -t` and parses the result table. Requires a complete, consistent, passing table with no fatal output, signal or timeout. |
| `terminate_simulator` | `force?` (false) | Graceful close, waiting up to 5s. Use `force: true` only for an unresponsive simulator. |
| `place_window` | `x?`, `y?`, `width?`, `height?` | Moves or clamps the window inside the nearest monitor work area. With no arguments it only rescues a window that is mostly off-screen. |
| `doctor` | `project_dir?` | Checks SDK paths, profiles, Java, PowerShell, developer key, port, window geometry, foreground, occlusion at the client centre, log file and lock. Sets `isError` on a failed check. |

### Input

All input tools return a receipt and accept `expect` and `settle_ms`.

| Tool | Parameters | Behaviour |
|---|---|---|
| `press_button` | `button`, `hold?`, `hold_ms?`, `device_id?`, `method?` (mouse or key), `capture_after?` (true), `wait_ms?`, `expect?`, `settle_ms?` (400) | Presses a bezel button by id or alias. Hold defaults: 1200ms for hold, 80ms for a click. |
| `press_button_sequence` | `steps[]` of `{button, hold?, hold_ms?, wait_ms?}`, `device_id?`, `capture_after?`, `expect?`, `settle_ms?` | One focus lease for the whole batch, one receipt for the batch. |
| `send_key` | `key?`, `key_code?`, `hold_ms?` (80), `capture_after?` (false), `wait_ms?`, `device_id?`, `expect?`, `settle_ms?` | Named keys: `enter`, `esc`, `up`, `down`, `menu`, `space`. Numeric codes differ between Windows and macOS. |
| `tap_screen` | `x`, `y`, `normalized?`, `device_id?`, `capture_after?`, `wait_ms?`, `expect?`, `settle_ms?` | Touch tap at display pixels or normalized 0.0 to 1.0. |
| `swipe_screen` | `direction` (up, down, left, right), `device_id?`, `capture_after?`, `wait_ms?`, `expect?`, `settle_ms?` | Touch drag within device gesture thresholds. |
| `hold_screen` | `x`, `y`, `duration_ms?` (1000), `normalized?`, `device_id?`, `capture_after?`, `wait_ms?`, `expect?`, `settle_ms?` | Long press at display coordinates. |

Input rules:

- In isolated mode, input is sent with `SendMessage` to the watch canvas on the hidden desktop. No foreground change, no focus lease, and the receipt reports `focus isolated-desktop`.
- In normal mode, the server takes foreground once per press or sequence, verifies the simulator owns the click point, injects, then restores the previously focused window.
- Normal-mode input is impossible while the Windows session is locked. Isolated-mode input, capture, diff and menu commands still work while locked.
- If normal-mode input is refused, the call fails with `E_FOCUS_DENIED` and names the blocker. Do not retry in a loop; report it.

### Isolated desktop (Windows, default)

`launch_simulator` creates a desktop named `ciq-mcp-<session-suffix>` and starts the simulator there with `CreateProcess` and `lpDesktop`. The window is never visible on the user's desktop. Capture uses `PrintWindow`; input uses `WM_MOUSEMOVE`, `WM_LBUTTONDOWN` and `WM_LBUTTONUP` posted to the custom `wxWindowNR` watch canvas. Menu commands use `WM_COMMAND` to the hidden main window. `send_key` uses `WM_KEYDOWN` and `WM_KEYUP` to the canvas.

- No focus lease is acquired, and `SetForegroundWindow` is never called.
- `list_windows`, `capture_window`, `close_window`, `reset_state` and `inspect_ui` with an explicit `hwnd` target the hidden desktop.
- `run_app` works normally because monkeydo talks to the simulator over TCP 1234.
- `terminate_simulator` kills the process and closes the desktop. Server exit also kills an isolated simulator, so it cannot be orphaned.
- Pointer input is the verified path. The simulator imports `GetAsyncKeyState`, `GetKeyState`, `RegisterHotKey` and `SetWindowsHookExW`, so posted key messages are unreliable and may be ignored. `send_key` and `press_button` with `method: "key"` return an error on an isolated desktop; use `press_button` or `tap_screen`.
- The same imports mean the hidden simulator may observe real keystrokes while you type in another app. Do not treat the hidden desktop as a security boundary; test with real typing before relying on it.
- Message injection requires the server and the simulator to run at the same integrity level. The bridge checks this and throws `E_INTEGRITY_MISMATCH` instead of silently dropping input.
- If a simulator is already running on the normal desktop, terminate it before launching isolated.
- macOS has no isolated desktop path. `isolated` is ignored and the normal visible-desktop flow is used.

### Visual inspection

| Tool | Parameters | Behaviour |
|---|---|---|
| `get_screenshot` | `view?`, `device_id?`, `save_path?`, `format?` (png or webp), `hash_only?`, `region?`, `mask?` (round or none), `inline_ocr?`, `expect_text?` | `screen` crops the display at 1:1; `bezel` returns the frame; `annotated` adds hitboxes. `hash_only` drops the image payload, `region` crops, `mask: round` makes corners transparent, and `expect_text` fails with `E_TEXT_NOT_FOUND` when OCR misses it. |
| `get_app_logs` | `lines?`, `clear?`, `since_seq?` | Returns lines with `next_seq` and the session log path. Use `since_seq` to poll for new output. The session file keeps history across reconnects. |
| `wait_for_stable` | `timeout_ms?` (3000), `interval_ms?` (150), `settle_ms?` | Waits for two consecutive identical captures. Use before comparing screenshots of animated screens. |
| `diff_screenshot` | `before_path`, `after_path?`, `threshold?` (12) | Compares two PNGs, or a baseline against the live screen. Returns `changed`, `changedPct`, `changedPixels`, `totalPixels`, `bounds`. |
| `recognize_image_text` | `image_path` | Local OCR on a saved PNG. Returns text and normalized bounds. Windows returns no confidence scores and needs an OCR language pack. |

### Environment and native UI

| Tool | Parameters | Behaviour |
|---|---|---|
| `trigger_menu_action` | `menu_path[]`, `capture_after?`, `wait_ms?` | Clicks a native simulator menu item, for example `["Simulation", "Activity Data"]`. Menu commands work without focus. |
| `set_glance_mode` | `enabled?`, `capture_after?`, `wait_ms?` | Sets Glance Launch Mode. Omit `enabled` to toggle based on `simulator.ini`. |
| `list_windows` | `include_hidden?` (false) | Simulator dialogs with `hwnd`, title, class, visibility and rect. IME, tooltip and hidden wx windows are filtered unless `include_hidden` is true. |
| `inspect_ui` | `depth?` (1 to 14, default 7), `hwnd?` | Reads the native accessibility tree. Pass a dialog `hwnd` from `list_windows`; omit for the main window. The watch canvas is not exposed as native controls. |
| `act_on_ui` | `path[]`, `action` (set, select, focus, AXPress, AXConfirm, AXIncrement, AXDecrement), `value?`, `hwnd?` | Acts on a freshly inspected element. Paths are ephemeral; inspect again before acting. |
| `capture_window` | `hwnd`, `save_path?` | Captures a dialog or window owned by the simulator. Use for storage, login, time and phone-message dialogs. |
| `close_window` | `hwnd` | Closes a simulator-owned dialog. Refuses to close the main window. |
| `close_storage_editor` | none | Closes the persistent-storage editor and verifies it is gone. Safe when already closed. |

### Debug channel and app state

The channel is outbound only: the watch app polls `http://127.0.0.1:8799` and posts results back. No focus, no synthetic input, no inbound listener.

Prerequisites: the app is compiled with `DEBUG_CHANNEL_ENABLED = true` (`source/debug/DebugConfig.mc`), and the simulator has **Simulation > Use Device HTTPS Requirements** disabled. Override the port with `CIQ_DEBUG_PORT`.

| Tool | Parameters | Behaviour |
|---|---|---|
| `debug_status` | none | Endpoint, queued and pending commands, last poll age, last result. A null poll timestamp means no app has polled yet. |
| `debug_ping` | `timeout_ms?` (10000) | Round-trips `ping`. Proves the app is running and polling. |
| `state_read` | `keys?`, `timeout_ms?` | Storage keys and app properties. Requested keys are sent to the app, so per-deck and other custom keys are readable. `prop:` is the compile-time property, `propOverride:` is the debug override; arrays and dictionaries report size, long strings report length. |
| `state_seed` | `values?` (scalar, string array, or flat object), `properties?`, `verify?` (true), `snapshot?` (true), `snapshot_dir?`, `app_names?`, `prg_path?`, `device_id?`, `timeout_ms?` | Writes storage with the correct shape: `premium` expects `{ active, code }`, `deck_list` expects an array of ids, other arrays become string arrays, objects become string maps. `properties` writes `debug_prop_<key>` overrides. Sensitive keys stop the app, snapshot `DATA/APP.DAT`, restart it and refuse to write if the snapshot fails. `null` deletes a key. |
| `state_reset` | `verify?` (true), `timeout_ms?` | Clears every storage key through `Storage.clearValues()`. Restart the app for a clean first launch. |
| `set_time` | `offset_seconds?`, `iso?`, `clear?`, `timeout_ms?` | Stores a clock offset used by `DebugClock` in SRS and date code. Does not change the simulator clock. |
| `reset_state` | `scope?` (app, all_apps, simulator), `confirm` (true), `snapshot?`, `snapshot_dir?`, `verify?`, `wait_ms?`, `stop_app?` (true), `app_names?`, `prg_path?`, `device_id?` | For app scope, stops the app, snapshots DATA, restarts it for the channel clear and kills it afterwards; returns `resetVia: "debug-channel"`. Other scopes use the simulator menu. Tries Enter on a confirmation dialog and reports `needsConfirmation` when it cannot close it. |
| `debug_command` | `verb`, `args?`, `timeout_ms?` | Raw channel escape hatch. Verbs: `ping`, `state`, `seed`, `reset`, `time`, `phone`. |
| `phone_message` | `title?`, `body?`, `timeout_ms?` | Delivers a phone-app message through the debug channel. The app stores it as `last_phone_message`; read it back with `state_read`. |

Storage values are app-specific. The reference app uses `onboarding_complete`, `premium`, `deck_list`, `stats`, `settings` and `active_deck_id`; its properties are `daily_goal`, `reveal_behavior`, `auto_advance`, `card_order`, `premium_enabled` and `deck_data`.

### Device matrix and calibration

| Tool | Parameters | Behaviour |
|---|---|---|
| `matrix_run` | `project_dir`, `devices[]`, `baseline_dir?`, `output_dir?`, `update_baselines?`, `wait_ms?`, `settle_ms?`, `threshold?`, `jungle_file?`, `developer_key_path?`, `debug_channel?` (true), `reset_before_each?` (true), `isolated?` (true on Windows), `steps?[]` | Builds, runs and captures each device, then optionally runs up to 20 `button`, `tap`, `swipe`, `hold` or `wait` steps with a baseline per step. Launches isolated on Windows by default. |
| `matrix_diff` | `baseline_dir`, `output_dir?`, `threshold?` | Compares every baseline PNG with its current counterpart. Returns matched, differing and missing counts plus changed percentage and bounds. |
| `calibrate` | `device_id?`, `save_path?`, `verify?`, `grid?` (2 to 5) | Reports window, bezel, display and button geometry. With `verify`, taps a grid on touch devices and reports changed pixels at each point. |

Matrix runs are sequential because one simulator and one device are active at a time. Each device switches the simulator, so expect a window resize between captures. Matrix scenarios run in the same isolated desktop, so button and touch steps need no foreground window.

### App file snapshots

| Tool | Parameters | Behaviour |
|---|---|---|
| `snapshot_app_files` | `directory`, `app_names[]` | Backs up matching files from simulator `GARMIN/APPS` with a checksum manifest. Use an idle or stopped app. |
| `restore_app_files` | `directory`, `app_names[]`, `confirm_stopped` (literal true) | Restores the snapshot and removes matching files created since. Destructive within that scope. |

Snapshot scope: 1 to 8 uppercase PRG basenames without extensions or separators, for example `["MYAPP"]`. Covers `DATA/<APP>.{DAT,IDX,IMT}`, `SETTINGS/<APP>.SET`, `MEDIA/<APP>.PRG`, and `DATA/{MEDIA/OBJSTORE,OBJSTORE}/<APP>/`. Does not include `GARMIN/sys.nfm`.

## Screenshots and coordinates

- Device geometry comes from `Devices/<device_id>/simulator.json`. The display box is `display.location`; buttons are `keys[].location`.
- `view: "screen"` is the display bounding box at 1:1 device pixels, which is the coordinate space for `tap_screen` and `hold_screen`.
- On round watches the square crop includes bezel in the corners. That is expected geometry, not a misaligned crop.
- `annotated` is for checking alignment after a window resize or device change.
- The Windows bridge uses the live client-area offset and DPI scale. The macOS bridge uses a 28px title bar assumption. Do not hardcode either.

## Safety

- `stop_app` is not proof that background writes stopped. `terminate_simulator` is the only reliable shutdown, and it does not delete stored data.
- `restore_app_files` is destructive inside its app scope and needs `confirm_stopped: true`; the flag is caller confirmation, not an idle check.
- `run_unit_tests` must see a full passing table. Incomplete output is not a pass.
- OCR and screenshot diffs are evidence, not functional proof.
- Do not use `force: true` on `terminate_simulator` while an app is writing storage unless you accept the risk.
- `list_windows`, `capture_window`, `close_window` and `reset_state` use the Windows bridge; the macOS bridge still covers the main window only.

## Client configuration

Use an absolute path to `dist/index.js`. On Windows use forward slashes or escaped backslashes.

Claude Desktop, Cursor and Antigravity share the same shape:

```json
{
  "mcpServers": {
    "garmin-emulator": {
      "command": "node",
      "args": ["/path/to/garmin-simulator-mcp/dist/index.js"]
    }
  }
}
```

OpenCode V2, via the CLI:

```bash
opencode mcp add garmin-emulator --global -- node /path/to/garmin-simulator-mcp/dist/index.js
```

Or under `mcp.servers` in `~/.config/opencode/opencode.jsonc`:

```json
{
  "mcp": {
    "servers": {
      "garmin-emulator": {
        "type": "local",
        "command": ["node", "/path/to/garmin-simulator-mcp/dist/index.js"]
      }
    }
  }
}
```

## Development

```bash
npm test                 # 8 regression suites
npm run typecheck:test   # type-check the test project
npm run test:e2e         # live simulator check, presses a button
```
