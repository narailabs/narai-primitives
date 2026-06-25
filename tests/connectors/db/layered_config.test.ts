/**
 * Regression: locks in the existing two-level user+repo config overlay for
 * the `db` connector. A repo-level `<cwd>/.connectors/config.yaml` overlays
 * the user-level `~/.connectors/config.yaml` (repo wins), and the resolved
 * slice still passes through `pluginConfigFromSlice` -> `validateServer`, so
 * the admin/privilege safety floor cannot be lifted by an overlay.
 *
 * Isolation: the loader reads `os.homedir()` for the user file, which honors
 * `process.env.HOME` on this platform, and accepts an explicit `cwd` for the
 * repo file. We point both at fresh temp dirs so the test never touches the
 * developer's real `~/.connectors/config.yaml` or actual cwd.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadResolvedConfig } from "../../../src/config/load.js";
import {
  mergePolicy,
  pluginConfigFromSlice,
} from "../../../src/connectors/db/lib/plugin_config.js";

let tmpHome: string;
let tmpCwd: string;
const originalHome = process.env["HOME"];

function writeUserConfig(body: string): void {
  const dir = path.join(tmpHome, ".connectors");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), body, "utf-8");
}

function writeRepoConfig(body: string): void {
  const dir = path.join(tmpCwd, ".connectors");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), body, "utf-8");
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "db-layered-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "db-layered-cwd-"));
  process.env["HOME"] = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
});

describe("db layered config (user + repo overlay)", () => {
  it("repo overlay wins over user for server host and global write policy", async () => {
    writeUserConfig(
      [
        "connectors:",
        "  db:",
        "    skill: db-agent-connector",
        "    policy:",
        "      write: escalate",
        "    servers:",
        "      orders:",
        "        driver: postgresql",
        "        host: db.shared.internal",
        "        database: orders",
        "",
      ].join("\n"),
    );
    writeRepoConfig(
      [
        "connectors:",
        "  db:",
        "    policy:",
        "      write: deny",
        "    servers:",
        "      orders:",
        "        host: db.local.test",
        "",
      ].join("\n"),
    );

    const resolved = await loadResolvedConfig({ cwd: tmpCwd });
    const slice = resolved.connectors["db"];
    expect(slice).toBeDefined();

    const cfg = pluginConfigFromSlice(slice!);

    // Repo host wins; user-only keys (driver, database) are inherited.
    expect(cfg.servers["orders"]?.["host"]).toBe("db.local.test");
    expect(cfg.servers["orders"]?.driver).toBe("postgresql");
    expect(cfg.servers["orders"]?.["database"]).toBe("orders");

    // Repo global write policy wins. mergePolicy(global, server) reflects it.
    const effective = mergePolicy(cfg.policy, cfg.servers["orders"]?.policy);
    expect(effective.write).toBe("deny");
  });

  it("per-server repo policy override is merged onto the global policy", async () => {
    writeUserConfig(
      [
        "connectors:",
        "  db:",
        "    skill: db-agent-connector",
        "    servers:",
        "      orders:",
        "        driver: sqlite",
        "        database: base.db",
        "",
      ].join("\n"),
    );
    writeRepoConfig(
      [
        "connectors:",
        "  db:",
        "    servers:",
        "      orders:",
        "        policy:",
        "          read: deny",
        "",
      ].join("\n"),
    );

    const resolved = await loadResolvedConfig({ cwd: tmpCwd });
    const cfg = pluginConfigFromSlice(resolved.connectors["db"]!);
    const effective = mergePolicy(cfg.policy, cfg.servers["orders"]?.policy);
    expect(effective.read).toBe("deny");
  });

  it("uses user-level values when no repo file is present", async () => {
    writeUserConfig(
      [
        "connectors:",
        "  db:",
        "    skill: db-agent-connector",
        "    servers:",
        "      orders:",
        "        driver: postgresql",
        "        host: db.shared.internal",
        "        database: orders",
        "",
      ].join("\n"),
    );

    const resolved = await loadResolvedConfig({ cwd: tmpCwd });
    const cfg = pluginConfigFromSlice(resolved.connectors["db"]!);
    expect(cfg.servers["orders"]?.["host"]).toBe("db.shared.internal");
  });

  it("repo overlay cannot lift the admin ceiling (validation throws)", async () => {
    writeUserConfig(
      [
        "connectors:",
        "  db:",
        "    skill: db-agent-connector",
        "    servers:",
        "      orders:",
        "        driver: sqlite",
        "        database: base.db",
        "",
      ].join("\n"),
    );
    writeRepoConfig(
      [
        "connectors:",
        "  db:",
        "    servers:",
        "      orders:",
        "        policy:",
        "          admin: allow",
        "",
      ].join("\n"),
    );

    const resolved = await loadResolvedConfig({ cwd: tmpCwd });
    expect(() => pluginConfigFromSlice(resolved.connectors["db"]!)).toThrow(
      /admin: 'allow' is not permitted/,
    );
  });

  it("repo overlay cannot lift the privilege ceiling (validation throws)", async () => {
    writeUserConfig(
      [
        "connectors:",
        "  db:",
        "    skill: db-agent-connector",
        "    servers:",
        "      orders:",
        "        driver: sqlite",
        "        database: base.db",
        "",
      ].join("\n"),
    );
    writeRepoConfig(
      [
        "connectors:",
        "  db:",
        "    servers:",
        "      orders:",
        "        policy:",
        "          privilege: allow",
        "",
      ].join("\n"),
    );

    const resolved = await loadResolvedConfig({ cwd: tmpCwd });
    expect(() => pluginConfigFromSlice(resolved.connectors["db"]!)).toThrow(
      /privilege: 'allow' is not permitted/,
    );
  });
});
