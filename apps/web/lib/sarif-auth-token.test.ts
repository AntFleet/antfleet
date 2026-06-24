import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SARIF_INGEST_TOKEN_TTL_MS,
  signSarifIngestToken,
  verifyAndConsumeSarifIngestToken,
  verifySarifIngestToken,
  type SarifIngestTokenUse,
} from "./sarif-auth-token";

const ORIGINAL_SECRET = process.env["ANTFLEET_SARIF_INGEST_HMAC_SECRET"];

describe("SARIF ingest auth tokens", () => {
  beforeEach(() => {
    process.env["ANTFLEET_SARIF_INGEST_HMAC_SECRET"] = "test-sarif-secret";
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env["ANTFLEET_SARIF_INGEST_HMAC_SECRET"];
    else process.env["ANTFLEET_SARIF_INGEST_HMAC_SECRET"] = ORIGINAL_SECRET;
  });

  it("accepts a valid token once and rejects the replay", async () => {
    const used = new Set<string>();
    const consume = async (tokenUse: SarifIngestTokenUse): Promise<"consumed" | "replay"> => {
      if (used.has(tokenUse.jti)) return "replay";
      used.add(tokenUse.jti);
      return "consumed";
    };
    const token = signSarifIngestToken(
      { installationId: 123, owner: "AntFleet", repo: "bench" },
      new Date("2026-06-24T12:00:00.000Z"),
    );

    await expect(
      verifyAndConsumeSarifIngestToken(token, consume, new Date("2026-06-24T12:01:00.000Z")),
    ).resolves.toMatchObject({
      kind: "ok",
      payload: { installationId: 123, owner: "AntFleet", repo: "bench" },
    });
    await expect(
      verifyAndConsumeSarifIngestToken(token, consume, new Date("2026-06-24T12:02:00.000Z")),
    ).resolves.toEqual({ kind: "replay" });
  });

  it("rejects expired tokens", () => {
    const token = signSarifIngestToken(
      { installationId: 123, owner: "AntFleet", repo: "bench" },
      new Date("2026-06-24T12:00:00.000Z"),
    );

    expect(
      verifySarifIngestToken(
        token,
        new Date(new Date("2026-06-24T12:00:00.000Z").getTime() + SARIF_INGEST_TOKEN_TTL_MS),
      ),
    ).toEqual({ kind: "expired" });
  });
});
