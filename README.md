# Garmin Simulator MCP

```text
                                      █████████
                               ████████·······████████
                           █████·····················█████
                 LIGHT ▐ ████··┌─────────────────────┐··████ ▌ START
                       ████····│        M C P        │····████
                      ████·····│                     │·····████
                      ███······│      > ready_       │······███
                UP ▐ ████······│                     │······████
                      ███······│                     │······███ ▌ BACK
                      ████·····│      build  run     │·····████
                       ████····│                     │····████
                  DOWN ▐ ████··└─────────────────────┘··████
                           █████·····················█████
                               ████████·······████████
                                      █████████
```

Watch apps are awkward to test. The screen is tiny, there is no keyboard, and the simulator expects a human with a mouse. This puts the simulator behind an MCP server so an AI coding agent can run the same loop you would: build, look, press, look again, read the log.

## What it does

| Capability | What you get |
| :--- | :--- |
| Build | Compiles a Monkey C project with the Garmin SDK and loads it into the simulator. |
| Drive | Presses the physical buttons, taps, swipes and long-presses the watch screen. |
| Isolate | Runs the simulator on a hidden desktop, so it never takes over your screen. |
| Inspect | Screenshots of the watch display, the bezel, or an annotated debug view. |
| Read | App logs and crash output streamed back to the agent. |
| Check | SDK, device profiles, signing key and simulator state before every run. |
| State | Reads and seeds app storage and debug property overrides, resets data and moves the app clock. |
| Message | Sends a phone-app message into the app and reads the stored payload back. |
| Coverage | Builds and captures the same screen on several devices at once. |

## The loop

| Step | What happens |
| :--- | :--- |
| 1 | The agent checks the setup and launches the simulator. |
| 2 | It builds your project and runs it on the selected device. |
| 3 | It presses through the screens you describe. |
| 4 | It looks at the result and reads the logs. |
| 5 | It repeats until the screen matches what you wanted. |

## Requirements

| Need | Why |
| :--- | :--- |
| Node.js 18 or later | Runs the server. |
| Java | Runs the Garmin compiler. |
| Connect IQ SDK Manager | Provides the SDK, simulator and device profiles. |
| A developer signing key | Signs your app for the simulator. |
| macOS 13 or Windows with PowerShell 5.1 | Supported hosts. Windows uses a hidden desktop by default; an unlocked desktop is only needed for the visible fallback. |

## Quick start

| Step | Command |
| :--- | :--- |
| Install | `npm install` |
| Build | `npm run build` |
| Connect | Point your MCP client at `dist/index.js`. |

Ask the agent to check the setup, launch the simulator, build your project and take a screenshot. Setup examples for common clients are in [AGENT-README.md](AGENT-README.md).

## Good to know

| Topic | Detail |
| :--- | :--- |
| One at a time | One simulator, one server. A second instance refuses to start so two agents cannot fight over the same device. |
| Focus | Button presses need an unlocked, interactive desktop. Screenshots, logs and menu actions keep working in the background. |
| Best effort | The watch screen is not exposed as native controls, so the server verifies each press by comparing screenshots. |
| Local state | Session logs and captures are written under your app data folder, not into the project. |

## Agent reference

[AGENT-README.md](AGENT-README.md) lists every MCP tool and its parameters.

## License

Apache-2.0.
