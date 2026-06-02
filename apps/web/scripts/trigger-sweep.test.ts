import { describe, expect, it } from "vitest";
import { resolveSweepUrl } from "./trigger-sweep";

describe("resolveSweepUrl", () => {
  it("builds the cron sweep URL for trusted production hosts", () => {
    expect(resolveSweepUrl("https://www.antfleet.dev")).toBe(
      "https://www.antfleet.dev/api/cron/sweep",
    );
    expect(resolveSweepUrl("https://antfleet-web.vercel.app/some/path")).toBe(
      "https://antfleet-web.vercel.app/api/cron/sweep",
    );
  });

  it("refuses to send CRON_SECRET to non-HTTPS targets", () => {
    expect(() => resolveSweepUrl("http://www.antfleet.dev")).toThrow("must use https");
  });

  it("refuses to send CRON_SECRET to untrusted hosts", () => {
    expect(() => resolveSweepUrl("https://evil.example")).toThrow("untrusted host");
  });
});
