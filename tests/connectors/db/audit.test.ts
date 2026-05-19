import { describe, test, expect } from "vitest";
import { scrubSqlSecrets } from "../../../src/connectors/db/lib/audit.js";

describe("scrubSqlSecrets", () => {
  test("redacts Authorization headers in SQL/logs", () => {
    expect(scrubSqlSecrets("Authorization: Bearer token123")).toBe("Authorization: [REDACTED]");
    expect(scrubSqlSecrets("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: [REDACTED]");
    expect(scrubSqlSecrets("AUTHORIZATION: my-api-key")).toBe("AUTHORIZATION: [REDACTED]");
    expect(scrubSqlSecrets('Headers: { "Authorization": "Bearer token123" }')).toBe('Headers: { "Authorization": "[REDACTED]" }');
    expect(scrubSqlSecrets("Authorization: token ghp_abc")).toBe("Authorization: [REDACTED]");
  });
});
