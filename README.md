# Garmin Simulator MCP

A local bridge that lets an AI coding agent drive the Garmin Connect IQ Simulator while you work on a watch app. The agent can build and run your app, press the watch buttons, tap and swipe the screen, read the logs, and take screenshots, so you can describe what you want and see the result without clicking through the simulator yourself.

## What it does

- Builds a Monkey C project with the Garmin SDK and runs it on the simulator.
- Presses the physical buttons, taps, swipes and long-presses the watch screen.
- Captures the watch display, the bezel, or an annotated debug view.
- Streams app logs and crash output back to the agent.
- Checks the local setup first: SDK, device profiles, signing key, simulator state.
- Covers the whole loop: launch the simulator, build, run, interact, inspect, repeat.

## Why

Watch apps are awkward to test. The screen is tiny, there is no keyboard, and the simulator expects a human with a mouse. Putting it behind an MCP server lets an agent run the same loop you would: build, look, press, look again, read the log.

## Requirements

- Node.js 18 or later, and Java for the Garmin compiler.
- The Garmin Connect IQ SDK Manager with an SDK and device profiles installed.
- A developer signing key for your app.
- macOS 13 or later, or Windows with PowerShell 5.1 and an interactive desktop session.

## Quick start

```bash
npm install
npm run build
```

Then point your MCP client at `dist/index.js` and start a session. Ask the agent to check the setup, launch the simulator, build your project and take a screenshot. Setup examples for common clients are in [AGENT-README.md](AGENT-README.md).

## Good to know

- One simulator, one server at a time. A second instance refuses to start so two agents cannot fight over the same device.
- Pressing buttons needs an unlocked, interactive desktop. Screenshots, logs and menu actions keep working while the window is in the background.
- The agent's UI automation is best effort. The watch app's drawn screen is not exposed as native controls, so the server verifies button presses by comparing screenshots.
- Local session logs and captures are written under your app data folder, not into the project.

## Documentation

- [AGENT-README.md](AGENT-README.md): the agent-facing reference, including every MCP tool and its parameters.
- `docs/`: local design and testing notes, kept out of version control.

## License

Apache-2.0.
