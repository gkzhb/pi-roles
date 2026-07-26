/**
 * pi-roles extension entry point.
 *
 * Wires together discovery (roles.ts), application (apply.ts), and settings
 * (settings.ts) into the three Pi integration points the role lifecycle
 * actually needs:
 *
 *   - `session_start` — restore the current session's persisted role on
 *     reload/resume. For a new session, resolve an explicit persisted reset
 *     request first, then (when configured) preserve the previous session's
 *     active role, otherwise use --role > PI_ROLE > defaultRole > built-in.
 *     New-session transfer reads `previousSessionFile`; Pi recreates the
 *     extension instance during session replacement, so in-memory state is
 *     intentionally never used as a cross-session handoff.
 *   - `before_agent_start` — re-inject the active role's body as the system
 *     prompt every turn (Pi rebuilds the prompt per turn; this is the
 *     stable hook).
 *   - `/role` command — list, current, reload, switch (with optional
 *     --reset to clear history first).
 *
 * The module-scoped state below is the source of truth for "what role is
 * live in this extension instance". Pi reloads spin up a fresh module, at
 * which point we restore from the most recent `pi-roles:active-role` entry
 * in the session log.
 */

import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { applyRole, effectiveIntercomMode, resetSession, type RoleNotificationDetails } from "./apply.ts";
import { intercomPromptAddendum, isIntercomAvailable } from "./intercom.ts";
import { discoverRoles, findBuiltInAssistant, resolveRole, RoleResolutionError } from "./roles.ts";
import {
  ACTIVE_ROLE_ENTRY_TYPE,
  BUILTIN_ROLE_ASSISTANT_NAME,
  RESET_ROLE_CANCELLED_ENTRY_TYPE,
  RESET_ROLE_REQUEST_ENTRY_TYPE,
  ROLE_NOTIFICATION_MESSAGE_TYPE,
  type ActiveRoleState,
  type PiRolesSettings,
  type RawRole,
  type ResolvedRole,
  type ResetRoleRequest,
} from "./schemas.ts";
import { loadSettings } from "./settings.ts";
import { generateAndApplyTitle } from "./title.ts";
import { debugLog } from "./debug.ts";

const FLAG_NAME = "role";
const ENV_VAR = "PI_ROLE";
const SUBCOMMANDS = ["list", "current", "reload"] as const;
const PROCESS_TRANSFER_KEY = Symbol.for("pi-roles.previous-session-transfer");

type ProcessTransferStore = Map<string, PreviousSessionRoleState>;

/**
 * Pi intentionally defers creating a session file until its first assistant
 * response. A `/new` before that response therefore has a previous file path
 * but no on-disk custom entries to read. Keep a process-local bridge for this
 * narrow gap; persisted session entries remain the durable source otherwise.
 */
function processTransferStore(): ProcessTransferStore {
  const root = globalThis as typeof globalThis & { [PROCESS_TRANSFER_KEY]?: ProcessTransferStore };
  return (root[PROCESS_TRANSFER_KEY] ??= new Map());
}

function storeProcessTransfer(sessionFile: string | undefined, state: PreviousSessionRoleState): void {
  if (sessionFile) processTransferStore().set(sessionFile, state);
}

function takeProcessTransfer(sessionFile: string | undefined): PreviousSessionRoleState | undefined {
  if (!sessionFile) return undefined;
  const store = processTransferStore();
  const state = store.get(sessionFile);
  store.delete(sessionFile);
  return state;
}

function discardProcessTransfer(sessionFile: string | undefined): void {
  if (sessionFile) processTransferStore().delete(sessionFile);
}

interface RuntimeState {
  /** Live role applied to this session, or null before first apply. */
  activeRole: ResolvedRole | null;
  /**
   * Explicit reset requested in this still-live instance. It is copied into
   * the process bridge by session_before_switch, then read by the replacement
   * instance if Pi has not yet created the old session file.
   */
  pendingResetRequest: ResetRoleRequest | undefined;
  /** Cached discovery result; refreshed on session_start, every `/role` invocation, and `/role reload`. */
  roles: RawRole[];
  /** Shadowed roles found at lower-precedence scopes; shown in `/role list`. */
  shadowed: { name: string; source: string; path: string }[];
  /** Cached settings for the current cwd; refreshed on session_start. */
  settings: PiRolesSettings;
  /** Carried across role swaps so the session-name intent survives a role change. */
  intent: string | undefined;
  /**
   * True while a title-generation request is in flight. Prevents
   * `before_agent_start` from spawning a second concurrent summarization
   * if it fires again before the first resolves. Reset to false in
   * `generateAndApplyTitle`'s finally block.
   */
  titleInFlight: boolean;
  /**
   * True after we've shown the one-time title-generation error hint.
   * Prevents spamming the user on every prompt when the title model
   * is misconfigured or lacks credentials.
   */
  titleErrorShown: boolean;
}

