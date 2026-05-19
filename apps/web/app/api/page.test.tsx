import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { describe, expect, it } from "vitest";
import ApiPage, { metadata } from "./page";

describe("ApiPage", () => {
  it("renders the public API documentation content", () => {
    const markup = renderToStaticMarkup(<ApiPage />);

    expect(metadata.title).toBe("API · AntFleet");
    expect(markup).toContain("AntFleet API");
    expect(markup).toContain("Public, read-only JSON for AntFleet&#x27;s code-quality data layer.");
    expect(markup).toContain("GET /api/v1/findings");
    expect(markup).toContain("GET /api/v1/findings/{finding_id}");
    expect(markup).toContain("GET /api/v1/agents");
    expect(markup).toContain("GET /api/v1/agents/{address}");
    expect(markup).toContain("GET /api/v1/agents/{address}/findings");
    expect(markup).toContain("GET /api/v1/agents/{address}/drift");
    expect(markup).toContain("GET /api/v1/stats");
    expect(markup).toContain("60 requests per 60 seconds per IP");
    expect(markup).toContain('href="/api/v1/openapi.json"');
    expect(markup).toContain("curl https://antfleet.dev/api/v1/findings?severity=high&amp;limit=5");
    expect(markup).toContain("feelocker-selector-2026-05-18");
  });
});
