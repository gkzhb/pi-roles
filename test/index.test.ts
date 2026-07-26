/**
 * Phase 4 tests for src/index.ts.
 *
 * Most of index.ts is integration glue around Pi events that's only worth
 * testing end-to-end. The pieces with non-trivial logic — role-name
 * precedence and the autocompletion provider — are exported and tested
 * here directly.
 */

import { describe, expect, it } from "vitest";
import {
  composeSystemPrompt,
  pickInitialRoleName,
  pickNewSessionRoleName,
  resolvePreviousSessionRoleState,
  roleCompletions,
} from "../src/index.ts";
import { parseRoleSource, resolveRole } from "../src/roles.ts";
import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import {
  ACTIVE_ROLE_ENTRY_TYPE,
  RESET_ROLE_CANCELLED_ENTRY_TYPE,
  RESET_ROLE_REQUEST_ENTRY_TYPE,
  type ActiveRoleState,
  type PiRolesSettings,
  type RawRole,
  type ResolvedRole,
} from "../src/schemas.ts";
import { INTERCOM_TOOL_NAME } from "../src/intercom.ts";

function makePi(flags: Record<string, string | boolean | undefined> = {}): ExtensionAPI {
  return {
    getFlag: (name: string) => flags[name],
  } as unknown as ExtensionAPI;
}

function makeRole(name: string, description = "test"): RawRole {
  return parseRoleSource(
    `---\nname: ${name}\ndescription: ${description}\n---\nbody`,
    `/v/${name}.md`,
    "project",
  );
}

const ENV_BACKUP = process.env.PI_ROLE;
function withEnv(value: string | undefined, fn: () => void): void {
  if (value === undefined) delete process.env.PI_ROLE;
  else process.env.PI_ROLE = value;
  try {
    fn();
  } finally {
    if (ENV_BACKUP === undefined) delete process.env.PI_ROLE;
    else process.env.PI_ROLE = ENV_BACKUP;
  }
}

