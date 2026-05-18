import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGitHubSignature } from "./github-signature";

const SECRET = "test-secret-not-real";
const sign = (body: string, secret: string = SECRET): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("verifyGitHubSignature", () => {
  it("accepts a valid signature for the exact body and secret", () => {
    const body = '{"action":"opened","number":42}';
    expect(verifyGitHubSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects when the body is tampered after signing", () => {
    const body = '{"action":"opened","number":42}';
    const tampered = '{"action":"opened","number":43}';
    expect(verifyGitHubSignature(tampered, sign(body), SECRET)).toBe(false);
  });

  it("rejects when the secret is wrong", () => {
    const body = '{"action":"opened"}';
    expect(verifyGitHubSignature(body, sign(body, "different"), SECRET)).toBe(false);
  });

  it("rejects a null header", () => {
    expect(verifyGitHubSignature("anything", null, SECRET)).toBe(false);
  });

  it("rejects a header missing the sha256= prefix", () => {
    const body = "x";
    const noPrefix = sign(body).slice("sha256=".length);
    expect(verifyGitHubSignature(body, noPrefix, SECRET)).toBe(false);
  });

  it("rejects a header with a wrong-length hex payload", () => {
    expect(verifyGitHubSignature("x", "sha256=deadbeef", SECRET)).toBe(false);
  });

  it("rejects a header with non-hex characters", () => {
    expect(verifyGitHubSignature("x", `sha256=${"z".repeat(64)}`, SECRET)).toBe(false);
  });

  it("accepts a Buffer body equivalent to the string body", () => {
    const body = '{"a":1}';
    const sig = sign(body);
    expect(verifyGitHubSignature(Buffer.from(body, "utf8"), sig, SECRET)).toBe(true);
  });
});
