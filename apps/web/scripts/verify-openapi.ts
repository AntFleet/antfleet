#!/usr/bin/env tsx
// Usage: tsx apps/web/scripts/verify-openapi.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const REQUIRED_GET_PATHS = [
  "/api/v1/findings",
  "/api/v1/findings/{finding_id}",
  "/api/v1/agents",
  "/api/v1/agents/{address}",
  "/api/v1/agents/{address}/findings",
  "/api/v1/agents/{address}/drift",
  "/api/v1/stats",
] as const;

type OpenApiLike = {
  paths?: Record<string, { get?: { responses?: Record<string, unknown> } }>;
};

export function parseOpenApiJson(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`openapi.json is not well-formed JSON: ${message}`, { cause: error });
  }
}

export function validateRequiredGetPaths(document: unknown, requiredPaths = REQUIRED_GET_PATHS): string[] {
  const errors: string[] = [];
  if (!isObject(document)) {
    return ["openapi document must be a JSON object"];
  }
  const paths = (document as OpenApiLike).paths;
  if (!isObject(paths)) {
    return ["openapi document must define a paths object"];
  }
  for (const path of requiredPaths) {
    const operation = paths[path]?.get;
    if (!operation) {
      errors.push(`missing GET operation for ${path}`);
      continue;
    }
    if (!operation.responses?.["200"]) errors.push(`missing 200 response for GET ${path}`);
    if (!operation.responses?.["429"]) errors.push(`missing 429 response for GET ${path}`);
  }
  return errors;
}

export function verifyOpenApiDocument(source: string): void {
  const document = parseOpenApiJson(source);
  const errors = validateRequiredGetPaths(document);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const openApiPath = resolve(process.cwd(), "apps/web/public/api/v1/openapi.json");
  try {
    verifyOpenApiDocument(readFileSync(openApiPath, "utf8"));
    console.log(`OpenAPI checks passed: ${openApiPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