export default function (pi: ExtensionAPI): void {
  const state: RuntimeState = {
    activeRole: null,
    pendingResetRequest: undefined,
    roles: [],
    shadowed: [],
    settings: {},
    intent: undefined,
    titleInFlight: false,
    titleErrorShown: false,
  };

  /** Re-read settings + re-discover roles from disk. Centralized so every */
  /** entry point that needs fresh state ({@link session_start}, every `/role` */
  /** invocation, `/role reload`) goes through one path. */
  const refreshFromDisk = (cwd: string): void => {
    state.settings = loadSettings(cwd);
    const discovery = discoverRoles(cwd, state.settings.roleScope ?? "both");
    state.roles = discovery.roles;
    state.shadowed = discovery.shadowed;
  };

  // --------------------------------------------------------------------- flag
  pi.registerFlag(FLAG_NAME, {
    type: "string",
    description: "Launch as the named pi-roles role (e.g. --role architect).",
  });

  // ----------------------------------------------------------------- renderer
  // Render "Switched to role X" notifications as a single dim line. Without
  // this, the custom message type would surface as raw JSON in the TUI.
  pi.registerMessageRenderer<RoleNotificationDetails>(ROLE_NOTIFICATION_MESSAGE_TYPE, () => {
    // Returning `undefined` lets Pi fall back to the default custom-message
    // renderer, which prints `content`. That's exactly what we want — the
    // content string ("Switched to role X") is already user-facing. The
    // renderer is registered so `display: true` doesn't get treated as a
    // raw-JSON dump if a future Pi version starts requiring an explicit
    // renderer for custom types.
    return undefined;
  });

  // Capture an in-process transfer snapshot before Pi destroys this extension
  // instance. It is consumed only when the replacement session cannot read
  // its previous role state from disk (the no-assistant-response case).
  pi.on("session_before_switch", (event, ctx) => {
    if (event.reason !== "new") return;
    storeProcessTransfer(ctx.sessionManager.getSessionFile(), {
      activeRole: state.activeRole ? activeRoleStateFromResolved(state.activeRole, state.intent) : undefined,
      pendingResetRole: state.pendingResetRequest,
    });
  });

  // --------------------------------------------------------------- session_start
  pi.on("session_start", async (event, ctx) => {
    refreshFromDisk(ctx.cwd);

    const restored = findRestoredState(ctx);
    const diskPrevious =
      event.reason === "new" ? findPreviousSessionRoleState(event.previousSessionFile) : undefined;
    const memoryPrevious =
      event.reason === "new" ? takeProcessTransfer(event.previousSessionFile) : undefined;
    const previous = pickPreviousSessionRoleState(diskPrevious, memoryPrevious);
    debugLog("index", `session_start reason=${event.reason}`, {
      restored: restored ? { name: restored.name, intent: restored.intent } : undefined,
      previousActiveRole: previous?.activeRole?.name,
      previousResetRole: previous?.pendingResetRole?.name,
    });

    // `reload` and `resume` restore state belonging to the current session.
    // A `new` session has a fresh extension instance, so it can only inherit
    // from entries read through `previousSessionFile`.
    let targetName: string;
    let preservedIntent: string | undefined;
    let silent = false;

    if ((event.reason === "reload" || event.reason === "resume") && restored) {
      targetName = restored.name;
      preservedIntent = restored.intent;
      silent = true;
    } else if (event.reason === "new" && previous?.pendingResetRole) {
      // An explicit `/role <name> --reset` request always wins over ordinary
      // preservation and normal initial-role resolution. A reset is fresh,
      // therefore it deliberately does not carry the old intent/title.
      targetName = previous.pendingResetRole.name;
    } else if (event.reason === "new") {
      targetName = pickNewSessionRoleName(
        previous?.activeRole ?? null,
        pi,
        state.settings,
        state.roles,
      );
    } else {
      targetName = pickInitialRoleName(pi, state.settings, state.roles);
      // First-application is silent — the user knows what they launched
      // with; a banner here would be noise.
      silent = event.reason === "startup";
    }

    state.intent = preservedIntent;
    await applyResolved(pi, ctx, state, targetName, { silent, preservedIntent });
  });

  // ----------------------------------------------------------- before_agent_start
  // Full replacement: the role body IS the system prompt for this turn.
  //
  // We intentionally ignore `event.systemPrompt` (Pi's default coding-assistant
  // framing plus anything earlier extensions in the chain produced). The
  // founding goal of pi-roles is to make the role body authoritative — a
  // non-coding role (marketing, research, ops) must not inherit the default
  // "expert coding assistant" voice or it stops behaving like its description.
  //
  // Pi's docstring on BeforeAgentStartEventResult.systemPrompt says exactly
  // "Replace the system prompt for this turn"; that is what we do.
  // Subsequent extensions in the chain see our value as their
  // event.systemPrompt and may compose if they choose.
  //
  // Side effect — title generation. When this is the first prompt of the
  // session (no intent persisted yet), kick off an async summarization to
  // populate the session-name "intent" half. We don't await: the agent
  // loop should start immediately, and the session name update can race
  // independently. `generateAndApplyTitle` handles guards (already-set,
  // already-running, no-model) internally.
  pi.on("before_agent_start", async (event, ctx) => {
    debugLog("index", "before_agent_start fired", {
      hasActiveRole: !!state.activeRole,
      hasIntent: !!state.intent,
      inFlight: state.titleInFlight,
      promptLen: event?.prompt?.length ?? 0,
      ctxModelId: (ctx as any)?.model?.id,
    });
    if (
      state.activeRole &&
      !state.intent &&
      !state.titleInFlight &&
      event.prompt &&
      event.prompt.trim().length > 0
    ) {
      debugLog("index", "triggering title generation", { promptPreview: event.prompt.slice(0, 80), model: state.settings.titleModel });
      void generateAndApplyTitle({
        prompt: event.prompt,
        state,
        pi,
        ctx,
        configuredTitleModel: state.settings.titleModel,
      });
    }
    return composeSystemPrompt(state, pi);
  });

  // ---------------------------------------------------------------- /role
  pi.registerCommand("role", {
    description: "Switch session role. /role list | current | reload | <name> [--reset]",
    getArgumentCompletions: (prefix) => roleCompletions(prefix, state.roles),
    handler: async (args, ctx) => {
      // README guarantees "/role <name> always re-reads from disk". Refresh
      // before any subcommand so /list shows new files and /<name> picks up
      // edits without an explicit /role reload.
      refreshFromDisk(ctx.cwd);

      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0];

      if (!sub || sub === "list") {
        return handleList(ctx, state);
      }
      if (sub === "current") {
        return handleCurrent(ctx, state);
      }
      if (sub === "reload") {
        return handleReload(pi, ctx, state);
      }

      const wantsReset = tokens.includes("--reset");
      const name = sub;

      if (wantsReset) {
        // Pi replaces the extension instance during newSession(). Persist the
        // requested target in the old session before replacement; the new
        // instance reads it via event.previousSessionFile in session_start.
        const request: ResetRoleRequest = { name, requestedAt: Date.now() };
        state.pendingResetRequest = request;
        pi.appendEntry<ResetRoleRequest>(RESET_ROLE_REQUEST_ENTRY_TYPE, request);
        const result = await resetSession(ctx);
        if (result.cancelled) {
          state.pendingResetRequest = undefined;
          discardProcessTransfer(ctx.sessionManager.getSessionFile());
          // Session replacement did not happen, so the old Pi API/context is
          // still valid. The final reset lifecycle event being "cancelled"
          // makes the earlier request ineligible for a later /new.
          pi.appendEntry(RESET_ROLE_CANCELLED_ENTRY_TYPE, { cancelledAt: Date.now() });
          ctx.ui.notify(`Role switch to "${name}" cancelled.`, "info");
        }
        return;
      }

      await applyResolved(pi, ctx, state, name, { silent: false, preservedIntent: state.intent });
    },
  });
}

