/**
 * Adversarial unit tests for the external_write gate matcher.
 *
 * The matcher must fire on a state-changing HTTP request (curl -X/--request,
 * wget --method, or HTTPie positional form) targeting an allowlisted host,
 * and must NOT be spoofable into matching an allowlisted host via path,
 * query, userinfo, subdomain-suffix, or label-prefix tricks.
 */
import { describe, it, expect } from "vitest";
import { buildExternalWriteMatcher } from "../../plugin-hooks/dispatcher.mjs";

const HOST_RULE = {
  type: "external_write",
  decision: "ask",
  methods: ["POST", "PUT", "DELETE", "PATCH"],
  allowed_hosts: ["atlassian.net"],
};

describe("external_write — host+verb matching", () => {
  const m = buildExternalWriteMatcher(HOST_RULE);

  it.each([
    "curl -X POST https://x.atlassian.net/rest/api/2/issue",
    "curl --request DELETE https://atlassian.net/x",
    "curl -X post https://atlassian.net/x", // lowercase verb
    "curl -XPOST https://atlassian.net/x", // no space after -X
    "curl -X POST https://foo.bar.atlassian.net/x", // deep subdomain
    "wget --method=POST https://atlassian.net/x",
    "https POST atlassian.net/rest/api", // HTTPie positional, scheme-less host
    "https PUT https://atlassian.net/x", // HTTPie with explicit scheme
    "FOO=bar curl -X POST https://atlassian.net/x", // env prefix
  ])("fires on %s", (cmd) => {
    expect(m(cmd)).toBe(true);
  });

  it.each([
    "curl https://atlassian.net/x", // GET (no verb)
    "curl -X GET https://atlassian.net/x", // GET not in methods
    "curl -X POST https://evil.com/x", // host not allowlisted
    "curl -X POST https://evil.com/jira", // path token, host evil
    "curl -X POST https://evil.com/atlassian.net/x", // host in path
    "curl -X POST https://atlassian.net.evil.com/x", // suffix spoof
    "curl -X POST https://user:atlassian.net@evil.com/x", // userinfo spoof
    "curl -X POST https://evil-atlassian.net/x", // label-prefix spoof
    "curl -X POST https://notatlassian.net/x", // prefix spoof
    'echo "POST to https://atlassian.net"', // mention only, no verb flag
    "echo https POST atlassian.net", // not anchored at segment start
    "curl -x http://atlassian.net:8080 https://other.com/x", // -x is proxy, no method
  ])("does NOT fire on %s", (cmd) => {
    expect(m(cmd)).toBe(false);
  });

  it("matches case-insensitively on the host", () => {
    expect(m("curl -X POST https://X.ATLASSIAN.NET/x")).toBe(true);
  });
});

describe("external_write — write_cli", () => {
  const m = buildExternalWriteMatcher({
    type: "external_write",
    decision: "deny",
    methods: ["POST"],
    allowed_hosts: [],
    write_cli: ["glab mr create"],
  });

  it("fires on the configured write subcommand", () => {
    expect(m("glab mr create --title x")).toBe(true);
  });
  it("does not fire on a read subcommand", () => {
    expect(m("glab mr list")).toBe(false);
  });
});

describe("external_write — malformed rule throws", () => {
  it("throws on empty methods", () => {
    expect(() =>
      buildExternalWriteMatcher({ type: "external_write", methods: [], allowed_hosts: ["x"] }),
    ).toThrow();
  });
  it("throws on missing allowed_hosts", () => {
    expect(() =>
      buildExternalWriteMatcher({ type: "external_write", methods: ["POST"] }),
    ).toThrow();
  });
  it("throws on non-string write_cli", () => {
    expect(() =>
      buildExternalWriteMatcher({
        type: "external_write",
        methods: ["POST"],
        allowed_hosts: [],
        write_cli: [42],
      }),
    ).toThrow();
  });
});
