import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isPatchAgentEnabled } from "./patch-agent-env";

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