// ---------------------------------------------------------------------------
// Role-name resolution
// ---------------------------------------------------------------------------

/**
 * Build the replacement system prompt for the current active role.
 *
 * Returns `undefined` when there's no active role (Pi keeps its default for
 * that turn). Otherwise returns `{ systemPrompt }` with the role body — and,
 * when intercom is requested AND the intercom tool is registered, a small
 * mode-specific addendum appended to the body.
 *
 * Exported for unit tests; the handler in `before_agent_start` is a one-line
 * delegation.
 */
export function composeSystemPrompt(
  state: Pick<RuntimeState, "activeRole" | "settings">,
  pi: Pick<ExtensionAPI, "getAllTools" | "getSessionName">,
): { systemPrompt: string } | undefined {
  if (!state.activeRole) return undefined;
  const body = state.activeRole.body;
  const mode = effectiveIntercomMode(state.activeRole, state.settings.intercomMode);
  const addendum =
    mode !== "off" && isIntercomAvailable(pi as ExtensionAPI)
      ? intercomPromptAddendum(mode, pi.getSessionName())
      : "";
  const parts = [body, addendum].filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;
  return { systemPrompt: parts.join("\n\n") };
}

/**
 * Pick the role for an ordinary new conversation. `activeRole` must come
 * from the previous session's persisted state, not the current extension
 * instance: Pi recreates extensions for `/new`. An explicit --reset role is
 * resolved before this helper is reached.
 */
