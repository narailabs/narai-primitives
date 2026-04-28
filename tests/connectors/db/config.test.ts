/**
 * Coverage for src/config.ts — the standalone YAML config parser
 * (parseConfig / parseArgs / main).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ConfigFileNotFoundError,
  main,
  parseConfig,
} from "../../../src/connectors/db/config.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-agent-config-"));
});

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = "";
  vi.restoreAllMocks();
});

function writeFile(name: string, contents: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, contents);
  return p;
}

describe("ConfigFileNotFoundError", () => {
  it("sets name and message", () => {
    const e = new ConfigFileNotFoundError("missing");
    expect(e.name).toBe("ConfigFileNotFoundError");
    expect(e.message).toBe("missing");
    expect(e instanceof Error).toBe(true);
  });
});

describe("parseConfig", () => {
  it("returns a plain object for a valid YAML mapping", () => {
    const p = writeFile(
      "ok.yaml",
      "ecosystem:\n  database:\n    environments:\n      dev:\n        driver: sqlite\n",
    );
    const cfg = parseConfig(p);
    expect(cfg).toMatchObject({
      ecosystem: { database: { environments: { dev: { driver: "sqlite" } } } },
    });
  });

  it("throws ConfigFileNotFoundError when the file does not exist", () => {
    const missing = path.join(tmpDir, "does-not-exist.yaml");
    expect(() => parseConfig(missing)).toThrow(ConfigFileNotFoundError);
  });

  it("throws Error with 'Failed to parse YAML' on malformed YAML", () => {
    const p = writeFile("bad.yaml", "{ this is: not\n  valid: yaml: nope ]");
    expect(() => parseConfig(p)).toThrow(/Failed to parse YAML/);
  });

  it("rejects a top-level YAML null", () => {
    const p = writeFile("null.yaml", "null\n");
    expect(() => parseConfig(p)).toThrow(/got: NoneType/);
  });

  it("rejects an empty file (loads as undefined)", () => {
    const p = writeFile("empty.yaml", "");
    expect(() => parseConfig(p)).toThrow(/got: undefined/);
  });

  it("rejects a top-level YAML list", () => {
    const p = writeFile("list.yaml", "- a\n- b\n- c\n");
    expect(() => parseConfig(p)).toThrow(/got: list/);
  });

  it("rejects a top-level YAML scalar string", () => {
    const p = writeFile("string.yaml", "just-a-string\n");
    expect(() => parseConfig(p)).toThrow(/got: string/);
  });

  it("rejects a top-level YAML number", () => {
    const p = writeFile("num.yaml", "42\n");
    expect(() => parseConfig(p)).toThrow(/got: number/);
  });
});

describe("main()", () => {
  let stdout = "";
  let stderr = "";

  beforeEach(() => {
    stdout = "";
    stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
  });

  it("prints help and exits 0 with --help", () => {
    const code = main(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/usage: config\.js/);
  });

  it("prints help and exits 0 with -h", () => {
    const code = main(["-h"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/usage: config\.js/);
  });

  it("returns 2 when --config is missing", () => {
    const code = main([]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/required: --config/);
  });

  it("returns 0 and prints JSON for a valid config", () => {
    const p = writeFile("ok.yaml", "ecosystem:\n  database: {}\n");
    const code = main(["--config", p]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ecosystem: { database: {} } });
  });

  it("accepts --config=PATH (equals form)", () => {
    const p = writeFile("eq.yaml", "key: value\n");
    const code = main([`--config=${p}`]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ key: "value" });
  });

  it("returns 1 and emits JSON error when config file is missing", () => {
    const missing = path.join(tmpDir, "missing.yaml");
    const code = main(["--config", missing]);
    expect(code).toBe(1);
    const errBody = JSON.parse(stderr);
    expect(errBody.error).toMatch(/Config file not found/);
  });

  it("returns 1 and emits JSON error when YAML is malformed", () => {
    const p = writeFile("bad.yaml", "key: : :\n");
    const code = main(["--config", p]);
    expect(code).toBe(1);
    const errBody = JSON.parse(stderr);
    expect(errBody.error.length).toBeGreaterThan(0);
  });

  it("returns 2 on unrecognized positional argument", () => {
    const code = main(["positional-arg"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/unrecognized argument: positional-arg/);
  });

  it("returns 2 on unrecognized --flag", () => {
    const code = main(["--bogus", "x"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/unrecognized argument: --bogus/);
  });

  it("treats an --option with no value as empty string", () => {
    const code = main(["--config"]);
    expect(code).toBe(2); // empty config string fails the required check
    expect(stderr).toMatch(/required: --config/);
  });
});
