ALTER TABLE "agent_findings" ADD COLUMN IF NOT EXISTS "bench_repo_name" text;

UPDATE "agent_findings"
SET "bench_repo_name" = 'aeon-bench'
WHERE lower("agent_name") = 'aeon'
  AND "bench_repo_name" IS NULL;

UPDATE "agent_findings"
SET "bench_repo_name" = 'agent-autonomopoly-bench'
WHERE lower("agent_name") = 'agent-autonomopoly'
  AND "bench_repo_name" IS NULL;

UPDATE "agent_findings"
SET "bench_repo_name" = 'agent-openhuman-bench'
WHERE lower("agent_name") = 'openhuman'
  AND "bench_repo_name" IS NULL;