export function pickNewSessionRoleName(
  activeRole: Pick<ResolvedRole, "name"> | null,
  pi: ExtensionAPI,
  settings: PiRolesSettings,
  roles: RawRole[],
): string {
  if (settings.preserveRoleOnNewSession && activeRole) return activeRole.name;
  return pickInitialRoleName(pi, settings, roles);
}

/**
 * Pick the role to launch with on a fresh session_start (no persisted
 * previous-session override). Precedence per BUILD-STATUS.md:
 *
 *   --role flag > PI_ROLE env > settings.defaultRole > built-in role-assistant
 *
 * If a configured `defaultRole` doesn't exist, we fall through to the
 * built-in rather than failing — a missing role shouldn't lock the user out
 * of the session.
 */
export function pickInitialRoleName(
  pi: ExtensionAPI,
  settings: PiRolesSettings,
  roles: RawRole[],
): string {
  const flagValue = pi.getFlag(FLAG_NAME);
  if (typeof flagValue === "string" && flagValue.length > 0) return flagValue;

  const env = process.env[ENV_VAR];
  if (env && env.length > 0) return env;

  const configured = settings.defaultRole;
  if (configured && roles.some((r) => r.frontmatter.name === configured)) {
    return configured;
  }

  return BUILTIN_ROLE_ASSISTANT_NAME;
}

/**
 * Find the most recent `pi-roles:active-role` entry on the active branch.
 * Returns undefined when none exists or when entries can't be enumerated
 * (e.g. session_start hasn't fully bound the session manager yet).
 */
function findRestoredState(
  ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
): ActiveRoleState | undefined {
  let entries: SessionEntry[];
  try {
    entries = ctx.sessionManager.getEntries();
  } catch {
    return undefined;
  }
  return findActiveRoleState(entries);
}

/**
 * Select previous-session state for a new extension instance. A session with
 * no assistant response has no persisted custom entries yet, so an empty disk
 * result must yield to the process bridge. Once disk contains role state it
 * remains authoritative.
 */
export function pickPreviousSessionRoleState(
  diskState: PreviousSessionRoleState | undefined,
  processState: PreviousSessionRoleState | undefined,
): PreviousSessionRoleState | undefined {
  return hasPreviousRoleState(diskState) ? diskState : processState ?? diskState;
}

function hasPreviousRoleState(
  state: PreviousSessionRoleState | undefined,
): state is PreviousSessionRoleState {
  return !!state && (!!state.activeRole || !!state.pendingResetRole);
}

function activeRoleStateFromResolved(
  role: ResolvedRole,
  intent: string | undefined,
): ActiveRoleState {
  return {
    name: role.name,
    source: role.source,
    path: role.path,
    intent,
    appliedAt: Date.now(),
  };
}

