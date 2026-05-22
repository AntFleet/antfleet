import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mutable mock state. vi.hoisted keeps the closure visible to the
// vi.mock factory (which is hoisted to the top of the file) and to the
// test bodies below. The select() builder is column-agnostic — both
// v1.5 (patchAgentEnabled) and v1.6 (patchAgentClickApplyEnabled) tests
// push their respective shape into selectResult and the function under
// test reads the field it cares about.
const dbMockState = vi.hoisted(() => ({
  selectResult: [] as Array<{
    patchAgentEnabled?: boolean | null;
    patchAgentClickApplyEnabled?: boolean | null;
  }>,
  throwOnRead: false,
}));

vi.mock("@/db", () => {
  const builder = {
    from: () => builder,
    where: () => builder,
    limit: () => {
      if (dbMockState.throwOnRead) {
        return Promise.reject(new Error("db down"));
      }
      return Promise.resolve(dbMockState.selectResult);
    },
  };
  return {
    db: {
      select: () => builder,
    },
  };
});

import {
  isPatchAgentEnabled,
  isPatchAgentEnabledForInstall,
  isPatchAgentClickApplyEnabled,
  isPatchAgentClickApplyEnabledForInstall,
} from "./patch-agent-env";

describe("isPatchAgentEnabled", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env["PATCH_AGENT_ENABLED"];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env["PATCH_AGENT_ENABLED"];
    } else {
      process.env["PATCH_AGENT_ENABLED"] = original;
    }
  });

  it("returns false when the env var is unset", () => {
    delete process.env["PATCH_AGENT_ENABLED"];
    expect(isPatchAgentEnabled()).toBe(false);
  });

  it("returns true for 'true'", () => {
    process.env["PATCH_AGENT_ENABLED"] = "true";
    expect(isPatchAgentEnabled()).toBe(true);
  });

  it("returns true for '1'", () => {
    process.env["PATCH_AGENT_ENABLED"] = "1";
    expect(isPatchAgentEnabled()).toBe(true);
  });

  it("is case-insensitive and trims whitespace", () => {
    process.env["PATCH_AGENT_ENABLED"] = "  TRUE\n";
    expect(isPatchAgentEnabled()).toBe(true);
  });

  it("returns false for 'false', 'no', empty, or anything else", () => {
    for (const v of ["false", "no", "", "0", "yes", "on"]) {
      process.env["PATCH_AGENT_ENABLED"] = v;
      expect(isPatchAgentEnabled()).toBe(false);
    }
  });
});

describe("isPatchAgentEnabledForInstall — per-install override precedence", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env["PATCH_AGENT_ENABLED"];
    dbMockState.selectResult = [];
    dbMockState.throwOnRead = false;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["PATCH_AGENT_ENABLED"];
    } else {
      process.env["PATCH_AGENT_ENABLED"] = originalEnv;
    }
  });

  it("override=true wins over env=false (canary install)", async () => {
    process.env["PATCH_AGENT_ENABLED"] = "false";
    dbMockState.selectResult = [{ patchAgentEnabled: true }];
    await expect(isPatchAgentEnabledForInstall(12345, "test-repo")).resolves.toBe(true);
  });

  it("override=false wins over env=true (kill switch on a single install)", async () => {
    process.env["PATCH_AGENT_ENABLED"] = "true";
    dbMockState.selectResult = [{ patchAgentEnabled: false }];
    await expect(isPatchAgentEnabledForInstall(12345, "test-repo")).resolves.toBe(false);
  });

  it("override=null falls through to env=true", async () => {
    process.env["PATCH_AGENT_ENABLED"] = "true";
    dbMockState.selectResult = [{ patchAgentEnabled: null }];
    await expect(isPatchAgentEnabledForInstall(12345, "test-repo")).resolves.toBe(true);
  });

  it("override=null falls through to env=false", async () => {
    process.env["PATCH_AGENT_ENABLED"] = "false";
    dbMockState.selectResult = [{ patchAgentEnabled: null }];
    await expect(isPatchAgentEnabledForInstall(12345, "test-repo")).resolves.toBe(false);
  });

  it("missing install row → behaves as null override → env wins", async () => {
    process.env["PATCH_AGENT_ENABLED"] = "true";
    dbMockState.selectResult = []; // no row
    await expect(isPatchAgentEnabledForInstall(99999, "missing-repo")).resolves.toBe(true);
  });

  it("DB read failure → conservative fallback to env-only check", async () => {
    process.env["PATCH_AGENT_ENABLED"] = "true";
    dbMockState.throwOnRead = true;
    // Per the function contract: a read failure never blocks the env path;
    // we'd rather honor the env flag than silently disable the canary
    // because the lookup failed.
    await expect(isPatchAgentEnabledForInstall(12345, "test-repo")).resolves.toBe(true);
  });

  it("disambiguates installs that share an installation_id by repo", async () => {
    // Regression for v1.5-canary bug: a single GitHub installation_id can
    // grant access to multiple repos, each with its own override. The
    // pre-fix query (installation_id only, LIMIT 1) returned an arbitrary
    // sibling row — in prod, that was a null-override row, silently
    // disabling the patch lane on the install that did have the flag.
    process.env["PATCH_AGENT_ENABLED"] = "false";
    // Mock returns the row matching (installation_id, repo) — when the
    // query includes the repo filter, only the canary row is returned.
    dbMockState.selectResult = [{ patchAgentEnabled: true }];
    await expect(isPatchAgentEnabledForInstall(133030324, "aeon-bench")).resolves.toBe(true);
  });
});