function customEntry(customType: string, data?: unknown): SessionEntry {
  return {
    type: "custom",
    id: `entry-${Math.random()}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    customType,
    data,
  };
}

function activeRoleEntry(name: string, intent?: string): SessionEntry {
  const state: ActiveRoleState = {
    name,
    source: "project",
    path: `/v/${name}.md`,
    appliedAt: Date.now(),
    ...(intent === undefined ? {} : { intent }),
  };
  return customEntry(ACTIVE_ROLE_ENTRY_TYPE, state);
}

// ---------------------------------------------------------------------------
// pickInitialRoleName
// ---------------------------------------------------------------------------

describe("pickInitialRoleName", () => {
  const roles = [makeRole("architect"), makeRole("planner")];

  it("--role flag wins over env, settings, and built-in", () => {
    withEnv("planner", () => {
      const settings: PiRolesSettings = { defaultRole: "planner" };
      expect(pickInitialRoleName(makePi({ role: "architect" }), settings, roles)).toBe(
        "architect",
      );
    });
  });

  it("PI_ROLE env wins when no flag", () => {
    withEnv("planner", () => {
      const settings: PiRolesSettings = { defaultRole: "architect" };
      expect(pickInitialRoleName(makePi(), settings, roles)).toBe("planner");
    });
  });

  it("settings.defaultRole used when no flag/env", () => {
    withEnv(undefined, () => {
      expect(pickInitialRoleName(makePi(), { defaultRole: "architect" }, roles)).toBe(
        "architect",
      );
    });
  });

  it("falls back to built-in when defaultRole missing from disk", () => {
    withEnv(undefined, () => {
      expect(pickInitialRoleName(makePi(), { defaultRole: "ghost" }, roles)).toBe(
        "role-assistant",
      );
    });
  });

  it("falls back to built-in when nothing is set", () => {
    withEnv(undefined, () => {
      expect(pickInitialRoleName(makePi(), {}, roles)).toBe("role-assistant");
    });
  });

  it("ignores empty flag string", () => {
    withEnv("planner", () => {
      expect(pickInitialRoleName(makePi({ role: "" }), {}, roles)).toBe("planner");
    });
  });
});

// ---------------------------------------------------------------------------
// pickNewSessionRoleName
// ---------------------------------------------------------------------------

describe("pickNewSessionRoleName", () => {
  const roles = [makeRole("architect"), makeRole("planner")];

  it("uses the normal initial-role resolution by default", () => {
    withEnv(undefined, () => {
      expect(
        pickNewSessionRoleName({ name: "planner" }, makePi(), { defaultRole: "architect" }, roles),
      ).toBe("architect");
    });
  });

  it("preserves the active role when configured", () => {
    withEnv(undefined, () => {
      expect(
        pickNewSessionRoleName(
          { name: "planner" },
          makePi(),
          { defaultRole: "architect", preserveRoleOnNewSession: true },
          roles,
        ),
      ).toBe("planner");
    });
  });

  it("uses initial-role resolution when preservation is enabled but no role is active", () => {
    withEnv(undefined, () => {
      expect(
        pickNewSessionRoleName(null, makePi(), { preserveRoleOnNewSession: true }, roles),
      ).toBe("role-assistant");
    });
  });
});

// ---------------------------------------------------------------------------
// previous-session role state
// ---------------------------------------------------------------------------

describe("resolvePreviousSessionRoleState", () => {
  it("returns the last valid active role from the previous session", () => {
    const state = resolvePreviousSessionRoleState([
      activeRoleEntry("architect", "Design auth"),
      activeRoleEntry("planner", "Plan auth"),
    ]);

    expect(state.activeRole).toMatchObject({ name: "planner", intent: "Plan auth" });
    expect(state.pendingResetRole).toBeUndefined();
  });

  it("makes an explicit reset request override ordinary preservation", () => {
    const state = resolvePreviousSessionRoleState([
      activeRoleEntry("architect"),
      customEntry(RESET_ROLE_REQUEST_ENTRY_TYPE, { name: "planner", requestedAt: 1 }),
    ]);

    expect(state.activeRole?.name).toBe("architect");
    expect(state.pendingResetRole).toEqual({ name: "planner", requestedAt: 1 });
  });

  it("cancels the preceding reset request when cancellation is the final lifecycle event", () => {
    const state = resolvePreviousSessionRoleState([
      customEntry(RESET_ROLE_REQUEST_ENTRY_TYPE, { name: "planner", requestedAt: 1 }),
      customEntry(RESET_ROLE_CANCELLED_ENTRY_TYPE, { cancelledAt: 2 }),
    ]);

    expect(state.pendingResetRole).toBeUndefined();
  });

  it("uses a later reset request after an earlier cancellation", () => {
    const state = resolvePreviousSessionRoleState([
      customEntry(RESET_ROLE_REQUEST_ENTRY_TYPE, { name: "planner", requestedAt: 1 }),
      customEntry(RESET_ROLE_CANCELLED_ENTRY_TYPE, { cancelledAt: 2 }),
      customEntry(RESET_ROLE_REQUEST_ENTRY_TYPE, { name: "architect", requestedAt: 3 }),
    ]);

    expect(state.pendingResetRole).toEqual({ name: "architect", requestedAt: 3 });
  });

  it("ignores malformed role and reset entries", () => {
    const state = resolvePreviousSessionRoleState([
      customEntry(ACTIVE_ROLE_ENTRY_TYPE, { name: 42 }),
      customEntry(RESET_ROLE_REQUEST_ENTRY_TYPE, { name: "", requestedAt: "now" }),
    ]);

    expect(state.activeRole).toBeUndefined();
    expect(state.pendingResetRole).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// roleCompletions
// ---------------------------------------------------------------------------

describe("roleCompletions", () => {
  const roles = [
    makeRole("architect", "Designs"),
    makeRole("planner", "Plans"),
    makeRole("orchestrator", "Coordinates"),
  ];

  it("empty prefix returns subcommands + all roles", () => {
    const items = roleCompletions("", roles);
    expect(items).not.toBeNull();
    const values = items!.map((i) => i.value);
    expect(values).toContain("list");
    expect(values).toContain("current");
    expect(values).toContain("reload");
    expect(values).toContain("architect");
    expect(values).toContain("planner");
    expect(values).toContain("orchestrator");
  });

  it("prefix narrows results", () => {
    const items = roleCompletions("arc", roles);
    expect(items?.map((i) => i.value)).toEqual(["architect"]);
  });

  it("prefix matches subcommand", () => {
    const items = roleCompletions("re", roles);
    expect(items?.map((i) => i.value)).toEqual(["reload"]);
  });

  it("case insensitive", () => {
    const items = roleCompletions("ARC", roles);
    expect(items?.map((i) => i.value)).toEqual(["architect"]);
  });

  it("returns null when no match", () => {
    expect(roleCompletions("zzz", roles)).toBeNull();
  });

  it("each item has label and description", () => {
    const items = roleCompletions("a", roles);
    expect(items![0]).toMatchObject({
      value: expect.any(String),
      label: expect.any(String),
      description: expect.any(String),
    });
  });
});

// ---------------------------------------------------------------------------
// composeSystemPrompt — replacement contract
// ---------------------------------------------------------------------------

describe("composeSystemPrompt", () => {
  function resolveSingle(name: string, body: string, intercom?: string): ResolvedRole {
    const fm = `---\nname: ${name}\ndescription: x${intercom ? `\nintercom: ${intercom}` : ""}\n---\n${body}`;
    return resolveRole(name, [parseRoleSource(fm, `/v/${name}.md`, "project")]);
  }

  function piWith(toolNames: string[], sessionName?: string): ExtensionAPI {
    return {
      getAllTools: () => toolNames.map((name) => ({ name, description: "", parameters: {} as any, sourceInfo: {} as any })),
      getSessionName: () => sessionName,
    } as unknown as ExtensionAPI;
  }

  it("returns undefined when no active role", () => {
    expect(composeSystemPrompt({ activeRole: null, settings: {} }, piWith([]))).toBeUndefined();
  });

  it("returns role body verbatim, ignoring any upstream system prompt", () => {
    const role = resolveSingle("architect", "You are an architect. Design only.");
    const result = composeSystemPrompt({ activeRole: role, settings: {} }, piWith([]));
    expect(result).toEqual({ systemPrompt: "You are an architect. Design only." });
    // The critical assertion: we didn't compose with Pi's default. There is
    // no path in this function that reads upstream prompt content.
    expect(result?.systemPrompt).not.toMatch(/coding assistant/);
  });

  it("appends intercom addendum when mode!=off and intercom tool is registered", () => {
    const role = resolveSingle("architect", "Body.", "send");
    const result = composeSystemPrompt(
      { activeRole: role, settings: {} },
      piWith([INTERCOM_TOOL_NAME], "architect"),
    );
    expect(result?.systemPrompt).toMatch(/^Body\.\n\n## intercom/);
    expect(result?.systemPrompt).toContain("architect");
  });

  it("omits addendum when intercom tool is not registered", () => {
    const role = resolveSingle("architect", "Body.", "send");
    const result = composeSystemPrompt({ activeRole: role, settings: {} }, piWith([]));
    expect(result).toEqual({ systemPrompt: "Body." });
  });

  it("omits addendum when intercom mode resolves to off", () => {
    const role = resolveSingle("architect", "Body.");
    const result = composeSystemPrompt(
      { activeRole: role, settings: { intercomMode: "off" } },
      piWith([INTERCOM_TOOL_NAME]),
    );
    expect(result).toEqual({ systemPrompt: "Body." });
  });

  it("global settings.intercomMode applies when role doesn't override", () => {
    const role = resolveSingle("architect", "Body.");
    const result = composeSystemPrompt(
      { activeRole: role, settings: { intercomMode: "both" } },
      piWith([INTERCOM_TOOL_NAME], "architect"),
    );
    expect(result?.systemPrompt).toMatch(/intercom \(both modes\)/);
  });
});
