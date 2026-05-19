/** Roast submission lifecycle: awaiting_approval -> queued -> running -> (published | failed), and awaiting_approval -> rejected. */
export const ROAST_STATUSES = [
  "awaiting_approval",
  "queued",
  "running",
  "published",
  "rejected",
  "failed",
] as const;

export type RoastSubmissionStatus = (typeof ROAST_STATUSES)[number];
