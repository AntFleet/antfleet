export const SARIF_TOKEN_USE_GC_RETENTION_MS = 60 * 60 * 1000;

export type SarifTokenUseGcDeps = {
  purgeBefore: (cutoff: Date) => Promise<number>;
};

export type SarifTokenUseGcResult = {
  deleted: number;
  cutoff: Date;
};

export async function runSarifTokenUseGc(
  deps: SarifTokenUseGcDeps,
  now: Date = new Date(),
): Promise<SarifTokenUseGcResult> {
  const cutoff = new Date(now.getTime() - SARIF_TOKEN_USE_GC_RETENTION_MS);
  const deleted = await deps.purgeBefore(cutoff);
  return { deleted, cutoff };
}
