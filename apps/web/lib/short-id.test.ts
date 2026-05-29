import { describe, expect, it } from "vitest";
import { shortenRepoHash, shortenReviewId, shortenSha } from "./short-id";

describe("shortenSha", () => {
  it("returns the git-standard 7-character short SHA", () => {
    expect(shortenSha("1ee2fd9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e")).toBe("1ee2fd9");
  });

  it("is a no-op when the input is already short or empty", () => {
    expect(shortenSha("abc")).toBe("abc");
    expect(shortenSha("")).toBe("");
  });
});

describe("shortenReviewId", () => {
  it("returns the first 8 characters of a UUID for the review label", () => {
    expect(shortenReviewId("83e79770-1869-4331-8690-b534a531d327")).toBe("83e79770");
  });
});

describe("shortenRepoHash", () => {
  it("returns the first 8 characters of a SHA-256 repo hash", () => {
    expect(
      shortenRepoHash("a3f2c4b1d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5"),
    ).toBe("a3f2c4b1");
  });
});
