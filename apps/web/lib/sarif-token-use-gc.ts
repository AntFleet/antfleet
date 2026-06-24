export const SARIF_TOKEN_USE_GC_RETENTION_MS = 60 * 60 * 1000;
export const SARIF_TOKEN_USE_GC_BATCH_SIZE = 1000;
export const SARIF_TOKEN_USE_GC_MAX_BATCHES = 50;

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
  let deleted = 0;

  for (let batch = 0; batch < SARIF_TOKEN_USE_GC_MAX_BATCHES; batch += 1) {
    const batchDeleted = await deps.purgeBefore(cutoff);
    if (batchDeleted === 0) break;
    deleted += batchDeleted;
    if (batchDeleted < SARIF_TOKEN_USE_GC_BATCH_SIZE) break;
  }

  return { deleted, cutoff };
}
