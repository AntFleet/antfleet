// Display-only truncation helpers for the two id shapes we surface in
// user-visible labels: git SHA-1 commit hashes (7 chars, git's own short
// convention) and our internal UUID-prefixed identifiers (8 chars, matches
// the makeFindingId convention in db/queries.ts).
//
// These are NOT for uniqueness or security. Anywhere we render a shortened
// label, the full id is also available somewhere on the page (the closure
// URL, the GitHub commit URL, the DB row) — the short form is just for
// scannable display.

const SHA_DISPLAY_LEN = 7;
const REVIEW_ID_DISPLAY_LEN = 8;
const REPO_HASH_DISPLAY_LEN = 8;

export function shortenSha(sha: string): string {
  return sha.slice(0, SHA_DISPLAY_LEN);
}

export function shortenReviewId(id: string): string {
  return id.slice(0, REVIEW_ID_DISPLAY_LEN);
}

export function shortenRepoHash(hash: string): string {
  return hash.slice(0, REPO_HASH_DISPLAY_LEN);
}
