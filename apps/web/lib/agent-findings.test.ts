import { describe, expect, it } from "vitest";
import {
  renderFindingMarkdown,
  renderInline,
  severityLabel,
  shortAddress,
} from "./agent-findings";

describe("severityLabel", () => {
  it("maps known severity codes to human-friendly labels", () => {
    expect(severityLabel("info")).toBe("info");
    expect(severityLabel("low")).toBe("low");
    expect(severityLabel("med")).toBe("medium");
    expect(severityLabel("high")).toBe("high");
  });

  it("passes unknown severities through verbatim", () => {
    expect(severityLabel("critical")).toBe("critical");
  });
});

describe("shortAddress", () => {
  it("collapses long addresses to a 6…4 mask", () => {
    expect(shortAddress("0xB3D7e0c3C39A1D3F1B304663065A2F83Ddf56d8e")).toBe("0xB3D7…6d8e");
  });

  it("returns short input verbatim", () => {
    expect(shortAddress("0x1234")).toBe("0x1234");
  });
});

describe("renderFindingMarkdown", () => {
  it("emits one block per markdown element", () => {
    const nodes = renderFindingMarkdown(
      "## Heading\n\nFirst paragraph.\n\n- item one\n- item two\n\n```\ncode body\n```",
    );
    expect(nodes).toHaveLength(4);
  });

  it("captures fenced code block text without escaping", () => {
    const nodes = renderFindingMarkdown("```\nliteral <tag> text\n```");
    const node = nodes[0] as { props: { children: { props: { children: string } } } };
    expect(node.props.children.props.children).toBe("literal <tag> text");
  });

  it("splits adjacent ordered and unordered lists into distinct blocks", () => {
    const nodes = renderFindingMarkdown("- a\n- b\n\n1. one\n2. two");
    expect(nodes).toHaveLength(2);
  });
});

describe("renderInline", () => {
  it("emits an anchor element for [label](url) markdown", () => {
    const nodes = renderInline("see [openchain](https://openchain.xyz) for the table");
    const anchor = nodes.find(
      (n) => typeof n === "object" && n !== null && "type" in n && n.type === "a",
    ) as { props: { href: string; children: string } } | undefined;
    expect(anchor?.props.href).toBe("https://openchain.xyz");
    expect(anchor?.props.children).toBe("openchain");
  });

  it("emits an anchor for a bare URL", () => {
    const nodes = renderInline("see https://basescan.org/address/0xF7d3");
    const anchor = nodes.find(
      (n) => typeof n === "object" && n !== null && "type" in n && n.type === "a",
    ) as { props: { href: string } } | undefined;
    expect(anchor?.props.href).toBe("https://basescan.org/address/0xF7d3");
  });

  it("emits an inline <code> element for `selector` segments", () => {
    const nodes = renderInline("the selector `0x8296535a` is correct");
    const code = nodes.find(
      (n) => typeof n === "object" && n !== null && "type" in n && n.type === "code",
    ) as { props: { children: string } } | undefined;
    expect(code?.props.children).toBe("0x8296535a");
  });
});
