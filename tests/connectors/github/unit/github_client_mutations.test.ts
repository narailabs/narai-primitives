/**
 * Locks in that the GitHub HTTP surface permits the write-method set
 * needed for PRs, issues, comments, releases, and workflows: GET, POST,
 * PATCH, PUT, DELETE. Each test sends a request via a method that was
 * previously not in `allowedMethods` and asserts the request reaches the
 * fake fetch (i.e., the client did NOT short-circuit with
 * `METHOD_NOT_ALLOWED`).
 */
import { describe, expect, it } from "vitest";
import {
  GithubClient,
  type GithubClientOptions,
} from "../../../../src/connectors/github/lib/github_client.js";

type HttpUnderside = {
  _http: {
    request: (
      m: string,
      p: string,
      o?: unknown,
    ) => Promise<{ ok: boolean; code?: string }>;
  };
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(
  fetchMock: (url: string, init?: RequestInit) => Promise<Response>,
  overrides: Partial<GithubClientOptions> = {},
): GithubClient {
  return new GithubClient({
    token: "ghp_test",
    rateLimitPerMin: 100,
    connectTimeoutMs: 50,
    readTimeoutMs: 50,
    fetchImpl: async (url, init) => fetchMock(String(url), init),
    sleepImpl: async () => {},
    ...overrides,
  });
}

describe("GithubClient — allowedMethods: GET, POST, PATCH, PUT, DELETE", () => {
  it("GET is allowed (getRepo reaches the fake fetch)", async () => {
    let observedMethod = "";
    const client = makeClient(async (_url, init) => {
      observedMethod = String(init?.method ?? "");
      return jsonResponse({ full_name: "a/b" });
    });
    const r = await client.getRepo("a", "b");
    expect(r.ok).toBe(true);
    expect(observedMethod).toBe("GET");
  });

  it("POST is allowed (graphql reaches the fake fetch)", async () => {
    let observedMethod = "";
    const client = makeClient(async (_url, init) => {
      observedMethod = String(init?.method ?? "");
      return jsonResponse({ data: { __typename: "Query" } });
    });
    const r = await client.graphql<{ __typename: string }>(
      "query { __typename }",
      {},
    );
    expect(r.ok).toBe(true);
    expect(observedMethod).toBe("POST");
  });

  it("PATCH is permitted by allowedMethods", async () => {
    let observedMethod = "";
    const client = makeClient(async (_url, init) => {
      observedMethod = String(init?.method ?? "");
      return jsonResponse({ ok: true });
    });
    const r = await (client as unknown as HttpUnderside)._http.request(
      "PATCH",
      "/repos/a/b/issues/1",
      { body: { title: "x" } },
    );
    expect(r.ok).toBe(true);
    expect(observedMethod).toBe("PATCH");
  });

  it("PUT is permitted by allowedMethods", async () => {
    let observedMethod = "";
    const client = makeClient(async (_url, init) => {
      observedMethod = String(init?.method ?? "");
      return jsonResponse({ ok: true });
    });
    const r = await (client as unknown as HttpUnderside)._http.request(
      "PUT",
      "/repos/a/b/pulls/1/merge",
      { body: { merge_method: "squash" } },
    );
    expect(r.ok).toBe(true);
    expect(observedMethod).toBe("PUT");
  });

  it("DELETE is permitted by allowedMethods", async () => {
    let observedMethod = "";
    const client = makeClient(async (_url, init) => {
      observedMethod = String(init?.method ?? "");
      return new Response(null, { status: 204 });
    });
    const r = await (client as unknown as HttpUnderside)._http.request(
      "DELETE",
      "/repos/a/b/issues/comments/1",
    );
    expect(r.ok).toBe(true);
    expect(observedMethod).toBe("DELETE");
  });
});
