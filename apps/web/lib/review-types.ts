// Cross-package boundary: re-exports the types apps/web consumes from the
// root @antfleet/cli package. Centralizing the import surface here keeps
// downstream code from reaching directly into the root package's internals,
// so the export field in root/package.json can evolve without rewriting
// callers across the web app.

export type { ReviewOutput } from "@antfleet/cli/types";
export type {
  AgreementMode,
  Disagreement,
  Finding,
  ProviderReview,
} from "@antfleet/cli/providers/agreement";
