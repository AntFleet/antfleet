import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadAgentDetailMock } = vi.hoisted(() => ({
  loadAgentDetailMock: vi.fn(),
}));

vi.mock("@/db/queries", () => ({
  loadAgentDetail: loadAgentDetailMock,
}));

vi.mock("next/og", () => ({
  ImageResponse: class MockImageResponse extends Response {
    readonly element: React.ReactElement;
    readonly options: { width: number; height: number };

    constructor(element: React.ReactElement, options: { width: number; height: number }) {
      super("mock image", {
        headers: { "content-type": "image/png" },
      });
      this.element = element;
      this.options = options;
    }
  },
}));

import Image from "./opengraph-image";

describe("/agents/[address]/opengraph-image", () => {
  beforeEach(() => {
    loadAgentDetailMock.mockReset();
  });

  it("awaits Next 16 promise params before loading agent details", async () => {
    loadAgentDetailMock.mockResolvedValue({
      agentTokenAddress: "0x1234567890abcdef1234567890abcdef12345678",
      agentName: "Depth",
      findings: [
        {
          severity: "high",
        },
      ],
      benchmarkReviews: [],
      crossRepoMerges: [],
    });

    const response = await Image({
      params: Promise.resolve({ address: "0x1234567890abcdef1234567890abcdef12345678" }),
    });

    expect(loadAgentDetailMock).toHaveBeenCalledWith("0x1234567890abcdef1234567890abcdef12345678");
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  it("returns a fallback image when the detail lookup fails", async () => {
    loadAgentDetailMock.mockRejectedValue(new Error("db unavailable"));

    const response = await Image({
      params: Promise.resolve({ address: "0xbad" }),
    });

    expect(response.headers.get("content-type")).toBe("image/png");
  });
});
