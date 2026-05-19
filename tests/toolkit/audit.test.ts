import { describe, test, expect } from "vitest";
import { scrubSecrets } from "../../src/toolkit/audit/writer.js";

describe("scrubSecrets", () => {
  test("redacts Authorization headers", () => {
    expect(scrubSecrets("Authorization: Bearer token123")).toBe("Authorization: [REDACTED]");
    expect(scrubSecrets("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: [REDACTED]");
    expect(scrubSecrets("AUTHORIZATION: my-api-key")).toBe("AUTHORIZATION: [REDACTED]");
    expect(scrubSecrets('Headers: { "Authorization": "Bearer token123" }')).toBe('Headers: { "Authorization": "[REDACTED]" }');
    expect(scrubSecrets("Authorization: token ghp_abc")).toBe("Authorization: [REDACTED]");
  });
});
