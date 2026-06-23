export const DISCLOSURE_STATES = [
  "none",
  "embargoed",
  "maintainer-acknowledged",
  "patch-merged",
  "embargo-expired",
  "published",
] as const;

export type DisclosureState = (typeof DISCLOSURE_STATES)[number];

export type DisclosureActorType = "system" | "maintainer" | "operator";

export const EMBARGO_DAYS = 90;
export const MIN_GRACE_DAYS = 30;

export function isDisclosureState(value: unknown): value is DisclosureState {
  return typeof value === "string" && DISCLOSURE_STATES.includes(value as DisclosureState);
}

export function isHighOrCritical(severity: string): boolean {
  const normalized = severity.trim().toLowerCase();
  return normalized === "high" || normalized === "critical";
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}
