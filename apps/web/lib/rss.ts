// Tiny RSS 2.0 generator + helpers. No library — RSS is a fixed shape and
// dragging in a feed builder just to emit a few <item> tags would be a
// maintenance tax forever. The escape function is the load-bearing piece;
// it has to handle every character that XML treats as syntactic.

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);
}

// RFC 822 date format — the RSS 2.0 spec requires this for pubDate, e.g.
// "Sat, 17 May 2026 03:54:38 GMT". Intl.DateTimeFormat doesn't emit RFC 822
// directly; we build it by hand so the output is locale-independent and
// guaranteed-parseable by RSS readers.
const RFC822_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RFC822_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function toRfc822(date: Date): string {
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const day = RFC822_DAYS[date.getUTCDay()];
  const date_ = pad2(date.getUTCDate());
  const month = RFC822_MONTHS[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  const hh = pad2(date.getUTCHours());
  const mm = pad2(date.getUTCMinutes());
  const ss = pad2(date.getUTCSeconds());
  return `${day}, ${date_} ${month} ${year} ${hh}:${mm}:${ss} GMT`;
}

export type RssItem = {
  title: string;
  link: string;
  guid: string;
  pubDate: Date;
  description: string;
};

export type RssChannel = {
  title: string;
  link: string;
  description: string;
  selfLink: string;
  lastBuildDate: Date;
  items: RssItem[];
};

export function renderRssFeed(channel: RssChannel): string {
  const items = channel.items.map(renderRssItem).join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">`,
    `<channel>`,
    `  <title>${escapeXml(channel.title)}</title>`,
    `  <link>${escapeXml(channel.link)}</link>`,
    `  <description>${escapeXml(channel.description)}</description>`,
    `  <atom:link href="${escapeXml(channel.selfLink)}" rel="self" type="application/rss+xml" />`,
    `  <lastBuildDate>${toRfc822(channel.lastBuildDate)}</lastBuildDate>`,
    `  <language>en-us</language>`,
    items,
    `</channel>`,
    `</rss>`,
  ].join("\n");
}

function renderRssItem(item: RssItem): string {
  return [
    `  <item>`,
    `    <title>${escapeXml(item.title)}</title>`,
    `    <link>${escapeXml(item.link)}</link>`,
    `    <guid isPermaLink="false">${escapeXml(item.guid)}</guid>`,
    `    <pubDate>${toRfc822(item.pubDate)}</pubDate>`,
    `    <description>${escapeXml(item.description)}</description>`,
    `  </item>`,
  ].join("\n");
}
