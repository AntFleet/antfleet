import { describe, expect, it } from "vitest";
import { parseChangelog } from "./changelog";

const SAMPLE = `# Changelog

Intro paragraph one.

Intro paragraph two with \`code\` and a [link](https://example.com).

## 2026-05-17 — Big section

- First entry with **bold** text.
  - Nested detail one.
  - Nested detail two.
- Second entry, no nesting.

## 2026-05-16 — Earlier

- Single entry.

---

## Lineage from clawpatch upstream

Some appendix intro text.

- Appendix intro bullet.

### clawpatch 0.1.0 — 2026-05-15

- Appendix section bullet one.
- Appendix section bullet two.
`;

describe("parseChangelog", () => {
  const doc = parseChangelog(SAMPLE);

  it("renders the intro as paragraph HTML", () => {
    expect(doc.intro).toContain("<p>Intro paragraph one.</p>");
    expect(doc.intro).toContain("<code");
    expect(doc.intro).toContain('href="https://example.com"');
  });

  it("collects each H2 section with its heading verbatim", () => {
    expect(doc.sections.length).toBe(2);
    expect(doc.sections[0]?.heading).toBe("2026-05-17 — Big section");
    expect(doc.sections[1]?.heading).toBe("2026-05-16 — Earlier");
  });

  it("parses top-level bullets with nested sub-bullets", () => {
    const first = doc.sections[0];
    expect(first?.entries.length).toBe(2);
    expect(first?.entries[0]?.html).toContain("<strong>bold</strong>");
    expect(first?.entries[0]?.children.length).toBe(2);
    expect(first?.entries[0]?.children[0]).toContain("Nested detail one.");
    expect(first?.entries[1]?.children.length).toBe(0);
  });

  it("splits the appendix off and parses its sub-sections", () => {
    expect(doc.appendix).not.toBeNull();
    expect(doc.appendix?.heading).toBe("Lineage from clawpatch upstream");
    expect(doc.appendix?.intro).toContain("Appendix intro bullet.");
    expect(doc.appendix?.sections.length).toBe(1);
    expect(doc.appendix?.sections[0]?.heading).toBe("clawpatch 0.1.0 — 2026-05-15");
    expect(doc.appendix?.sections[0]?.entries.length).toBe(2);
  });

  it("escapes raw HTML in body text to prevent injection", () => {
    const doc = parseChangelog(`# Changelog

## Section

- Entry with <script>alert(1)</script> inline.
`);
    expect(doc.sections[0]?.entries[0]?.html).toContain("&lt;script&gt;");
    expect(doc.sections[0]?.entries[0]?.html).not.toContain("<script>");
  });
});
