import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadConnectorEnvironment } from "../../src/config/bootstrap.js";
import type { ResolvedConnector } from "../../src/config/types.js";

let tmpHome: string;
let tmpCwd: string;
const originalHome = process.env["HOME"];
const originalBlob = process.env["NARAI_CONFIG_BLOB"];
// Snapshot the exact env var names this suite mutates so cleanup is precise.
const TOUCHED_ENV_KEYS = [
  "JIRA_API_TOKEN",
  "JIRA_EMAIL",
  "JIRA_SITE_URL",
  "MY_TOKEN_SOURCE",
];
const originalTouched: Record<string, string | undefined> = {};
for (const k of TOUCHED_ENV_KEYS) originalTouched[k] = process.env[k];

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-boot-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-boot-cwd-"));
  process.env["HOME"] = tmpHome;
  delete process.env["NARAI_CONFIG_BLOB"];
  for (const k of TOUCHED_ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (originalBlob === undefined) delete process.env["NARAI_CONFIG_BLOB"];
  else process.env["NARAI_CONFIG_BLOB"] = originalBlob;
  for (const k of TOUCHED_ENV_KEYS) {
    if (originalTouched[k] === undefined) delete process.env[k];
    else process.env[k] = originalTouched[k]!;
  }
});

describe("loadConnectorEnvironment — NARAI_CONFIG_BLOB path", () => {
  it("uses the blob when present and applies env mapping", async () => {
    const slice: ResolvedConnector = {
      name: "jira",
      enabled: true,
      skill: "jira-agent-connector",
      model: null,
      enforce_hooks: true,
      policy: {},
      options: {
        site_url: "https://example.atlassian.net",
        email: "literal@example.com",
        api_token: "literal-token",
      },
    };
    process.env["NARAI_CONFIG_BLOB"] = JSON.stringify(slice);

    const result = await loadConnectorEnvironment("jira", {
      cwd: tmpCwd,
      envMapping: {
        site_url: "JIRA_SITE_URL",
        email: "JIRA_EMAIL",
        api_token: "JIRA_API_TOKEN",
      },
    });
    expect(result?.name).toBe("jira");
    expect(process.env["JIRA_SITE_URL"]).toBe("https://example.atlassian.net");
    expect(process.env["JIRA_EMAIL"]).toBe("literal@example.com");
    expect(process.env["JIRA_API_TOKEN"]).toBe("literal-token");
  });

  it("resolves env:NAME references at apply time", async () => {
    process.env["MY_TOKEN_SOURCE"] = "indirect-token";
    const slice: ResolvedConnector = {
      name: "jira",
      enabled: true,
      skill: "jira-agent-connector",
      model: null,
      enforce_hooks: true,
      policy: {},
      options: { api_token: "env:MY_TOKEN_SOURCE" },
    };
    process.env["NARAI_CONFIG_BLOB"] = JSON.stringify(slice);

    await loadConnectorEnvironment("jira", {
      cwd: tmpCwd,
      envMapping: { api_token: "JIRA_API_TOKEN" },
    });
    expect(process.env["JIRA_API_TOKEN"]).toBe("indirect-token");
  });

  it("does not overwrite existing env vars by default", async () => {
    process.env["JIRA_API_TOKEN"] = "set-by-user";
    const slice: ResolvedConnector = {
      name: "jira",
      enabled: true,
      skill: "jira-agent-connector",
      model: null,
      enforce_hooks: true,
      policy: {},
      options: { api_token: "from-config" },
    };
    process.env["NARAI_CONFIG_BLOB"] = JSON.stringify(slice);

    await loadConnectorEnvironment("jira", {
      cwd: tmpCwd,
      envMapping: { api_token: "JIRA_API_TOKEN" },
    });
    expect(process.env["JIRA_API_TOKEN"]).toBe("set-by-user");
  });

  it("overwrite: true overrides existing env vars", async () => {
    process.env["JIRA_API_TOKEN"] = "set-by-user";
    const slice: ResolvedConnector = {
      name: "jira",
      enabled: true,
      skill: "jira-agent-connector",
      model: null,
      enforce_hooks: true,
      policy: {},
      options: { api_token: "from-config" },
    };
    process.env["NARAI_CONFIG_BLOB"] = JSON.stringify(slice);

    await loadConnectorEnvironment("jira", {
      cwd: tmpCwd,
      envMapping: { api_token: "JIRA_API_TOKEN" },
      overwrite: true,
    });
    expect(process.env["JIRA_API_TOKEN"]).toBe("from-config");
  });

  it("falls through to file load when blob is malformed", async () => {
    process.env["NARAI_CONFIG_BLOB"] = "{not-json";
    fs.mkdirSync(path.join(tmpCwd, ".connectors"));
    fs.writeFileSync(
      path.join(tmpCwd, ".connectors", "config.yaml"),
      `connectors:
  jira:
    skill: jira-agent-connector
    api_token: from-file
`,
    );
    await loadConnectorEnvironment("jira", {
      cwd: tmpCwd,
      envMapping: { api_token: "JIRA_API_TOKEN" },
    });
    expect(process.env["JIRA_API_TOKEN"]).toBe("from-file");
  });

  it("ignores env: refs that point to undefined env vars", async () => {
    delete process.env["UNDEFINED_AT_RUNTIME"];
    const slice: ResolvedConnector = {
      name: "jira",
      enabled: true,
      skill: "jira-agent-connector",
      model: null,
      enforce_hooks: true,
      policy: {},
      options: { api_token: "env:UNDEFINED_AT_RUNTIME" },
    };
    process.env["NARAI_CONFIG_BLOB"] = JSON.stringify(slice);

    await loadConnectorEnvironment("jira", {
      cwd: tmpCwd,
      envMapping: { api_token: "JIRA_API_TOKEN" },
    });
    expect(process.env["JIRA_API_TOKEN"]).toBeUndefined();
  });

  it("ignores non-string option values", async () => {
    const slice: ResolvedConnector = {
      name: "jira",
      enabled: true,
      skill: "jira-agent-connector",
      model: null,
      enforce_hooks: true,
      policy: {},
      options: { api_token: 123 as unknown as string },
    };
    process.env["NARAI_CONFIG_BLOB"] = JSON.stringify(slice);

    await loadConnectorEnvironment("jira", {
      cwd: tmpCwd,
      envMapping: { api_token: "JIRA_API_TOKEN" },
    });
    expect(process.env["JIRA_API_TOKEN"]).toBeUndefined();
  });
});

