/**
 * Tests for shared Zod field schemas in gitlab/actions/_fields.ts.
 * Focuses on namespaceField which was extended to support subgroup paths.
 */
import { describe, expect, it } from "vitest";
import { namespaceField } from "../../../../src/connectors/gitlab/actions/_fields.js";

describe("namespaceField", () => {
  it("accepts a simple namespace", () => {
    expect(() => namespaceField.parse("mycompany")).not.toThrow();
  });

  it("accepts a subgroup namespace with one slash", () => {
    expect(() => namespaceField.parse("mycompany/backend")).not.toThrow();
  });

  it("accepts a deeply nested subgroup namespace", () => {
    expect(() => namespaceField.parse("mycompany/backend/infra")).not.toThrow();
  });

  it("rejects a namespace with a leading slash", () => {
    expect(() => namespaceField.parse("/mycompany")).toThrow();
  });

  it("rejects a namespace with a trailing slash", () => {
    expect(() => namespaceField.parse("mycompany/")).toThrow();
  });

  it("rejects a namespace with consecutive slashes", () => {
    expect(() => namespaceField.parse("mycompany//backend")).toThrow();
  });
});
