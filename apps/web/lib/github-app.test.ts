import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The github-app module reads GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY at call
// time (not at import time), so we can swap env vars in each test without
// dynamic import gymnastics.

const ORIGINAL_ID = process.env["GITHUB_APP_ID"];
const ORIGINAL_KEY = process.env["GITHUB_APP_PRIVATE_KEY"];

beforeEach(() => {
  delete process.env["GITHUB_APP_ID"];
  delete process.env["GITHUB_APP_PRIVATE_KEY"];
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_ID !== undefined) process.env["GITHUB_APP_ID"] = ORIGINAL_ID;
  if (ORIGINAL_KEY !== undefined) process.env["GITHUB_APP_PRIVATE_KEY"] = ORIGINAL_KEY;
});

describe("appAuth", () => {
  it("throws a clear error when GITHUB_APP_ID is missing", async () => {
    const { appAuth } = await import("./github-app");
    expect(() => appAuth()).toThrow(/GITHUB_APP_ID/u);
  });

  it("throws a clear error when GITHUB_APP_PRIVATE_KEY is missing but ID is set", async () => {
    process.env["GITHUB_APP_ID"] = "12345";
    const { appAuth } = await import("./github-app");
    expect(() => appAuth()).toThrow(/GITHUB_APP_PRIVATE_KEY/u);
  });

  it("constructs an auth instance when both env vars are present", async () => {
    process.env["GITHUB_APP_ID"] = "12345";
    // A syntactically-valid PEM is required for createAppAuth's internal validation.
    // This is a throwaway test key (RSA 2048, generated for tests only).
    process.env["GITHUB_APP_PRIVATE_KEY"] =
      "-----BEGIN RSA PRIVATE KEY-----\n" +
      "MIIEpAIBAAKCAQEAyV9ZxkLhsAg5H3rdtQRDV9NOdbOwv3k7OYLRjljkojmzsCMm\n" +
      "-----END RSA PRIVATE KEY-----\n";
    const { appAuth } = await import("./github-app");
    // Doesn't throw at construction time — the auth fn is callable.
    expect(typeof appAuth()).toBe("function");
  });
});
