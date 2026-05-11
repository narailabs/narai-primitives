# Task 2: Behavior config loader (`require_draft_pr`)

**Files:**
- Create: `src/connectors/github/lib/github_config.ts`
- Test: `tests/connectors/github/unit/github_config.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/connectors/github/unit/github_config.test.ts`:

```ts
/**
 * Tests for loadGithubBehavior — the connector's tiny config layer for
 * runtime knobs that aren't part of the toolkit's policy/approval YAML.
 * Precedence (highest wins):
 *   1. GITHUB_REQUIRE_DRAFT_PR env var
 *   2. <cwd>/.github-agent/config.yaml `github.require_draft_pr`
 *   3. ~/.github-agent/config.yaml  `github.require_draft_pr`
 *   4. default: false
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadGithubBehavior } from "../../../../src/connectors/github/lib/github_config.js";

let tmpHome = "";
let tmpCwd = "";

function writeYaml(rootDir: string, body: string): void {
  const dir = path.join(rootDir, ".github-agent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), body, "utf-8");
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gh-cfg-home-"));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "gh-cfg-cwd-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe("loadGithubBehavior — defaults", () => {
  it("returns requireDraftPr=false when nothing is configured", () => {
    const b = loadGithubBehavior({ home: tmpHome, cwd: tmpCwd, env: {} });
    expect(b.requireDraftPr).toBe(false);
  });
});

describe("loadGithubBehavior — YAML sources", () => {
  it("reads user-level YAML", () => {
    writeYaml(tmpHome, "github:\n  require_draft_pr: true\n");
    const b = loadGithubBehavior({ home: tmpHome, cwd: tmpCwd, env: {} });
    expect(b.requireDraftPr).toBe(true);
  });

  it("reads repo-level YAML", () => {
    writeYaml(tmpCwd, "github:\n  require_draft_pr: true\n");
    const b = loadGithubBehavior({ home: tmpHome, cwd: tmpCwd, env: {} });
    expect(b.requireDraftPr).toBe(true);
  });

  it("repo overlay wins over user-level on collision", () => {
    writeYaml(tmpHome, "github:\n  require_draft_pr: true\n");
    writeYaml(tmpCwd, "github:\n  require_draft_pr: false\n");
    const b = loadGithubBehavior({ home: tmpHome, cwd: tmpCwd, env: {} });
    expect(b.requireDraftPr).toBe(false);
  });

  it("user-level wins when only user-level sets the key", () => {
    writeYaml(tmpHome, "github:\n  require_draft_pr: true\n");
    writeYaml(tmpCwd, "policy:\n  read: success\n");
    const b = loadGithubBehavior({ home: tmpHome, cwd: tmpCwd, env: {} });
    expect(b.requireDraftPr).toBe(true);
  });

  it("ignores files that don't have the github section", () => {
    writeYaml(tmpHome, "policy:\n  read: success\n");
    const b = loadGithubBehavior({ home: tmpHome, cwd: tmpCwd, env: {} });
    expect(b.requireDraftPr).toBe(false);
  });

  it("rejects a non-boolean github.require_draft_pr", () => {
    writeYaml(tmpHome, "github:\n  require_draft_pr: maybe\n");
    expect(() =>
      loadGithubBehavior({ home: tmpHome, cwd: tmpCwd, env: {} }),
    ).toThrow(/require_draft_pr/);
  });
});

describe("loadGithubBehavior — env override", () => {
  it("env=1 forces true even if YAML says false", () => {
    writeYaml(tmpHome, "github:\n  require_draft_pr: false\n");
    const b = loadGithubBehavior({
      home: tmpHome,
      cwd: tmpCwd,
      env: { GITHUB_REQUIRE_DRAFT_PR: "1" },
    });
    expect(b.requireDraftPr).toBe(true);
  });

  it("env=true forces true", () => {
    const b = loadGithubBehavior({
      home: tmpHome,
      cwd: tmpCwd,
      env: { GITHUB_REQUIRE_DRAFT_PR: "true" },
    });
    expect(b.requireDraftPr).toBe(true);
  });

  it("env=yes forces true", () => {
    const b = loadGithubBehavior({
      home: tmpHome,
      cwd: tmpCwd,
      env: { GITHUB_REQUIRE_DRAFT_PR: "yes" },
    });
    expect(b.requireDraftPr).toBe(true);
  });

  it("env=0 forces false even if YAML says true", () => {
    writeYaml(tmpHome, "github:\n  require_draft_pr: true\n");
    const b = loadGithubBehavior({
      home: tmpHome,
      cwd: tmpCwd,
      env: { GITHUB_REQUIRE_DRAFT_PR: "0" },
    });
    expect(b.requireDraftPr).toBe(false);
  });

  it("env=false forces false", () => {
    writeYaml(tmpHome, "github:\n  require_draft_pr: true\n");
    const b = loadGithubBehavior({
      home: tmpHome,
      cwd: tmpCwd,
      env: { GITHUB_REQUIRE_DRAFT_PR: "false" },
    });
    expect(b.requireDraftPr).toBe(false);
  });

  it("env empty string falls through to YAML", () => {
    writeYaml(tmpHome, "github:\n  require_draft_pr: true\n");
    const b = loadGithubBehavior({
      home: tmpHome,
      cwd: tmpCwd,
      env: { GITHUB_REQUIRE_DRAFT_PR: "" },
    });
    expect(b.requireDraftPr).toBe(true);
  });

  it("env with unrecognized value throws CONFIG_ERROR", () => {
    expect(() =>
      loadGithubBehavior({
        home: tmpHome,
        cwd: tmpCwd,
        env: { GITHUB_REQUIRE_DRAFT_PR: "maybe" },
      }),
    ).toThrow(/GITHUB_REQUIRE_DRAFT_PR/);
  });
});
```

