import type { ActiveRoleState, ResetRoleRequest } from "../schemas.ts";

/**
 * State a replacement session may inherit from the previous session.
 *
 * Persisted session entries are authoritative. This process-local state only
 * bridges Pi's pre-first-assistant-response gap, during which the old session
 * has entries in memory but no session file on disk yet.
 */
export interface PreviousSessionRoleState {
  activeRole: ActiveRoleState | undefined;
  /** Present only when the final reset lifecycle event is a valid request. */
  pendingResetRole: ResetRoleRequest | undefined;
}

const PROCESS_TRANSFER_KEY = Symbol.for("pi-roles.previous-session-transfer");
type ProcessTransferStore = Map<string, PreviousSessionRoleState>;

/**
 * Get the process-wide, one-shot session-replacement bridge.
 *
 * A Symbol registry key deliberately makes this survive extension module
 * recreation during `/new`, while keeping it confined to the current Node
 * process. It must never be used as durable session persistence.
 */
function getStore(): ProcessTransferStore {
  const root = globalThis as typeof globalThis & { [PROCESS_TRANSFER_KEY]?: ProcessTransferStore };
  return (root[PROCESS_TRANSFER_KEY] ??= new Map());
}

/** Store state from the old extension instance before a session replacement. */
export function storeProcessTransfer(
  sessionFile: string | undefined,
  state: PreviousSessionRoleState,
): void {
  if (sessionFile) getStore().set(sessionFile, state);
}

/** Read and remove the one-shot transfer state for a replacement session. */
export function takeProcessTransfer(
  sessionFile: string | undefined,
): PreviousSessionRoleState | undefined {
  if (!sessionFile) return undefined;
  const store = getStore();
  const state = store.get(sessionFile);
  store.delete(sessionFile);
  return state;
}

/** Remove stale state after a session-replacement attempt is cancelled. */
export function discardProcessTransfer(sessionFile: string | undefined): void {
  if (sessionFile) getStore().delete(sessionFile);
}