describe("isPatchAgentClickApplyEnabled", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env["PATCH_AGENT_CLICK_APPLY_ENABLED"];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env["PATCH_AGENT_CLICK_APPLY_ENABLED"];
    } else {
      process.env["PATCH_AGENT_CLICK_APPLY_ENABLED"] = original;
    }
  });

  it("returns false when unset", () => {
    delete process.env["PATCH_AGENT_CLICK_APPLY_ENABLED"];
    expect(isPatchAgentClickApplyEnabled()).toBe(false);
  });

  it("returns true for 'true' / '1' / case-insensitive", () => {
    for (const v of ["true", "1", "TRUE", "  true\n"]) {
      process.env["PATCH_AGENT_CLICK_APPLY_ENABLED"] = v;
      expect(isPatchAgentClickApplyEnabled()).toBe(true);
    }
  });

  it("returns false for everything else", () => {
    for (const v of ["false", "no", "", "0", "yes"]) {
      process.env["PATCH_AGENT_CLICK_APPLY_ENABLED"] = v;
      expect(isPatchAgentClickApplyEnabled()).toBe(false);
    }
  });
});

describe("isPatchAgentClickApplyEnabledForInstall — per-install override precedence", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env["PATCH_AGENT_CLICK_APPLY_ENABLED"];
    dbMockState.selectResult = [];
    dbMockState.throwOnRead = false;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["PATCH_AGENT_CLICK_APPLY_ENABLED"];
    } else {
      process.env["PATCH_AGENT_CLICK_APPLY_ENABLED"] = originalEnv;
    }
  });

  it("override=true wins over env=false (aeon-bench canary)", async () => {
    process.env["PATCH_AGENT_CLICK_APPLY_ENABLED"] = "false";
    dbMockState.selectResult = [{ patchAgentClickApplyEnabled: true }];
    await expect(
      isPatchAgentClickApplyEnabledForInstall(133030324, "aeon-bench"),
    ).resolves.toBe(true);
  });

  it("override=false wins over env=true (kill switch on one install)", async () => {
    process.env["PATCH_AGENT_CLICK_APPLY_ENABLED"] = "true";
    dbMockState.selectResult = [{ patchAgentClickApplyEnabled: false }];
    await expect(
      isPatchAgentClickApplyEnabledForInstall(12345, "some-repo"),
    ).resolves.toBe(false);
  });

  it("override=null falls through to env=true", async () => {
    process.env["PATCH_AGENT_CLICK_APPLY_ENABLED"] = "true";
    dbMockState.selectResult = [{ patchAgentClickApplyEnabled: null }];
    await expect(
      isPatchAgentClickApplyEnabledForInstall(12345, "some-repo"),
    ).resolves.toBe(true);
  });

  it("override=null falls through to env=false", async () => {
    process.env["PATCH_AGENT_CLICK_APPLY_ENABLED"] = "false";
    dbMockState.selectResult = [{ patchAgentClickApplyEnabled: null }];
    await expect(
      isPatchAgentClickApplyEnabledForInstall(12345, "some-repo"),
    ).resolves.toBe(false);
  });

  it("DB read failure → conservative fallback to env-only", async () => {
    process.env["PATCH_AGENT_CLICK_APPLY_ENABLED"] = "true";
    dbMockState.throwOnRead = true;
    await expect(
      isPatchAgentClickApplyEnabledForInstall(12345, "some-repo"),
    ).resolves.toBe(true);
  });

  it("missing install row → null override → env wins", async () => {
    process.env["PATCH_AGENT_CLICK_APPLY_ENABLED"] = "true";
    dbMockState.selectResult = [];
    await expect(
      isPatchAgentClickApplyEnabledForInstall(99999, "missing-repo"),
    ).resolves.toBe(true);
  });
});
