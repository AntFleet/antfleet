import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor";

describe("api v1 cursor", () => {
  it("round-trips tuples", () => {
    const token = encodeCursor(["2026-05-18T00:00:00.000Z", "finding-1"]);
    expect(decodeCursor(token, 2)).toEqual(["2026-05-18T00:00:00.000Z", "finding-1"]);
  });

  it("returns null on decode failure", () => {
    expect(decodeCursor("not-json", 2)).toBeNull();
  });

  it("returns null on length mismatch", () => {
    expect(decodeCursor(encodeCursor(["only-one"]), 2)).toBeNull();
  });
});
