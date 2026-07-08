import { sql } from "drizzle-orm";
import { findingDisclosure, findingStatus, reviews } from "./schema";

export const derivedPublicReceiptCondition = sql<boolean>`(
  (
    ${findingDisclosure.state} = 'published'
    AND (
      (
        ${findingDisclosure.ghsaId} IS NULL
        AND ${findingStatus.closureCommentUrl} IS NOT NULL
      )
      OR (
        ${findingDisclosure.ghsaId} IS NOT NULL
        AND ${findingDisclosure.ghsaPublishedAt} IS NOT NULL
        AND ${findingDisclosure.ghsaHtmlUrl} IS NOT NULL
      )
    )
  )
  OR (
    ${findingDisclosure.state} = 'none'
    AND ${reviews.publicReceipt} = true
  )
)`;

// Fail-closed fallback for when the disclosure gate is OFF (either
// ANTFLEET_DISCLOSURE_GATE or ANTFLEET_DISCLOSURE_BACKFILL_COMPLETE unset). The
// gate-ON conditions above require finding_disclosure to be backfilled, so with
// the gate off the read sites fall back to the legacy public_receipt flag. That
// fallback previously ignored finding_disclosure entirely (`public_receipt=true`),
// which meant an operator clearing a flag — or an incomplete backfill — would
// surface a live-protocol finding that is still mid-embargo (audit M4). This
// keeps the legacy flag as the base signal but ALSO excludes any review carrying
// an explicitly-embargoed finding: only rows in an active-embargo state (anything
// other than 'none' or 'published') hide the review. Findings with no disclosure
// row (not yet backfilled) are still treated as public, so no legitimate receipt
// is hidden — we only ever fail closed on an explicit embargo. Self-contained
// (correlated on reviews.review_id) so it also works at call sites that do not
// join finding_disclosure.
export const embargoSafePublicReceiptCondition = sql<boolean>`(
  ${reviews.publicReceipt} = true
  AND NOT EXISTS (
    SELECT 1
    FROM ${findingStatus} embargo_fs
    JOIN ${findingDisclosure} embargo_fd
      ON embargo_fd.finding_id = embargo_fs.finding_id
    WHERE embargo_fs.review_id = ${reviews.reviewId}
      AND embargo_fd.state NOT IN ('none', 'published')
  )
)`;

export const reviewDerivedPublicReceiptCondition = sql<boolean>`(
  ${reviews.publicReceipt} = true
  AND NOT EXISTS (
    SELECT 1
    FROM ${findingStatus} review_fs
    LEFT JOIN ${findingDisclosure} review_fd
      ON review_fd.finding_id = review_fs.finding_id
    WHERE review_fs.review_id = ${reviews.reviewId}
      AND (
        review_fd.finding_id IS NULL
        OR NOT (
          (
            review_fd.state = 'published'
            AND (
              (
                review_fd.ghsa_id IS NULL
                AND review_fs.closure_comment_url IS NOT NULL
              )
              OR (
                review_fd.ghsa_id IS NOT NULL
                AND review_fd.ghsa_published_at IS NOT NULL
                AND review_fd.ghsa_html_url IS NOT NULL
              )
            )
          )
          OR (
            review_fd.state = 'none'
            AND ${reviews.publicReceipt} = true
          )
        )
      )
  )
)`;