describe("loadConnectorEnvironment — file fallback", () => {
  it("returns null when no config file and no blob", async () => {
    const result = await loadConnectorEnvironment("jira", {
      cwd: tmpCwd,
      envMapping: { api_token: "JIRA_API_TOKEN" },
    });
    expect(result).toBeNull();
    expect(process.env["JIRA_API_TOKEN"]).toBeUndefined();
  });

  it("returns null when connector is missing from the file", async () => {
    fs.mkdirSync(path.join(tmpCwd, ".connectors"));
    fs.writeFileSync(
      path.join(tmpCwd, ".connectors", "config.yaml"),
      `connectors:
  github:
    skill: github-agent-connector
`,
    );
    const result = await loadConnectorEnvironment("jira", {
      cwd: tmpCwd,
      envMapping: { api_token: "JIRA_API_TOKEN" },
    });
    expect(result).toBeNull();
  });

  it("loads connector slice from file and applies mapping", async () => {
    fs.mkdirSync(path.join(tmpCwd, ".connectors"));
    fs.writeFileSync(
      path.join(tmpCwd, ".connectors", "config.yaml"),
      `connectors:
  jira:
    skill: jira-agent-connector
    api_token: file-token
    site_url: https://x.atlassian.net
`,
    );
    const result = await loadConnectorEnvironment("jira", {
      cwd: tmpCwd,
      envMapping: {
        api_token: "JIRA_API_TOKEN",
        site_url: "JIRA_SITE_URL",
      },
    });
    expect(result?.name).toBe("jira");
    expect(process.env["JIRA_API_TOKEN"]).toBe("file-token");
    expect(process.env["JIRA_SITE_URL"]).toBe("https://x.atlassian.net");
  });

  it("supports consumer override at file load", async () => {
    fs.mkdirSync(path.join(tmpCwd, ".connectors"));
    fs.writeFileSync(
      path.join(tmpCwd, ".connectors", "config.yaml"),
      `connectors:
  jira:
    skill: jira-agent-connector
    api_token: base-token
consumers:
  my-app:
    jira:
      api_token: app-token
`,
    );
    await loadConnectorEnvironment("jira", {
      cwd: tmpCwd,
      consumer: "my-app",
      envMapping: { api_token: "JIRA_API_TOKEN" },
    });
    expect(process.env["JIRA_API_TOKEN"]).toBe("app-token");
  });
});
