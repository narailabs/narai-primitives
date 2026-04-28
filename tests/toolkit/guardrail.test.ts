import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  loadGuardrailManifest,
  findBlockingRule,
  defaultDenyMessage,
  type GuardrailManifest,
} from "../../src/toolkit/guardrail.js";

const DB_MANIFEST: GuardrailManifest = {
  version: 1,
  name: "db-agent-connector",
  rules: [
    {
      block_first_token_basename: [
        "psql",
        "mysql",
        "mariadb",
        "sqlite3",
        "mongosh",
        "mongo",
        "pg_dump",
        "mysqldump",
        "duckdb",
      ],
      block_two_token_command: ["aws dynamodb"],
      redirect: "Use db-agent --action query --params '{...}' instead.",
    },
  ],
};

describe("loadGuardrailManifest", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tk-guard-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("loads a valid manifest", () => {
    const p = path.join(tmp, "g.json");
    fs.writeFileSync(p, JSON.stringify(DB_MANIFEST));
    const m = loadGuardrailManifest(p);
    expect(m.name).toBe("db-agent-connector");
    expect(m.rules).toHaveLength(1);
  });

  it("rejects bad JSON", () => {
    const p = path.join(tmp, "bad.json");
    fs.writeFileSync(p, "{not-json");
    expect(() => loadGuardrailManifest(p)).toThrow(/Failed to parse guardrail manifest/);
  });

  it("requires version: 1", () => {
    const p = path.join(tmp, "v.json");
    fs.writeFileSync(p, JSON.stringify({ version: 2, name: "x", rules: [] }));
    expect(() => loadGuardrailManifest(p)).toThrow(/version: 1/);
  });

  it("requires non-empty name", () => {
    const p = path.join(tmp, "n.json");
    fs.writeFileSync(p, JSON.stringify({ version: 1, name: "", rules: [] }));
    expect(() => loadGuardrailManifest(p)).toThrow(/non-empty 'name'/);
  });

  it("requires rules to be an array", () => {
    const p = path.join(tmp, "r.json");
    fs.writeFileSync(p, JSON.stringify({ version: 1, name: "x", rules: "no" }));
    expect(() => loadGuardrailManifest(p)).toThrow(/'rules' array/);
  });

  it("requires rules to be objects", () => {
    const p = path.join(tmp, "r2.json");
    fs.writeFileSync(p, JSON.stringify({ version: 1, name: "x", rules: ["bad"] }));
    expect(() => loadGuardrailManifest(p)).toThrow(/rules\[0\]/);
  });

  it("rejects array as top-level", () => {
    const p = path.join(tmp, "a.json");
    fs.writeFileSync(p, JSON.stringify(["nope"]));
    expect(() => loadGuardrailManifest(p)).toThrow(/JSON object/);
  });
});

describe("findBlockingRule — first-token basename match", () => {
  it("blocks a bare psql call", () => {
    const m = findBlockingRule("psql -h example.com -U user db", [DB_MANIFEST]);
    expect(m?.blockedToken).toBe("psql");
    expect(m?.manifest.name).toBe("db-agent-connector");
  });

  it("blocks /usr/bin/psql by basename", () => {
    const m = findBlockingRule("/usr/bin/psql -V", [DB_MANIFEST]);
    expect(m?.blockedToken).toBe("psql");
  });

  it("returns null when no rule matches", () => {
    const m = findBlockingRule("ls -la", [DB_MANIFEST]);
    expect(m).toBeNull();
  });

  it("ignores the connector's own bin", () => {
    const m = findBlockingRule("db-agent --action query --params '{}'", [DB_MANIFEST]);
    expect(m).toBeNull();
  });
});

describe("findBlockingRule — segment splitting", () => {
  it("catches blocked invocation in pipeline", () => {
    const m = findBlockingRule("ls | psql -V", [DB_MANIFEST]);
    expect(m?.blockedToken).toBe("psql");
  });

  it("catches blocked invocation after &&", () => {
    const m = findBlockingRule("echo go && psql", [DB_MANIFEST]);
    expect(m?.blockedToken).toBe("psql");
  });

  it("catches blocked invocation after ;", () => {
    const m = findBlockingRule("echo go; mysql -u root", [DB_MANIFEST]);
    expect(m?.blockedToken).toBe("mysql");
  });

  it("catches blocked invocation after ||", () => {
    const m = findBlockingRule("false || sqlite3 db.sqlite", [DB_MANIFEST]);
    expect(m?.blockedToken).toBe("sqlite3");
  });
});

