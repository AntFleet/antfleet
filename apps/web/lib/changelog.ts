// Minimal Markdown parser for CHANGELOG.md. Not a full Markdown engine —
// just enough to render the changelog's specific shape: H2-delimited
// sections with bulleted entries that may contain nested bullets, inline
// `code`, [links](url), and **bold**. Adding a Markdown library for one
// page would be carrying a parser tax forever; this is ~80 lines of
// hand-rolled instead.

export type ChangelogEntry = {
  /** Plain-text bullet body. Inline formatting is preserved as HTML on render. */
  html: string;
  /** Nested sub-bullets, also pre-rendered as HTML. */
  children: string[];
};

export type ChangelogSection = {
  /** The H2 heading verbatim (e.g. "2026-05-17 — First production receipt"). */
  heading: string;
  entries: ChangelogEntry[];
};

export type ChangelogDocument = {
  intro: string; // pre-rendered HTML; rendered before the first H2
  sections: ChangelogSection[];
  appendix: ChangelogAppendix | null;
};

export type ChangelogAppendix = {
  heading: string;
  intro: string;
  sections: ChangelogSection[];
};

const APPENDIX_MARKER = "Lineage from clawpatch upstream";

export function parseChangelog(markdown: string): ChangelogDocument {
  // Drop the leading H1 (everything before the first blank line after
  // "# Changelog") and the trailing footer (text after the last "---").
  const lines = markdown.split("\n");
  let cursor = 0;
  // Skip H1 line
  while (cursor < lines.length && !(lines[cursor] ?? "").startsWith("# ")) cursor++;
  cursor++; // past the H1

  // Read intro lines until the first H2
  const introLines: string[] = [];
  while (cursor < lines.length && !(lines[cursor] ?? "").startsWith("## ")) {
    introLines.push(lines[cursor] ?? "");
    cursor++;
  }
  const intro = renderParagraphs(introLines);

  const allSections: { heading: string; bodyLines: string[] }[] = [];
  while (cursor < lines.length) {
    const line = lines[cursor] ?? "";
    if (line.startsWith("## ")) {
      const heading = line.slice(3).trim();
      cursor++;
      const bodyLines: string[] = [];
      while (cursor < lines.length && !(lines[cursor] ?? "").startsWith("## ")) {
        bodyLines.push(lines[cursor] ?? "");
        cursor++;
      }
      allSections.push({ heading, bodyLines });
    } else {
      cursor++;
    }
  }

  // Split into main vs appendix at the divider that contains the lineage
  // header text.
  const mainSections: ChangelogSection[] = [];
  let appendix: ChangelogAppendix | null = null;

  for (const raw of allSections) {
    if (raw.heading === APPENDIX_MARKER) {
      // The appendix is a single H2 whose body contains H3-delimited
      // sub-sections. We treat each H3 (and the prelude text before the
      // first H3) accordingly.
      const introBuf: string[] = [];
      const subs: ChangelogSection[] = [];
      let i = 0;
      while (i < raw.bodyLines.length && !(raw.bodyLines[i] ?? "").startsWith("### ")) {
        introBuf.push(raw.bodyLines[i] ?? "");
        i++;
      }
      // Intro of the appendix is itself a flat bullet list.
      const appendixIntroEntries = parseBulletBody(introBuf);
      const appendixIntroHtml =
        appendixIntroEntries.length === 0
          ? renderParagraphs(introBuf)
          : renderEntriesAsList(appendixIntroEntries);
      while (i < raw.bodyLines.length) {
        if ((raw.bodyLines[i] ?? "").startsWith("### ")) {
          const subHeading = (raw.bodyLines[i] ?? "").slice(4).trim();
          i++;
          const subBuf: string[] = [];
          while (i < raw.bodyLines.length && !(raw.bodyLines[i] ?? "").startsWith("### ")) {
            subBuf.push(raw.bodyLines[i] ?? "");
            i++;
          }
          subs.push({ heading: subHeading, entries: parseBulletBody(subBuf) });
        } else {
          i++;
        }
      }
      appendix = { heading: raw.heading, intro: appendixIntroHtml, sections: subs };
      continue;
    }
    mainSections.push({ heading: raw.heading, entries: parseBulletBody(raw.bodyLines) });
  }

  return { intro, sections: mainSections, appendix };
}

function parseBulletBody(bodyLines: string[]): ChangelogEntry[] {
  // Bullets begin with "- " at indent 0. Sub-bullets begin with "  - " at
  // indent 2. Continuation lines (text wrapped on the next line) are
  // joined onto the prior bullet with a space.
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  let currentChildBuf: string | null = null;
  let mode: "main" | "child" = "main";

  const commitChild = () => {
    if (current !== null && currentChildBuf !== null) {
      current.children.push(renderInline(currentChildBuf.trim()));
      currentChildBuf = null;
    }
  };
  const commitCurrent = () => {
    commitChild();
    if (current !== null) entries.push(current);
    current = null;
    mode = "main";
  };

  for (const raw of bodyLines) {
    const line = raw.trimEnd();
    if (line === "") {
      // Blank line ends the current entry boundary but only between top-
      // level entries; within a single entry, blank lines are paragraph
      // breaks which we don't support here.
      commitCurrent();
      continue;
    }
    if (line.startsWith("- ")) {
      commitCurrent();
      current = { html: renderInline(line.slice(2)), children: [] };
      mode = "main";
      continue;
    }
    if (line.startsWith("  - ")) {
      commitChild();
      currentChildBuf = line.slice(4);
      mode = "child";
      continue;
    }
    // Continuation line — append to current main or child buffer.
    const continuation = line.replace(/^\s+/, " ");
    if (mode === "child" && currentChildBuf !== null) {
      currentChildBuf += continuation;
    } else if (current !== null) {
      current.html += continuation === " " ? "" : renderInline(continuation);
    }
  }
  commitCurrent();
  return entries;
}

function renderEntriesAsList(entries: ChangelogEntry[]): string {
  const items = entries
    .map(
      (e) =>
        `<li>${e.html}${e.children.length > 0 ? `<ul>${e.children.map((c) => `<li>${c}</li>`).join("")}</ul>` : ""}</li>`,
    )
    .join("");
  return `<ul>${items}</ul>`;
}

function renderParagraphs(lines: string[]): string {
  const paragraphs: string[] = [];
  let buf: string[] = [];
  for (const l of lines) {
    if (l.trim() === "") {
      if (buf.length > 0) {
        paragraphs.push(buf.join(" "));
        buf = [];
      }
    } else {
      buf.push(l.trim());
    }
  }
  if (buf.length > 0) paragraphs.push(buf.join(" "));
  return paragraphs.map((p) => `<p>${renderInline(p)}</p>`).join("");
}

// Inline formatters: `code`, **bold**, [text](url). No nested handling.
function renderInline(text: string): string {
  let out = escapeHtml(text);
  // Order matters: links before code because link URLs may contain chars
  // that look like code fences. We restore literal backticks afterwards.
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label, url) =>
      `<a href="${escapeAttr(String(url))}" class="underline underline-offset-2 hover:opacity-70">${label}</a>`,
  );
  out = out.replace(/`([^`]+)`/g, (_m, code) => `<code class="font-mono text-xs">${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, body) => `<strong>${body}</strong>`);
  return out;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return text.replace(/"/g, "&quot;");
}
