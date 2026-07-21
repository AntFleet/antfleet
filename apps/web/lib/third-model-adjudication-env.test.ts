import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mutable mock state for the (installation_id, repo) override lookup.
const dbMockState = vi.hoisted(() => ({
  selectResult: [] as Array<{ thirdModelAdjudicationEnabled?: boolean | null }>,
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
  isThirdModelAdjudicationEnabled,
  isThirdModelAdjudicationEnabledForInstall,
  isThirdModelBlindedEnabled,
} from "./third-model-adjudication-env";

describe("isThirdModelAdjudicationEnabled (env)", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env["ANTFLEET_THIRD_MODEL_ADJUDICATION"];
  });
  afterEach(() => {
    if (original === undefined) delete process.env["ANTFLEET_THIRD_MODEL_ADJUDICATION"];
    else process.env["ANTFLEET_THIRD_MODEL_ADJUDICATION"] = original;
  });

  it("defaults OFF when unset", () => {
    delete process.env["ANTFLEET_THIRD_MODEL_ADJUDICATION"];
    expect(isThirdModelAdjudicationEnabled()).toBe(false);
  });

  it("is ON for 'true' / '1' / case-insensitive+trim", () => {
    for (const v of ["true", "1", "TRUE", "  true\n"]) {
      process.env["ANTFLEET_THIRD_MODEL_ADJUDICATION"] = v;
      expect(isThirdModelAdjudicationEnabled()).toBe(true);
    }
  });

  it("is OFF for anything else", () => {
    for (const v of ["false", "no", "", "0", "yes", "on"]) {
      process.env["ANTFLEET_THIRD_MODEL_ADJUDICATION"] = v;
      expect(isThirdModelAdjudicationEnabled()).toBe(false);
    }
  });
});

describe("isThirdModelBlindedEnabled (env)", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env["ANTFLEET_THIRD_MODEL_BLINDED"];
  });
  afterEach(() => {
    if (original === undefined) delete process.env["ANTFLEET_THIRD_MODEL_BLINDED"];
    else process.env["ANTFLEET_THIRD_MODEL_BLINDED"] = original;
  });

  it("defaults OFF when unset", () => {
    delete process.env["ANTFLEET_THIRD_MODEL_BLINDED"];
    expect(isThirdModelBlindedEnabled()).toBe(false);
  });

  it("is ON for 'true' / '1' / case-insensitive+trim", () => {
    for (const v of ["true", "1", "TRUE", "  true\n"]) {
      process.env["ANTFLEET_THIRD_MODEL_BLINDED"] = v;
      expect(isThirdModelBlindedEnabled()).toBe(true);
    }
  });

  it("is OFF for anything else", () => {
    for (const v of ["false", "no", "", "0", "yes", "on"]) {
      process.env["ANTFLEET_THIRD_MODEL_BLINDED"] = v;
      expect(isThirdModelBlindedEnabled()).toBe(false);
    }
  });
});

describe("isThirdModelAdjudicationEnabledForInstall — override precedence", () => {
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env["ANTFLEET_THIRD_MODEL_ADJUDICATION"];
    dbMockState.selectResult = [];
    dbMockState.throwOnRead = false;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env["ANTFLEET_THIRD_MODEL_ADJUDICATION"];
    else process.env["ANTFLEET_THIRD_MODEL_ADJUDICATION"] = originalEnv;
  });

  it("override=true wins over env=false (aeon-bench canary)", async () => {
    process.env["ANTFLEET_THIRD_MODEL_ADJUDICATION"] = "false";
    dbMockState.selectResult = [{ thirdModelAdjudicationEnabled: true }];
    await expect(isThirdModelAdjudicationEnabledForInstall(133030324, "aeon-bench")).resolves.toBe(
      true,
    );
  });

  it("override=false wins over env=true (kill switch on one install)", async () => {
    process.env["ANTFLEET_THIRD_MODEL_ADJUDICATION"] = "true";
    dbMockState.selectResult = [{ thirdModelAdjudicationEnabled: false }];
    await expect(isThirdModelAdjudicationEnabledForInstall(12345, "some-repo")).resolves.toBe(
      false,
    );
  });

  it("override=null falls through to env", async () => {
    process.env["ANTFLEET_THIRD_MODEL_ADJUDICATION"] = "true";
    dbMockState.selectResult = [{ thirdModelAdjudicationEnabled: null }];
    await expect(isThirdModelAdjudicationEnabledForInstall(12345, "some-repo")).resolves.toBe(true);
  });

  it("missing install row → env wins", async () => {
    delete process.env["ANTFLEET_THIRD_MODEL_ADJUDICATION"];
    dbMockState.selectResult = [];
    await expect(isThirdModelAdjudicationEnabledForInstall(99999, "missing-repo")).resolves.toBe(
      false,
    );
  });

  it("DB read failure → conservative fallback to env-only", async () => {
    process.env["ANTFLEET_THIRD_MODEL_ADJUDICATION"] = "true";
    dbMockState.throwOnRead = true;
    await expect(isThirdModelAdjudicationEnabledForInstall(12345, "some-repo")).resolves.toBe(true);
  });
});