/** State that a replacement session may inherit from its previous session. */
export interface PreviousSessionRoleState {
  activeRole: ActiveRoleState | undefined;
  /** Present only when the final reset lifecycle event is a valid request. */
  pendingResetRole: ResetRoleRequest | undefined;
}

/**
 * Read transferable state from an earlier session file. Session files may be
 * missing, corrupted, or unavailable in ephemeral modes; those cases simply
 * disable inheritance and fall back to ordinary initial resolution.
 */
export function findPreviousSessionRoleState(
  previousSessionFile: string | undefined,
): PreviousSessionRoleState | undefined {
  if (!previousSessionFile) return undefined;
  try {
    return resolvePreviousSessionRoleState(SessionManager.open(previousSessionFile).getEntries());
  } catch (err) {
    debugLog("index", `could not read previous session ${previousSessionFile}`, String(err));
    return undefined;
  }
}

/**
 * Interpret entries from a previous session for a fresh `reason="new"`
 * session. Exported as a pure test seam: the runtime reader above only opens
 * the file, while this function contains the lifecycle semantics.
 *
 * Reset events are intentionally an ordered two-event protocol without a
 * requestId. The final reset lifecycle event is authoritative: cancellation
 * suppresses every earlier request; a valid final request overrides ordinary
 * role preservation.
 */
export function resolvePreviousSessionRoleState(
  entries: readonly SessionEntry[],
): PreviousSessionRoleState {
  let pendingResetRole: ResetRoleRequest | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== "custom") continue;
    if (entry.customType === RESET_ROLE_CANCELLED_ENTRY_TYPE) break;
    if (entry.customType === RESET_ROLE_REQUEST_ENTRY_TYPE) {
      const request = asResetRoleRequest(entry.data);
      if (request) pendingResetRole = request;
      break;
    }
  }

  return { activeRole: findActiveRoleState(entries), pendingResetRole };
}

function findActiveRoleState(entries: readonly SessionEntry[]): ActiveRoleState | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "custom" && entry.customType === ACTIVE_ROLE_ENTRY_TYPE) {
      const state = asActiveRoleState(entry.data);
      if (state) return state;
    }
  }
  return undefined;
}

function asActiveRoleState(data: unknown): ActiveRoleState | undefined {
  if (!data || typeof data !== "object") return undefined;
  const candidate = data as Partial<ActiveRoleState>;
  if (
    typeof candidate.name !== "string" ||
    candidate.name.length === 0 ||
    typeof candidate.source !== "string" ||
    typeof candidate.path !== "string" ||
    typeof candidate.appliedAt !== "number" ||
    (candidate.intent !== undefined && typeof candidate.intent !== "string")
  ) {
    return undefined;
  }
  return candidate as ActiveRoleState;
}

function asResetRoleRequest(data: unknown): ResetRoleRequest | undefined {
  if (!data || typeof data !== "object") return undefined;
  const candidate = data as Partial<ResetRoleRequest>;
  if (
    typeof candidate.name !== "string" ||
    candidate.name.trim().length === 0 ||
    typeof candidate.requestedAt !== "number"
  ) {
    return undefined;
  }
  return { name: candidate.name, requestedAt: candidate.requestedAt };
}

// ---------------------------------------------------------------------------
// Apply wrapper
// ---------------------------------------------------------------------------

/**
 * Resolve a role name + apply it + update in-memory state. Centralized so
 * session_start, /role <name>, and /role reload share identical error
 * handling and warning surfacing.
 */
