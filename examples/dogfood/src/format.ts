/**
 * Escape HTML-unsafe characters in user-supplied text so the result is safe to
 * render directly inside an HTML attribute or document body.
 *
 * Replaces `<`, `>`, `&`, `"`, and `'` with their entity equivalents.
 */
export function escapeHtml(input: string): string {
  return input.replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, max)}…`;
}
