import { describe, expect, it } from "vitest";
import { escapeXml, renderRssFeed, toRfc822 } from "./rss";

describe("escapeXml", () => {
  it("escapes all five XML-significant characters", () => {
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });

  it("does not double-escape pre-escaped entities", () => {
    // Order matters: & must be escaped first or we double-escape later entities.
    expect(escapeXml("a & b < c")).toBe("a &amp; b &lt; c");
  });

  it("escapes user-controlled finding titles safely", () => {
    const malicious = `</title><script>alert("xss")</script>`;
    const escaped = escapeXml(malicious);
    expect(escaped).not.toContain("<script>");
    expect(escaped).not.toContain(`"xss"`);
    expect(escaped).toContain("&lt;script&gt;");
  });

  it("is a no-op on safe text", () => {
    expect(escapeXml("hello world 123")).toBe("hello world 123");
  });
});

describe("toRfc822", () => {
  it("formats a UTC date in RFC 822 with GMT suffix", () => {
    const d = new Date("2026-05-17T03:54:38.000Z");
    expect(toRfc822(d)).toBe("Sun, 17 May 2026 03:54:38 GMT");
  });

  it("pads single-digit components", () => {
    const d = new Date("2026-01-05T07:08:09.000Z");
    expect(toRfc822(d)).toBe("Mon, 05 Jan 2026 07:08:09 GMT");
  });
});

describe("renderRssFeed", () => {
  const FIXED_DATE = new Date("2026-05-17T03:54:38.000Z");

  it("emits a valid RSS 2.0 envelope with channel metadata", () => {
    const xml = renderRssFeed({
      title: "Test",
      link: "https://example.com",
      description: "Test feed",
      selfLink: "https://example.com/rss",
      lastBuildDate: FIXED_DATE,
      items: [],
    });
    expect(xml).toContain(`<?xml version="1.0" encoding="UTF-8"?>`);
    expect(xml).toContain(`<rss version="2.0"`);
    expect(xml).toContain(`<title>Test</title>`);
    expect(xml).toContain(`<atom:link href="https://example.com/rss"`);
    expect(xml).toContain(`<lastBuildDate>Sun, 17 May 2026 03:54:38 GMT</lastBuildDate>`);
  });

  it("renders each item with escaped fields", () => {
    const xml = renderRssFeed({
      title: "Test",
      link: "https://example.com",
      description: "Test feed",
      selfLink: "https://example.com/rss",
      lastBuildDate: FIXED_DATE,
      items: [
        {
          title: `Bug with <special> "chars" & ampersands`,
          link: "https://example.com/receipts/foo-bar",
          guid: "foo-bar",
          pubDate: FIXED_DATE,
          description: "A description with <html> tags & entities",
        },
      ],
    });
    expect(xml).toContain(
      `<title>Bug with &lt;special&gt; &quot;chars&quot; &amp; ampersands</title>`,
    );
    expect(xml).toContain(
      `<description>A description with &lt;html&gt; tags &amp; entities</description>`,
    );
    expect(xml).toContain(`<guid isPermaLink="false">foo-bar</guid>`);
    expect(xml).not.toContain("<html>");
    expect(xml).not.toContain("<special>");
  });

  it("escapes channel-level fields too", () => {
    const xml = renderRssFeed({
      title: `Feed with <evil>`,
      link: "https://example.com",
      description: `Desc with "quotes" & ampersands`,
      selfLink: "https://example.com/rss",
      lastBuildDate: FIXED_DATE,
      items: [],
    });
    expect(xml).toContain(`<title>Feed with &lt;evil&gt;</title>`);
    expect(xml).toContain(
      `<description>Desc with &quot;quotes&quot; &amp; ampersands</description>`,
    );
  });
});
