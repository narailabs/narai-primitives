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

describe("GithubClient — pull-request methods", () => {
  it("getPull issues GET /repos/o/r/pulls/{n}", async () => {
    let observed: { url: string; method: string } = { url: "", method: "" };
    const client = makeClient(async (url, init) => {
      observed = { url, method: String(init?.method ?? "") };
      return jsonResponse({ number: 1, title: "t", state: "open" });
    });
    const r = await client.getPull("o", "r", 1);
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("GET");
    expect(observed.url).toMatch(/\/repos\/o\/r\/pulls\/1$/);
  });

  it("createPull issues POST with body", async () => {
    let observedBody = "";
    const client = makeClient(async (_url, init) => {
      observedBody = String(init?.body ?? "");
      return jsonResponse({ number: 1, title: "t", state: "open", draft: true });
    });
    const r = await client.createPull("o", "r", {
      title: "t",
      head: "f",
      base: "main",
      draft: true,
    });
    expect(r.ok).toBe(true);
    expect(observedBody).toContain('"title":"t"');
    expect(observedBody).toContain('"draft":true');
  });

  it("updatePull issues PATCH", async () => {
    let observed: { url: string; method: string } = { url: "", method: "" };
    const client = makeClient(async (url, init) => {
      observed = { url, method: String(init?.method ?? "") };
      return jsonResponse({ number: 1, title: "t2", state: "open" });
    });
    const r = await client.updatePull("o", "r", 1, { title: "t2" });
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("PATCH");
    expect(observed.url).toMatch(/\/repos\/o\/r\/pulls\/1$/);
  });

  it("closePull issues PATCH with state=closed", async () => {
    let observedBody = "";
    const client = makeClient(async (_url, init) => {
      observedBody = String(init?.body ?? "");
      return jsonResponse({ number: 1, title: "t", state: "closed" });
    });
    const r = await client.closePull("o", "r", 1);
    expect(r.ok).toBe(true);
    expect(observedBody).toContain('"state":"closed"');
  });

  it("mergePull issues PUT to /merge", async () => {
    let observed: { url: string; method: string; body: string } = {
      url: "",
      method: "",
      body: "",
    };
    const client = makeClient(async (url, init) => {
      observed = {
        url,
        method: String(init?.method ?? ""),
        body: String(init?.body ?? ""),
      };
      return jsonResponse({ sha: "abc", merged: true, message: "ok" });
    });
    const r = await client.mergePull("o", "r", 1, { merge_method: "squash" });
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("PUT");
    expect(observed.url).toMatch(/\/repos\/o\/r\/pulls\/1\/merge$/);
    expect(observed.body).toContain('"merge_method":"squash"');
  });

  it("mergePull surfaces 409 as a structured error with status set", async () => {
    const client = makeClient(async () =>
      jsonResponse({ message: "Head branch was modified" }, 409),
    );
    const r = await client.mergePull("o", "r", 1, { merge_method: "merge" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
    }
  });
});

describe("GithubClient — issue methods", () => {
  it("getIssue issues GET /issues/{n}", async () => {
    let observed = { url: "", method: "" };
    const client = makeClient(async (url, init) => {
      observed = { url, method: String(init?.method ?? "") };
      return jsonResponse({ number: 1, title: "t", state: "open" });
    });
    const r = await client.getIssue("o", "r", 1);
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("GET");
    expect(observed.url).toMatch(/\/repos\/o\/r\/issues\/1$/);
  });
  it("createIssue issues POST /issues", async () => {
    let bodySent = "";
    const client = makeClient(async (_url, init) => {
      bodySent = String(init?.body ?? "");
      return jsonResponse({ number: 2, title: "t", state: "open" });
    });
    const r = await client.createIssue("o", "r", { title: "t" });
    expect(r.ok).toBe(true);
    expect(bodySent).toContain('"title":"t"');
  });
  it("updateIssue issues PATCH /issues/{n}", async () => {
    let observed = { url: "", method: "" };
    const client = makeClient(async (url, init) => {
      observed = { url, method: String(init?.method ?? "") };
      return jsonResponse({ number: 1, title: "t2", state: "open" });
    });
    const r = await client.updateIssue("o", "r", 1, { title: "t2" });
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("PATCH");
  });
  it("closeIssue issues PATCH with state=closed", async () => {
    let bodySent = "";
    const client = makeClient(async (_url, init) => {
      bodySent = String(init?.body ?? "");
      return jsonResponse({ number: 1, title: "t", state: "closed" });
    });
    const r = await client.closeIssue("o", "r", 1, {
      state_reason: "completed",
    });
    expect(r.ok).toBe(true);
    expect(bodySent).toContain('"state":"closed"');
    expect(bodySent).toContain('"state_reason":"completed"');
  });
});

describe("GithubClient — comment methods", () => {
  it("addIssueComment POSTs to /issues/{n}/comments", async () => {
    let observed = { url: "", method: "" };
    const client = makeClient(async (url, init) => {
      observed = { url, method: String(init?.method ?? "") };
      return jsonResponse({ id: 1, user: { login: "a" }, body: "x" });
    });
    const r = await client.addIssueComment("o", "r", 9, { body: "x" });
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("POST");
    expect(observed.url).toMatch(/\/repos\/o\/r\/issues\/9\/comments$/);
  });

  it("updateIssueComment PATCHes /issues/comments/{id}", async () => {
    let observed = { url: "", method: "" };
    const client = makeClient(async (url, init) => {
      observed = { url, method: String(init?.method ?? "") };
      return jsonResponse({ id: 1, user: { login: "a" }, body: "y" });
    });
    const r = await client.updateIssueComment("o", "r", 1, { body: "y" });
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("PATCH");
    expect(observed.url).toMatch(/\/repos\/o\/r\/issues\/comments\/1$/);
  });

  it("deleteIssueComment DELETEs /issues/comments/{id}", async () => {
    let observed = { url: "", method: "" };
    const client = makeClient(async (url, init) => {
      observed = { url, method: String(init?.method ?? "") };
      return new Response(null, { status: 204 });
    });
    const r = await client.deleteIssueComment("o", "r", 1);
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("DELETE");
  });

  it("addPrReviewComment POSTs to /pulls/{n}/comments", async () => {
    let observedBody = "";
    const client = makeClient(async (_url, init) => {
      observedBody = String(init?.body ?? "");
      return jsonResponse({ id: 1, user: { login: "a" }, body: "x", path: "p", line: 1 });
    });
    const r = await client.addPrReviewComment("o", "r", 9, {
      body: "x",
      commit_id: "abcdef0",
      path: "p",
      line: 1,
    });
    expect(r.ok).toBe(true);
    expect(observedBody).toContain('"commit_id":"abcdef0"');
  });

  it("updatePrReviewComment PATCHes /pulls/comments/{id}", async () => {
    let observed = { method: "" };
    const client = makeClient(async (_url, init) => {
      observed = { method: String(init?.method ?? "") };
      return jsonResponse({ id: 1, user: { login: "a" }, body: "y", path: "p", line: 1 });
    });
    const r = await client.updatePrReviewComment("o", "r", 1, { body: "y" });
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("PATCH");
  });

  it("deletePrReviewComment DELETEs /pulls/comments/{id}", async () => {
    let observed = { method: "", url: "" };
    const client = makeClient(async (url, init) => {
      observed = { url, method: String(init?.method ?? "") };
      return new Response(null, { status: 204 });
    });
    const r = await client.deletePrReviewComment("o", "r", 1);
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("DELETE");
    expect(observed.url).toMatch(/\/repos\/o\/r\/pulls\/comments\/1$/);
  });
});

describe("GithubClient — release methods", () => {
  it("createRelease POSTs to /releases", async () => {
    let observed = { method: "", url: "", body: "" };
    const client = makeClient(async (url, init) => {
      observed = {
        method: String(init?.method ?? ""),
        url,
        body: String(init?.body ?? ""),
      };
      return jsonResponse({ id: 1, tag_name: "v1" });
    });
    const r = await client.createRelease("o", "r", { tag_name: "v1", draft: true });
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("POST");
    expect(observed.url).toMatch(/\/repos\/o\/r\/releases$/);
    expect(observed.body).toContain('"draft":true');
  });
  it("updateRelease PATCHes /releases/{id}", async () => {
    let observed = { method: "" };
    const client = makeClient(async (_url, init) => {
      observed = { method: String(init?.method ?? "") };
      return jsonResponse({ id: 1, tag_name: "v1" });
    });
    const r = await client.updateRelease("o", "r", 1, { name: "x" });
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("PATCH");
  });
  it("deleteRelease DELETEs /releases/{id}", async () => {
    let observed = { method: "", url: "" };
    const client = makeClient(async (url, init) => {
      observed = { method: String(init?.method ?? ""), url };
      return new Response(null, { status: 204 });
    });
    const r = await client.deleteRelease("o", "r", 1);
    expect(r.ok).toBe(true);
    expect(observed.method).toBe("DELETE");
    expect(observed.url).toMatch(/\/repos\/o\/r\/releases\/1$/);
  });
  it("deleteReleaseAsset DELETEs /releases/assets/{id}", async () => {
    let observed = { url: "" };
    const client = makeClient(async (url) => {
      observed = { url };
      return new Response(null, { status: 204 });
    });
    const r = await client.deleteReleaseAsset("o", "r", 7);
    expect(r.ok).toBe(true);
    expect(observed.url).toMatch(/\/repos\/o\/r\/releases\/assets\/7$/);
  });
});
