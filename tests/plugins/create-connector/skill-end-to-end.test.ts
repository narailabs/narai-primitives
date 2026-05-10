import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSettingsHook } from "../../../plugins/create-connector/skills/create-connector/lib/settings-wiring.mjs";
import { registerConnector } from "../../../plugins/create-connector/skills/create-connector/lib/connector-registry.mjs";

const TEMPLATES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "plugins",
  "create-connector",
  "skills",
  "create-connector",
  "assets",
  "templates",
);

describe("create-connector end-to-end (shell-gate flavor)", () => {
  let scope: string;

  beforeEach(() => {
    scope = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
  });

  afterEach(() => fs.rmSync(scope, { recursive: true, force: true }));

  it("stamps a working shell-gate connector end-to-end", async () => {
    // 1. Stamp connector-gate.mjs from template (ESM — stamps verbatim).
    const runtimeSrc = fs.readFileSync(
      path.join(TEMPLATES, "_runtime", "connector-gate.mjs.tmpl"),
      "utf-8",
    );
    const connectorsBin = path.join(scope, ".connectors");
    fs.mkdirSync(connectorsBin, { recursive: true });

    const gateMjsPath = path.join(connectorsBin, "connector-gate.mjs");
    fs.writeFileSync(gateMjsPath, runtimeSrc);

    // 2. Stamp the shell-gate connector files.
    const slug = "deploy-prod";
    const dir = path.join(connectorsBin, "connectors", slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "gates.json"),
      JSON.stringify({
        rules: [
          {
            name: "deny_prod_kubectl",
            decision: "deny",
            reason: "no direct prod kubectl",
            pattern: "^kubectl\\s+.*\\bprod\\b",
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      "---\nname: deploy-prod\ndescription: gate prod kubectl\ncontext: connector\n---\n",
    );

    // 3. Register in config.yaml via the helper.
    registerConnector(scope, slug, {
      skill: dir,
      bin: null,
    });

    // 4. Wire settings.json via the helper (uses the canonical .mjs path).
    const settingsPath = path.join(scope, ".claude", "settings.json");
    ensureSettingsHook(settingsPath, gateMjsPath);

    // 5. Smoke-test the gate by spawning the .mjs file directly.
    const result = await new Promise<{ stdout: string; exitCode: number }>(
      (resolve) => {
        const proc = spawn("node", [gateMjsPath], {
          env: { ...process.env, NARAI_GATE_SCOPE: scope },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
        proc.on("close", (code) =>
          resolve({ stdout, exitCode: code ?? -1 }),
        );
        proc.stdin.write(
          JSON.stringify({
            tool_name: "Bash",
            tool_input: { command: "kubectl get pods -n prod" },
          }),
        );
        proc.stdin.end();
      },
    );

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/prod/);

    // 6. Verify settings.json wires the gate (canonical .mjs path).
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
    expect(cmd).toContain(gateMjsPath);

    // 7. Verify config.yaml has the connector registered.
    const cfg = fs.readFileSync(
      path.join(scope, ".connectors", "config.yaml"),
      "utf-8",
    );
    expect(cfg).toContain("deploy-prod:");
    expect(cfg).toContain("enabled: true");
  });
});
