import { describe, expect, it, vi } from "vitest";
import {
  acpProviderEventKey,
  claimAcpProviderEvent,
  findDueAcpProviderEvents,
  markAcpProviderEventFailed,
  recordAcpProviderEvent,
} from "./event-inbox";

describe("ACP event inbox", () => {
  it("uses stable content hashes when provider events do not include ids", () => {
    const first = acpProviderEventKey({ type: "job.funded", jobId: "43868", z: 1, a: 2 });
    const second = acpProviderEventKey({ a: 2, z: 1, jobId: "43868", type: "job.funded" });

    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:/);
  });

  it("returns existing status for duplicate event keys", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ status: "processed" }]);

    const result = await recordAcpProviderEvent(
      { execute },
      { id: "evt-1", type: "job.funded", jobId: "43868" },
    );

    expect(result).toEqual({ eventKey: "evt-1", created: false, status: "processed" });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("loads due pending, failed, and expired processing events for replay", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        eventKey: "evt-1",
        payload: { type: "job.funded", jobId: "43868" },
      },
      {
        eventKey: "evt-processing",
        payload: { type: "job.created", jobId: "43869" },
      },
      {
        eventKey: "evt-bad",
        payload: null,
      },
    ]);

    const result = await findDueAcpProviderEvents(
      { execute },
      new Date("2026-06-10T00:00:00Z"),
      20,
    );

    expect(result).toEqual([
      {
        eventKey: "evt-1",
        payload: { type: "job.funded", jobId: "43868" },
      },
      {
        eventKey: "evt-processing",
        payload: { type: "job.created", jobId: "43869" },
      },
    ]);
  });

  it("claims events before side effects", async () => {
    const execute = vi.fn().mockResolvedValue([{ event_key: "evt-1" }]);

    const claimed = await claimAcpProviderEvent(
      { execute },
      "evt-1",
      new Date("2026-06-10T00:00:00Z"),
    );

    expect(claimed).toBe(true);
  });

  it("dead-letters events at the retry cap", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ attempts: 5 }])
      .mockResolvedValueOnce([]);

    await markAcpProviderEventFailed(
      { execute },
      "evt-1",
      "permanent failure",
      new Date("2026-06-10T00:00:00Z"),
    );

    expect(execute).toHaveBeenCalledTimes(2);
  });
});
