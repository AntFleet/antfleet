import { describe, expect, it } from "vitest";
import ApiDocsRedirect from "./page";

describe("ApiDocsRedirect", () => {
  it("permanently redirects the old API docs page to /about/api", () => {
    expect(() => ApiDocsRedirect()).toThrow(/NEXT_REDIRECT/);
  });
});