async function applyResolved(
  pi: ExtensionAPI,
  ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
  state: RuntimeState,
  name: string,
  options: { silent: boolean; preservedIntent: string | undefined },
): Promise<void> {
  let resolved: ResolvedRole;
  try {
    resolved = resolveRole(name, state.roles);
  } catch (err) {
    const message = err instanceof RoleResolutionError ? err.message : String(err);
    debugLog("index", `applyResolved fallback: ${message}`);
    // Fall back to built-in assistant if the requested role is missing or
    // broken. Surface the underlying error so the user can fix the file.
    if (ctx.hasUI) {
      ctx.ui.notify(`pi-roles: ${message} Falling back to ${BUILTIN_ROLE_ASSISTANT_NAME}.`, "warning");
    }
    const fallback = findBuiltInAssistant(state.roles);
    if (!fallback) {
      // Built-in is missing too — bail without changing session state.
      return;
    }
    resolved = resolveRole(BUILTIN_ROLE_ASSISTANT_NAME, state.roles);
  }

  const result = await applyRole(
    resolved,
    {
      pi,
      ctx,
      warnOnMissingMcp: state.settings.warnOnMissingMcp ?? true,
      intercomMode: state.settings.intercomMode,
    },
    options,
  );

  state.activeRole = resolved;
  state.intent = result.state.intent;
  debugLog("index", `applied role=${resolved.name}`, { intent: result.state.intent, warnings: result.warnings });

  if (ctx.hasUI && result.warnings.length > 0 && !options.silent) {
    // The notification message already mentions the warning count; surface
    // the actual text via ui.notify so the user sees what to fix without
    // expanding the message.
    for (const w of result.warnings) ctx.ui.notify(`pi-roles: ${w}`, "warning");
  }
}

// ---------------------------------------------------------------------------
// /role subcommands
// ---------------------------------------------------------------------------

async function handleList(
  ctx: ExtensionCommandContext,
  state: RuntimeState,
): Promise<void> {
  if (state.roles.length === 0) {
    ctx.ui.notify(
      "pi-roles: no roles found. Create one in .pi/roles/ or ~/.pi/agent/roles/.",
      "info",
    );
    return;
  }
  const lines = state.roles
    .slice()
    .sort((a, b) => a.frontmatter.name.localeCompare(b.frontmatter.name))
    .map((r) => {
      const marker = state.activeRole?.name === r.frontmatter.name ? "* " : "  ";
      return `${marker}${r.frontmatter.name} [${r.source}] — ${r.frontmatter.description}`;
    });
  const shadowed = state.shadowed.map(
    (s) => `  ${s.name} [${s.source}] (shadowed) — ${s.path}`,
  );
  const all =
    shadowed.length > 0
      ? ["Available roles:", ...lines, "", "Shadowed (lower-priority duplicates):", ...shadowed]
      : ["Available roles:", ...lines];
  ctx.ui.notify(all.join("\n"), "info");
}

async function handleCurrent(
  ctx: ExtensionCommandContext,
  state: RuntimeState,
): Promise<void> {
  if (!state.activeRole) {
    ctx.ui.notify("pi-roles: no role active.", "info");
    return;
  }
  const r = state.activeRole;
  const chain = r.extendsChain.length > 1 ? ` (extends: ${r.extendsChain.slice(1).join(" → ")})` : "";
  ctx.ui.notify(`pi-roles: ${r.name}${chain} — ${r.description}\n${r.path}`, "info");
}

async function handleReload(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: RuntimeState,
): Promise<void> {
  // Disk re-read already happened in the command handler prelude; just
  // re-apply against the freshly discovered set.
  const previous = state.activeRole?.name ?? pickInitialRoleName(pi, state.settings, state.roles);
  await applyResolved(pi, ctx, state, previous, {
    silent: false,
    preservedIntent: state.intent,
  });
}

// ---------------------------------------------------------------------------
// Autocompletion
// ---------------------------------------------------------------------------

/**
 * Provide tab completions for `/role <here>`. Combines built-in subcommands
 * with discovered role names; case-insensitive prefix match.
 */
export function roleCompletions(prefix: string, roles: RawRole[]): AutocompleteItem[] | null {
  const needle = prefix.toLowerCase();
  const items: AutocompleteItem[] = [];

  for (const sub of SUBCOMMANDS) {
    if (sub.toLowerCase().startsWith(needle)) {
      items.push({ value: sub, label: sub, description: subcommandDescription(sub) });
    }
  }
  for (const r of roles) {
    if (r.frontmatter.name.toLowerCase().startsWith(needle)) {
      items.push({
        value: r.frontmatter.name,
        label: r.frontmatter.name,
        description: `${r.source} — ${r.frontmatter.description}`,
      });
    }
  }
  return items.length > 0 ? items : null;
}

function subcommandDescription(sub: (typeof SUBCOMMANDS)[number]): string {
  switch (sub) {
    case "list":
      return "Show all available roles.";
    case "current":
      return "Show the active role.";
    case "reload":
      return "Re-read the active role file from disk.";
  }
}