describe("findBlockingRule — env-var prefix stripping", () => {
  it("strips PG_PASSWORD=x prefix", () => {
    const m = findBlockingRule("PGPASSWORD=secret psql -U u db", [DB_MANIFEST]);
    expect(m?.blockedToken).toBe("psql");
  });

  it("strips multiple env-var assignments", () => {
    const m = findBlockingRule("X=1 Y=2 Z=3 mongosh mongodb://localhost", [DB_MANIFEST]);
    expect(m?.blockedToken).toBe("mongosh");
  });

  it("strips leading 'env' command", () => {
    const m = findBlockingRule("env PGPASSWORD=x psql -V", [DB_MANIFEST]);
    expect(m?.blockedToken).toBe("psql");
  });
});

describe("findBlockingRule — shell -c recursion", () => {
  it("recurses into bash -c", () => {
    const m = findBlockingRule(`bash -c "psql -h db -U u app"`, [DB_MANIFEST]);
    expect(m?.blockedToken).toBe("psql");
  });

  it("recurses into sh -c", () => {
    const m = findBlockingRule(`sh -c "mysql -u root"`, [DB_MANIFEST]);
    expect(m?.blockedToken).toBe("mysql");
  });

  it("does not blow up on deep nesting", () => {
    // 4+ levels of nesting bottom out without throwing.
    const m = findBlockingRule(
      `bash -c "bash -c \\"bash -c \\\\\\"psql -V\\\\\\"\\""`,
      [DB_MANIFEST],
    );
    // Either the regex matched (depth 0–3) or null, but no exception.
    expect(m === null || m.blockedToken === "psql").toBe(true);
  });
});

describe("findBlockingRule — two-token command match", () => {
  it("blocks 'aws dynamodb …' but not 'aws s3 …'", () => {
    expect(findBlockingRule("aws dynamodb list-tables", [DB_MANIFEST])?.blockedToken).toBe(
      "aws dynamodb",
    );
    expect(findBlockingRule("aws s3 ls", [DB_MANIFEST])).toBeNull();
  });
});

describe("findBlockingRule — multiple manifests union", () => {
  it("matches a rule from any provided manifest", () => {
    const otherManifest: GuardrailManifest = {
      version: 1,
      name: "github-agent-connector",
      rules: [{ block_first_token_basename: ["gh"] }],
    };
    const cmd = "gh repo list";
    expect(findBlockingRule(cmd, [DB_MANIFEST])).toBeNull();
    expect(findBlockingRule(cmd, [DB_MANIFEST, otherManifest])?.blockedToken).toBe("gh");
  });
});

describe("findBlockingRule — opener stripping", () => {
  it("ignores leading parenthesis", () => {
    const m = findBlockingRule("( psql -V )", [DB_MANIFEST]);
    expect(m?.blockedToken).toBe("psql");
  });

  it("ignores leading negation !", () => {
    const m = findBlockingRule("! psql -V", [DB_MANIFEST]);
    expect(m?.blockedToken).toBe("psql");
  });
});

describe("defaultDenyMessage", () => {
  it("includes the matched token and connector name", () => {
    const match = findBlockingRule("psql -V", [DB_MANIFEST])!;
    const msg = defaultDenyMessage(match);
    expect(msg).toContain("db-agent-connector");
    expect(msg).toContain("psql");
    expect(msg).toContain("Use db-agent");
  });

  it("honors a custom deny_message with substitution", () => {
    const customManifest: GuardrailManifest = {
      version: 1,
      name: "x",
      rules: [{
        block_first_token_basename: ["psql"],
        deny_message: "no ${blocked} for you",
      }],
    };
    const match = findBlockingRule("psql", [customManifest])!;
    expect(defaultDenyMessage(match)).toBe("no psql for you");
  });

  it("works without a redirect", () => {
    const m: GuardrailManifest = {
      version: 1,
      name: "y",
      rules: [{ block_first_token_basename: ["psql"] }],
    };
    const match = findBlockingRule("psql", [m])!;
    const msg = defaultDenyMessage(match);
    expect(msg).toContain("y guardrail");
    expect(msg).toContain("psql");
  });
});
