import { describe, expect, it } from "vitest";
import {
  REQUIRED_GET_PATHS,
  parseOpenApiJson,
  validateRequiredGetPaths,
  verifyOpenApiDocument,
} from "./verify-openapi";

function validDocument() {
  return {
    paths: Object.fromEntries(
      REQUIRED_GET_PATHS.map((path) => [
        path,
        {
          get: {
            responses: {
              "200": { description: "ok" },
              "429": { description: "rate limited" },
            },
          },
        },
      ]),
    ),
  };
}

describe("parseOpenApiJson", () => {
  it("parses well-formed JSON", () => {
    expect(parseOpenApiJson('{"paths":{}}')).toEqual({ paths: {} });
  });

  it("throws a clear error for malformed JSON", () => {
    expect(() => parseOpenApiJson("{")).toThrow(/not well-formed JSON/);
  });
});

describe("validateRequiredGetPaths", () => {
  it("accepts all required GET paths with 200 and 429 responses", () => {
    expect(validateRequiredGetPaths(validDocument())).toEqual([]);
  });

  it("reports missing paths and responses", () => {
    const document = validDocument();
    delete (document.paths as Record<string, unknown>)["/api/v1/stats"];
    delete (document.paths["/api/v1/findings"].get.responses as Record<string, unknown>)["429"];

    expect(validateRequiredGetPaths(document)).toEqual([
      "missing 429 response for GET /api/v1/findings",
      "missing GET operation for /api/v1/stats",
    ]);
  });

  it("reports non-object documents", () => {
    expect(validateRequiredGetPaths(null)).toEqual(["openapi document must be a JSON object"]);
    expect(validateRequiredGetPaths({})).toEqual(["openapi document must define a paths object"]);
  });
});

describe("verifyOpenApiDocument", () => {
  it("throws when validation errors are present", () => {
    expect(() => verifyOpenApiDocument('{"paths":{}}')).toThrow(/missing GET operation/);
  });
});
