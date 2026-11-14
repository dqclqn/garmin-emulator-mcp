/**
 * Stable error codes for agent-facing failures. Text still carries the detail,
 * but the code prefix lets callers branch without matching prose.
 */
export const ErrorCodes = {
  SIMULATOR_NOT_RUNNING: "E_SIMULATOR_NOT_RUNNING",
  SIMULATOR_START_FAILED: "E_SIMULATOR_START_FAILED",
  BUILD_FAILED: "E_BUILD_FAILED",
  APP_NOT_LAUNCHED: "E_APP_NOT_LAUNCHED",
  STALE_PRG: "E_STALE_PRG",
  TIMEOUT: "E_TIMEOUT",
  DEVICE_BINDING_REQUIRED: "E_DEVICE_BINDING_REQUIRED",
  SNAPSHOT_FAILED: "E_SNAPSHOT_FAILED",
  STATE_TIMEOUT: "E_STATE_TIMEOUT",
  DIALOG_UNCONFIRMED: "E_DIALOG_UNCONFIRMED",
  TEXT_NOT_FOUND: "E_TEXT_NOT_FOUND",
  INTEGRITY_MISMATCH: "E_INTEGRITY_MISMATCH",
  UNSUPPORTED: "E_UNSUPPORTED",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export function codedError(code: ErrorCode, message: string): string {
  return `${code}: ${message}`;
}
