import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mutable mock state for the (installation_id, repo) override lookup.
const dbMockState = vi.hoisted(() => ({
  selectResult: [] as Array<{ singleModelTierEnabled?: boolean | null }>,
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
  isSingleModelTierEnabled,
  isSingleModelTierEnabledForInstall,
  isSingleModelTierRenderEnabled,
} from "./single-model-tier-env";

describe("isSingleModelTierEnabled (env)", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env["ANTFLEET_SINGLE_MODEL_TIER"];
  });
  afterEach(() => {
    if (original === undefined) delete process.env["ANTFLEET_SINGLE_MODEL_TIER"];
    else process.env["ANTFLEET_SINGLE_MODEL_TIER"] = original;
  });

  it("defaults OFF when unset", () => {
    delete process.env["ANTFLEET_SINGLE_MODEL_TIER"];
    expect(isSingleModelTierEnabled()).toBe(false);
  });

  it("is ON for 'true' / '1' / case-insensitive+trim", () => {
    for (const v of ["true", "1", "TRUE", "  true\n"]) {
      process.env["ANTFLEET_SINGLE_MODEL_TIER"] = v;
      expect(isSingleModelTierEnabled()).toBe(true);
    }
  });

  it("is OFF for anything else", () => {
    for (const v of ["false", "no", "", "0", "yes", "on"]) {
      process.env["ANTFLEET_SINGLE_MODEL_TIER"] = v;
      expect(isSingleModelTierEnabled()).toBe(false);
    }
  });
});

describe("isSingleModelTierRenderEnabled (env sub-flag)", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env["ANTFLEET_SINGLE_MODEL_TIER_RENDER"];
  });
  afterEach(() => {
    if (original === undefined) delete process.env["ANTFLEET_SINGLE_MODEL_TIER_RENDER"];
    else process.env["ANTFLEET_SINGLE_MODEL_TIER_RENDER"] = original;
  });

  it("defaults OFF when unset", () => {
    delete process.env["ANTFLEET_SINGLE_MODEL_TIER_RENDER"];
    expect(isSingleModelTierRenderEnabled()).toBe(false);
  });

  it("is ON only for 'true' / '1'", () => {
    process.env["ANTFLEET_SINGLE_MODEL_TIER_RENDER"] = "1";
    expect(isSingleModelTierRenderEnabled()).toBe(true);
    process.env["ANTFLEET_SINGLE_MODEL_TIER_RENDER"] = "false";
    expect(isSingleModelTierRenderEnabled()).toBe(false);
  });
});

describe("isSingleModelTierEnabledForInstall — override precedence", () => {
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env["ANTFLEET_SINGLE_MODEL_TIER"];
    dbMockState.selectResult = [];
    dbMockState.throwOnRead = false;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env["ANTFLEET_SINGLE_MODEL_TIER"];
    else process.env["ANTFLEET_SINGLE_MODEL_TIER"] = originalEnv;
  });

  it("override=true wins over env=false (aeon-bench canary)", async () => {
    process.env["ANTFLEET_SINGLE_MODEL_TIER"] = "false";
    dbMockState.selectResult = [{ singleModelTierEnabled: true }];
    await expect(isSingleModelTierEnabledForInstall(133030324, "aeon-bench")).resolves.toBe(true);
  });

  it("override=false wins over env=true (kill switch on one install)", async () => {
    process.env["ANTFLEET_SINGLE_MODEL_TIER"] = "true";
    dbMockState.selectResult = [{ singleModelTierEnabled: false }];
    await expect(isSingleModelTierEnabledForInstall(12345, "some-repo")).resolves.toBe(false);
  });

  it("override=null falls through to env", async () => {
    process.env["ANTFLEET_SINGLE_MODEL_TIER"] = "true";
    dbMockState.selectResult = [{ singleModelTierEnabled: null }];
    await expect(isSingleModelTierEnabledForInstall(12345, "some-repo")).resolves.toBe(true);
  });

  it("missing install row → env wins", async () => {
    delete process.env["ANTFLEET_SINGLE_MODEL_TIER"];
    dbMockState.selectResult = [];
    await expect(isSingleModelTierEnabledForInstall(99999, "missing-repo")).resolves.toBe(false);
  });

  it("DB read failure → conservative fallback to env-only", async () => {
    process.env["ANTFLEET_SINGLE_MODEL_TIER"] = "true";
    dbMockState.throwOnRead = true;
    await expect(isSingleModelTierEnabledForInstall(12345, "some-repo")).resolves.toBe(true);
  });
});
