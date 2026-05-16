// Vitest setup — runs before each test file. Provides safe-default env vars
// for modules that throw at import-time when their config is missing. Tests
// inject mocks for any DB/network calls, so these values are never used
// against a real backend.

if (!process.env["DATABASE_URL"]) {
  process.env["DATABASE_URL"] = "postgres://test:test@localhost:5432/test";
}
