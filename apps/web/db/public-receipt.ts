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
