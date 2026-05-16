import { afterEach, describe, expect, it, vi } from "vitest";
import { log, logInfo } from "./log";

const captureLogs = (): { calls: string[] } => {
  const calls: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    calls.push(line);
  });
  return { calls };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("log", () => {
  it("writes one JSON line per call with ts/level/event populated", () => {
    const { calls } = captureLogs();
    logInfo("webhook.received", { delivery: "abc-123" });
    expect(calls).toHaveLength(1);
    const entry = JSON.parse(calls[0]!) as Record<string, unknown>;
    expect(entry["level"]).toBe("info");
    expect(entry["event"]).toBe("webhook.received");
    expect(entry["delivery"]).toBe("abc-123");
    expect(typeof entry["ts"]).toBe("string");
    expect(() => new Date(String(entry["ts"])).toISOString()).not.toThrow();
  });

  it("does not let caller fields clobber the base event/level/ts slots", () => {
    const { calls } = captureLogs();
    log("warn", "webhook.signature_invalid", {
      event: "pull_request", // a caller field that would have shadowed our event slot
      level: "info",
      ts: "1970-01-01T00:00:00.000Z",
      delivery: "xyz",
    });
    const entry = JSON.parse(calls[0]!) as Record<string, unknown>;
    expect(entry["event"]).toBe("webhook.signature_invalid");
    expect(entry["level"]).toBe("warn");
    expect(entry["ts"]).not.toBe("1970-01-01T00:00:00.000Z");
    expect(entry["delivery"]).toBe("xyz");
  });

  it("handles missing fields argument", () => {
    const { calls } = captureLogs();
    log("error", "boom");
    const entry = JSON.parse(calls[0]!) as Record<string, unknown>;
    expect(entry["event"]).toBe("boom");
    expect(entry["level"]).toBe("error");
  });
});
