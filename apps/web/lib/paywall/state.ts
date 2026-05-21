// Status vocabulary for the agent paywall state machine. Mirrors the docs
// on `installations.status` in db/schema.ts. Kept as `as const` (not a TS
// enum) so the values flow through Zod without a translation layer.

export const PAYWALL_STATUS = {
  pendingBinding: "pending_binding",
  awaitingDeposit: "awaiting_deposit",
  active: "active",
} as const;

export type PaywallStatus = (typeof PAYWALL_STATUS)[keyof typeof PAYWALL_STATUS];

export function isPaywallStatus(value: string): value is PaywallStatus {
  return (
    value === PAYWALL_STATUS.pendingBinding ||
    value === PAYWALL_STATUS.awaitingDeposit ||
    value === PAYWALL_STATUS.active
  );
}
