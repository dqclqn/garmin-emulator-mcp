import { focusSimulatorWindow, restoreFocus, type FocusResponse } from "../simulator/bridge.js";

/**
 * Raised when Windows refuses to give the simulator foreground. Carries the
 * blocking window so the caller can report something actionable.
 */
export class InputFocusError extends Error {
  readonly code = "E_FOCUS_DENIED";
  readonly detail: FocusResponse;

  constructor(detail: FocusResponse) {
    super(detail.error ?? "Windows did not focus the simulator");
    this.name = "InputFocusError";
    this.detail = detail;
  }
}

export interface InputLease {
  previousForegroundWindowId?: number;
  simulatorWindowId?: number;
  path?: string;
}

/**
 * Takes foreground for the simulator before a batch of input. One lease covers
 * a whole sequence so focus is not reacquired for every button.
 */
export async function acquireInputLease(): Promise<InputLease> {
  const response = await focusSimulatorWindow();
  if (!response.ok) {
    throw new InputFocusError(response);
  }
  return {
    previousForegroundWindowId: response.previousForegroundWindowId,
    simulatorWindowId: response.windowId,
    path: response.path
  };
}

/**
 * Restores the window that had focus before the lease. Best effort: a refused
 * restore never fails the input call that already succeeded.
 */
export async function releaseInputLease(
  lease: InputLease | undefined,
  options?: { restore?: boolean }
): Promise<void> {
  if (!lease || options?.restore === false) return;
  const previous = lease.previousForegroundWindowId;
  if (!previous || previous === lease.simulatorWindowId) return;
  try {
    await restoreFocus(previous);
  } catch {
    // Focus restoration is a courtesy, not a correctness requirement.
  }
}

/**
 * Formats a focus failure for a tool result.
 */
export function describeFocusFailure(error: unknown): string {
  if (error instanceof InputFocusError) {
    const detail = error.detail;
    const blocker =
      detail.blockerTitle && !detail.blockerTitle.startsWith("(")
        ? ` Blocking window: "${detail.blockerTitle}" (pid ${detail.blockerPid ?? "unknown"}).`
        : "";
    return `${error.message}${blocker} [${error.code}]`;
  }
  return error instanceof Error ? error.message : String(error);
}