- [ ] **Step 2: Run the test file — it should fail with module-not-found**

Run:
```
npx vitest run tests/connectors/github/unit/github_config.test.ts
```
Expected: All tests fail because `github_config.ts` does not exist yet.

- [ ] **Step 3: Implement `lib/github_config.ts`**

Create `src/connectors/github/lib/github_config.ts`:

```ts
/**
 * Connector-specific runtime knobs that sit outside the toolkit's
 * policy/approval YAML. Today: `require_draft_pr` — when true, every
 * `create_pull_request` call is rewritten to `draft: true` regardless of
 * caller input.
 *
 * Precedence (highest wins):
 *   1. GITHUB_REQUIRE_DRAFT_PR env var
 *   2. <cwd>/.github-agent/config.yaml `github.require_draft_pr`
 *   3. ~/.github-agent/config.yaml  `github.require_draft_pr`
 *   4. default: false
 *
 * Replicates the toolkit's discover-and-merge pattern locally (~25
 * lines) so we don't depend on internals of `toolkit/policy/config.ts`
 * that aren't part of its public surface.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";

export interface GithubBehavior {
  requireDraftPr: boolean;
}

export interface LoadGithubBehaviorOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

const TRUTHY = new Set(["1", "true", "yes"]);
const FALSY = new Set(["0", "false", "no"]);

function readYamlFile(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = yaml.load(raw);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `github config: expected a YAML mapping at root of ${filePath}, got ${
        Array.isArray(parsed) ? "list" : typeof parsed
      }`,
    );
  }
  return parsed as Record<string, unknown>;
}

function readGithubSectionFlag(
  configPath: string,
  key: string,
): boolean | undefined {
  const doc = readYamlFile(configPath);
  if (doc === null) return undefined;
  const section = doc["github"];
  if (section === undefined) return undefined;
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new Error(
      `github config: 'github:' section in ${configPath} must be a mapping`,
    );
  }
  const value = (section as Record<string, unknown>)[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(
      `github config: 'github.${key}' in ${configPath} must be a boolean, got ${typeof value}`,
    );
  }
  return value;
}

function parseEnvOverride(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  const v = raw.toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  throw new Error(
    `GITHUB_REQUIRE_DRAFT_PR: expected one of 1/0/true/false/yes/no, got ${JSON.stringify(raw)}`,
  );
}

export function loadGithubBehavior(
  opts: LoadGithubBehaviorOptions = {},
): GithubBehavior {
  const home = opts.home ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  let requireDraftPr = false;

  const userVal = readGithubSectionFlag(
    path.join(home, ".github-agent", "config.yaml"),
    "require_draft_pr",
  );
  if (userVal !== undefined) requireDraftPr = userVal;

  const repoVal = readGithubSectionFlag(
    path.join(cwd, ".github-agent", "config.yaml"),
    "require_draft_pr",
  );
  if (repoVal !== undefined) requireDraftPr = repoVal;

  const envVal = parseEnvOverride(env["GITHUB_REQUIRE_DRAFT_PR"]);
  if (envVal !== undefined) requireDraftPr = envVal;

  return { requireDraftPr };
}
```

- [ ] **Step 4: Run the test file — confirm all 13 tests pass**

Run:
```
npx vitest run tests/connectors/github/unit/github_config.test.ts
```
Expected: 13 passing.

- [ ] **Step 5: Run the full github test directory to confirm no regressions**

Run:
```
npx vitest run tests/connectors/github
```
Expected: previously-passing tests still pass; 13 new passing tests from this file.

- [ ] **Step 6: Commit**

```
git add src/connectors/github/lib/github_config.ts tests/connectors/github/unit/github_config.test.ts
git commit -m "feat(github): add loadGithubBehavior for require_draft_pr knob

Adds a tiny per-connector config layer that sits alongside (not inside)
the toolkit's policy/approval YAML. Source precedence:
  env (GITHUB_REQUIRE_DRAFT_PR) > repo overlay > user-level > default false.
Invalid YAML or env values throw at startup with a precise message —
no silent coercion.

The flag will be consumed by create_pull_request in a later task to
force draft creation even when the caller passes draft: false."
```
