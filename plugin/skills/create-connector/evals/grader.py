#!/usr/bin/env python3
"""
Programmatic grader for create-connector quality evals.

Runs the deterministic subset of expectations from evals.json against a
scaffolded connector directory (or, for redirect/decline cases, the absence
of one) and writes a partial grading.json. The remaining LLM-judged
expectations should be evaluated by skill-creator's grader subagent.

Usage:
  python grader.py <eval_id> <run_dir>

Where:
  <eval_id>  : integer 1..10 matching an entry in evals.json
  <run_dir>  : path to the run directory containing the scaffold (or, for
               redirect cases, the workspace root used as a sentinel)

Output: <run_dir>/grading.json (skill-creator schema)
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Callable

# ─── Helpers ───────────────────────────────────────────────────────────────


def path_exists(p: str | Path) -> tuple[bool, str]:
    p = Path(p)
    return p.exists(), f"{p} {'exists' if p.exists() else 'does not exist'}"


def path_does_not_exist(p: str | Path) -> tuple[bool, str]:
    ok, msg = path_exists(p)
    return (not ok), f"{p} {'exists' if ok else 'does not exist'}"


def is_executable(p: str | Path) -> tuple[bool, str]:
    p = Path(p)
    if not p.exists():
        return False, f"{p} does not exist"
    return os.access(p, os.X_OK), f"{p} executable bit: {os.access(p, os.X_OK)}"


def file_contains(p: str | Path, pattern: str | re.Pattern) -> tuple[bool, str]:
    p = Path(p)
    if not p.exists():
        return False, f"{p} does not exist"
    text = p.read_text()
    if isinstance(pattern, re.Pattern):
        m = pattern.search(text)
        return bool(m), (
            f"{p}: pattern matched at offset {m.start()}"
            if m
            else f"{p}: pattern not found"
        )
    found = pattern in text
    return found, f"{p}: substring {'found' if found else 'not found'}"


def file_does_not_contain(
    p: str | Path, pattern: str | re.Pattern
) -> tuple[bool, str]:
    ok, msg = file_contains(p, pattern)
    return (not ok), msg


def json_path_equals(
    p: str | Path, dotted_path: str, expected
) -> tuple[bool, str]:
    p = Path(p)
    if not p.exists():
        return False, f"{p} does not exist"
    data = json.loads(p.read_text())
    cursor = data
    for key in dotted_path.split("."):
        if isinstance(cursor, dict) and key in cursor:
            cursor = cursor[key]
        else:
            return False, f"{p}: path {dotted_path} not present"
    return cursor == expected, (
        f"{p}: {dotted_path} = {cursor!r} (expected {expected!r})"
    )


def json_path_present(p: str | Path, dotted_path: str) -> tuple[bool, str]:
    p = Path(p)
    if not p.exists():
        return False, f"{p} does not exist"
    data = json.loads(p.read_text())
    cursor = data
    for key in dotted_path.split("."):
        if isinstance(cursor, dict) and key in cursor:
            cursor = cursor[key]
        else:
            return False, f"{p}: path {dotted_path} not present"
    return True, f"{p}: {dotted_path} present"


def hooks_json_complete(p: str | Path) -> tuple[bool, str]:
    """Verify hooks.json declares all four canonical hook arrays."""
    p = Path(p)
    if not p.exists():
        return False, f"{p} does not exist"
    data = json.loads(p.read_text())
    hooks = data.get("hooks", {})
    needed = {"SessionStart", "PostToolUse", "SessionEnd"}
    missing = needed - set(hooks.keys())
    if missing:
        return False, f"{p}: missing hook arrays: {sorted(missing)}"

    ss_cmds = hooks["SessionStart"][0]["hooks"] if hooks["SessionStart"] else []
    if len(ss_cmds) < 3:
        return False, (
            f"{p}: SessionStart has {len(ss_cmds)} commands, need 3 "
            "(npm install diff, reminder, stale-summarize)"
        )
    return True, f"{p}: all hook arrays present, SessionStart has {len(ss_cmds)} commands"


def run_npm(cmd: list[str], cwd: str | Path, timeout: int = 120) -> tuple[bool, str]:
    """Run an npm/node command and return (success, evidence)."""
    try:
        r = subprocess.run(
            cmd, cwd=str(cwd), capture_output=True, text=True, timeout=timeout
        )
    except subprocess.TimeoutExpired:
        return False, f"{' '.join(cmd)}: timed out after {timeout}s"
    except FileNotFoundError as e:
        return False, f"{' '.join(cmd)}: {e}"
    ok = r.returncode == 0
    snippet = (r.stderr or r.stdout or "").strip()[:300]
    return ok, f"{' '.join(cmd)}: exit {r.returncode}{(' — ' + snippet) if snippet else ''}"


def smoke_envelope_valid(
    cwd: str | Path, action: str, expected_error_code: str = "CONFIG_ERROR"
) -> tuple[bool, str]:
    """node dist/cli.js --action <action> --params '{}' must emit valid JSON
    with status='error' and the expected error_code."""
    try:
        r = subprocess.run(
            ["node", "dist/cli.js", "--action", action, "--params", "{}"],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=30,
            env={**os.environ, "PATH": os.environ.get("PATH", "")},
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return False, f"smoke run failed: {e}"

    stdout = (r.stdout or "").strip()
    if not stdout:
        return False, f"smoke run produced no stdout (stderr: {(r.stderr or '')[:200]})"
    try:
        envelope = json.loads(stdout)
    except json.JSONDecodeError:
        return False, f"smoke stdout is not valid JSON: {stdout[:200]}"

    if envelope.get("status") != "error":
        return False, f"smoke envelope status={envelope.get('status')!r}, expected 'error'"
    if envelope.get("error_code") != expected_error_code:
        return False, (
            f"smoke envelope error_code={envelope.get('error_code')!r}, "
            f"expected {expected_error_code!r}"
        )
    return True, f"smoke envelope valid: {envelope}"


# ─── Per-eval check definitions ────────────────────────────────────────────
#
# Each entry maps an expectation (verbatim from evals.json) to a check
# callable. Checks not listed here are LLM-judged and skipped by this script.

Check = Callable[[Path], tuple[bool, str]]


def _scaffold_checks(slug: str, run_dir: Path) -> dict[str, Check]:
    """Common checks shared by all scaffold-success cases (1, 2, 3, 4, 7, 8, 9)."""
    pkg = run_dir / "package.json"
    cli = run_dir / "src" / "cli.ts"
    idx = run_dir / "src" / "index.ts"
    client = run_dir / "src" / "lib" / f"{slug.replace('-', '_')}_client.ts"
    hooks = run_dir / "plugin" / "hooks" / "hooks.json"
    bin_path = run_dir / "plugin" / "bin" / f"{slug}-agent"

    return {
        f"Directory exists at /Users/narayan/src/connectors/{slug}-agent-connector/":
            lambda _p: path_exists(run_dir),
        f"package.json declares name '@narai/{slug}-agent-connector'":
            lambda _p: json_path_equals(pkg, "name", f"@narai/{slug}-agent-connector"),
        "package.json depends on '@narai/connector-toolkit' at '^3.1.0', "
        "'@narai/credential-providers' at '^0.2.1', '@narai/connector-config' "
        "at '^1.1.0', and 'zod' at '^3.23.0'":
            lambda _p: _check_deps(pkg),
        f"package.json exposes a bin entry '{slug}-agent-connector' pointing at './dist/cli.js'":
            lambda _p: json_path_equals(
                pkg, f"bin.{slug}-agent-connector", "./dist/cli.js"
            ),
        "plugin/hooks/hooks.json declares all four canonical hook arrays: "
        "SessionStart (with three commands: npm install diff/install, "
        "reminder.mjs, stale-summarize.mjs), PostToolUse (with usage-record.mjs), "
        "and SessionEnd (with session-summary.mjs)":
            lambda _p: hooks_json_complete(hooks),
        f"plugin/bin/{slug}-agent is a bash shim that execs "
        f"'${{CLAUDE_PLUGIN_DATA}}/node_modules/@narai/{slug}-agent-connector/dist/cli.js' "
        "and is marked executable":
            lambda _p: _check_bin_shim(bin_path, slug),
        ".npmignore excludes src/, tests/, plugin/, evals/":
            lambda _p: _check_npmignore(run_dir / ".npmignore"),
        f"Running `npm run build` in the new directory exits 0 and produces "
        "dist/cli.js plus dist/index.js":
            lambda _p: _check_build(run_dir),
        "Running `npm run typecheck` in the new directory exits 0 silently":
            lambda _p: run_npm(["npm", "run", "typecheck"], run_dir),
        "Running `npm test` in the new directory passes all tests (no failures)":
            lambda _p: run_npm(["npm", "test"], run_dir, timeout=180),
    }


def _check_deps(pkg: Path) -> tuple[bool, str]:
    if not pkg.exists():
        return False, f"{pkg} does not exist"
    data = json.loads(pkg.read_text())
    deps = data.get("dependencies", {})
    expected = {
        "@narai/connector-toolkit": "^3.1.0",
        "@narai/credential-providers": "^0.2.1",
        "@narai/connector-config": "^1.1.0",
        "zod": "^3.23.0",
    }
    missing = []
    wrong = []
    for k, v in expected.items():
        if k not in deps:
            missing.append(k)
        elif deps[k] != v:
            wrong.append(f"{k}={deps[k]} (want {v})")
    if missing or wrong:
        return False, f"missing={missing}, wrong={wrong}"
    return True, "all four deps pinned correctly"


def _check_bin_shim(p: Path, slug: str) -> tuple[bool, str]:
    if not p.exists():
        return False, f"{p} does not exist"
    text = p.read_text()
    if f"@narai/{slug}-agent-connector/dist/cli.js" not in text:
        return False, f"{p}: package path not found in shim"
    if not os.access(p, os.X_OK):
        return False, f"{p}: not executable"
    return True, f"{p}: shim OK and executable"


def _check_npmignore(p: Path) -> tuple[bool, str]:
    if not p.exists():
        return False, f"{p} does not exist"
    text = p.read_text()
    needed = ["src/", "tests/", "plugin/", "evals/"]
    missing = [n for n in needed if n not in text]
    if missing:
        return False, f"{p}: missing entries {missing}"
    return True, f"{p}: all four exclusions present"


def _check_build(run_dir: Path) -> tuple[bool, str]:
    ok, msg = run_npm(["npm", "run", "build"], run_dir, timeout=120)
    if not ok:
        return ok, msg
    cli_js = run_dir / "dist" / "cli.js"
    idx_js = run_dir / "dist" / "index.js"
    if not cli_js.exists() or not idx_js.exists():
        return False, f"{msg}; but dist/cli.js or dist/index.js missing"
    return True, f"{msg}; dist/cli.js + dist/index.js present"


# ─── Eval-specific checks ──────────────────────────────────────────────────


def checks_eval_1(run_dir: Path) -> dict[str, Check]:
    """Stripe — Bearer auth, three read actions."""
    base = _scaffold_checks("stripe", run_dir)
    cli = run_dir / "src" / "cli.ts"
    client = run_dir / "src" / "lib" / "stripe_client.ts"
    idx = run_dir / "src" / "index.ts"
    base.update({
        "src/cli.ts imports loadConnectorEnvironment from "
        "'@narai/connector-config' and declares a STRIPE_ENV_MAPPING with "
        "token mapped to 'STRIPE_API_KEY'":
            lambda _p: _check_all([
                file_contains(cli, "loadConnectorEnvironment"),
                file_contains(cli, "STRIPE_ENV_MAPPING"),
                file_contains(cli, "STRIPE_API_KEY"),
            ]),
        "src/lib/stripe_client.ts has a class StripeClient with a "
        "Result-envelope contract (returns StripeResult<T> from request methods)":
            lambda _p: _check_all([
                file_contains(client, re.compile(r"class StripeClient\b")),
                file_contains(client, "StripeResult<"),
            ]),
        "src/lib/stripe_client.ts builds the Authorization header as `Bearer "
        "${this._token}` (not X-API-Key, not Basic)":
            lambda _p: _check_all([
                file_contains(client, re.compile(r"Authorization:\s*`Bearer \$\{this\._token\}`")),
                file_does_not_contain(client, "X-API-Key"),
            ]),
        "src/index.ts uses createConnector from '@narai/connector-toolkit' "
        "and registers exactly three actions: get_customer, list_customers, list_charges":
            lambda _p: _check_all([
                file_contains(idx, "createConnector"),
                file_contains(idx, re.compile(r"\bget_customer\b\s*:")),
                file_contains(idx, re.compile(r"\blist_customers\b\s*:")),
                file_contains(idx, re.compile(r"\blist_charges\b\s*:")),
            ]),
        "All three actions in src/index.ts carry classify: { kind: 'read' }":
            lambda _p: _count_classify_kind(idx, "read", expected=3),
        "src/index.ts exports a default connector and re-exports main, "
        "fetch, validActions":
            lambda _p: _check_all([
                file_contains(idx, "export default connector"),
                file_contains(idx, re.compile(r"export const \{[^}]*main[^}]*\}")),
            ]),
        "Running `node dist/cli.js --action list_customers --params '{}'` "
        "(without STRIPE_API_KEY set) emits a JSON object on stdout with "
        "status='error' and error_code='CONFIG_ERROR'":
            lambda _p: smoke_envelope_valid(run_dir, "list_customers"),
    })
    return base


def checks_eval_2(run_dir: Path) -> dict[str, Check]:
    """Internal REST with X-API-Key (acme)."""
    base = _scaffold_checks("acme", run_dir)
    cli = run_dir / "src" / "cli.ts"
    client = run_dir / "src" / "lib" / "acme_client.ts"
    idx = run_dir / "src" / "index.ts"
    base.update({
        "src/cli.ts maps the auth env var name to ACME_API_KEY":
            lambda _p: file_contains(cli, "ACME_API_KEY"),
        "src/lib/acme_client.ts builds the auth header as 'X-API-Key: "
        "${this._token}' (NOT Authorization: Bearer)":
            lambda _p: _check_all([
                file_contains(client, re.compile(r'"X-API-Key":')),
                file_does_not_contain(client, re.compile(r"Authorization:\s*`Bearer")),
            ]),
        "src/lib/acme_client.ts uses base URL constant 'https://api.acme.internal'":
            lambda _p: file_contains(client, "https://api.acme.internal"),
        "src/index.ts registers exactly two actions: get_order (params include "
        "id) and list_orders (params include limit with default 25 and max "
        "100, plus optional customer)":
            lambda _p: _check_all([
                file_contains(idx, re.compile(r"\bget_order\b\s*:")),
                file_contains(idx, re.compile(r"\blist_orders\b\s*:")),
            ]),
        "Both actions classified as read":
            lambda _p: _count_classify_kind(idx, "read", expected=2),
        "list_orders Zod schema uses .max(100) on the limit field":
            lambda _p: file_contains(idx, re.compile(r"\.max\(\s*100\s*\)")),
    })
    return base


def checks_eval_3(run_dir: Path) -> dict[str, Check]:
    """Linear GraphQL."""
    base = _scaffold_checks("linear", run_dir)
    client = run_dir / "src" / "lib" / "linear_client.ts"
    idx = run_dir / "src" / "index.ts"
    cli = run_dir / "src" / "cli.ts"
    base.update({
        "src/lib/linear_client.ts contains methods that POST to '/graphql' "
        "(the single GraphQL endpoint pattern)":
            lambda _p: file_contains(client, re.compile(r"['\"`]/graphql['\"`]")),
        "src/index.ts registers exactly two actions: get_issue and "
        "search_issues, both classified as read":
            lambda _p: _check_all([
                file_contains(idx, re.compile(r"\bget_issue\b\s*:")),
                file_contains(idx, re.compile(r"\bsearch_issues\b\s*:")),
                _count_classify_kind(idx, "read", expected=2),
            ]),
        "src/cli.ts maps the auth env var to LINEAR_API_KEY":
            lambda _p: file_contains(cli, "LINEAR_API_KEY"),
        "Authorization header is 'Bearer ${this._token}'":
            lambda _p: file_contains(
                client, re.compile(r"Authorization:\s*`Bearer \$\{this\._token\}`")
            ),
    })
    return base


def checks_eval_4(run_dir: Path) -> dict[str, Check]:
    """Mixed read/write (acme-msg)."""
    base = _scaffold_checks("acme-msg", run_dir)
    idx = run_dir / "src" / "index.ts"
    base.update({
        "src/index.ts registers list_channels with classify: { kind: 'read' }":
            lambda _p: file_contains(
                idx,
                re.compile(
                    r"list_channels\s*:[^}]*classify\s*:\s*\{\s*kind\s*:\s*['\"]read['\"]",
                    re.DOTALL,
                ),
            ),
        "src/index.ts registers post_message with classify: { kind: 'write' } "
        "(NOT read)":
            lambda _p: file_contains(
                idx,
                re.compile(
                    r"post_message\s*:[^}]*classify\s*:\s*\{\s*kind\s*:\s*['\"]write['\"]",
                    re.DOTALL,
                ),
            ),
    })
    return base


def checks_eval_5(_run_dir: Path) -> dict[str, Check]:
    """Database redirect — no scaffold should be created."""
    workspace = Path("/Users/narayan/src/connectors")
    return {
        "No new directory is created under /Users/narayan/src/connectors/ "
        "(no postgres-agent-connector/, no orders-agent-connector/)":
            lambda _p: _check_all([
                path_does_not_exist(workspace / "postgres-agent-connector"),
                path_does_not_exist(workspace / "orders-agent-connector"),
                path_does_not_exist(workspace / "analytics-agent-connector"),
            ]),
    }


def checks_eval_6(_run_dir: Path) -> dict[str, Check]:
    """MCP out-of-scope — no scaffold."""
    workspace = Path("/Users/narayan/src/connectors")
    return {
        "No new directory is created under /Users/narayan/src/connectors/":
            lambda _p: _check_all([
                path_does_not_exist(workspace / "mcp-agent-connector"),
                path_does_not_exist(workspace / "incident-mcp-agent-connector"),
            ]),
    }


def checks_eval_7(run_dir: Path) -> dict[str, Check]:
    """Multi-secret GitHub Enterprise."""
    base = _scaffold_checks("acme-gh", run_dir)
    cli = run_dir / "src" / "cli.ts"
    client = run_dir / "src" / "lib" / "acme_gh_client.ts"
    idx = run_dir / "src" / "index.ts"
    base.update({
        "src/cli.ts declares an ENV_MAPPING with two entries (token → "
        "ACME_GH_TOKEN, org → ACME_GH_ORG)":
            lambda _p: _check_all([
                file_contains(cli, "ACME_GH_TOKEN"),
                file_contains(cli, "ACME_GH_ORG"),
            ]),
        "The Client constructor stores both as private fields (private "
        "readonly _token AND private readonly _org)":
            lambda _p: _check_all([
                file_contains(client, re.compile(r"private readonly _token")),
                file_contains(client, re.compile(r"private readonly _org")),
            ]),
    })
    return base


def checks_eval_8(run_dir: Path) -> dict[str, Check]:
    """Salesforce OAuth flagged."""
    base = _scaffold_checks("salesforce", run_dir)
    client = run_dir / "src" / "lib" / "salesforce_client.ts"
    base.update({
        "src/lib/salesforce_client.ts has a loadSalesforceCredentials function "
        "with a TODO comment indicating OAuth flow needs implementation":
            lambda _p: _check_all([
                file_contains(client, "loadSalesforceCredentials"),
                file_contains(client, re.compile(r"TODO.*OAuth", re.IGNORECASE)),
            ]),
    })
    return base


def checks_eval_9(run_dir: Path) -> dict[str, Check]:
    """CLI tool wrap (incident-cli)."""
    base = _scaffold_checks("incident-cli", run_dir)
    client_a = run_dir / "src" / "lib" / "incident_cli_client.ts"
    client_b = run_dir / "src" / "lib" / "incident-cli_client.ts"
    client = client_a if client_a.exists() else client_b
    base.update({
        "src/lib/<slug>_client.ts uses node:child_process (execFile or spawn) "
        "instead of HTTP fetch for at least the action methods":
            lambda _p: _check_all([
                file_contains(client, re.compile(r"child_process|execFile|spawn")),
            ]),
    })
    return base


def checks_eval_10(_run_dir: Path) -> dict[str, Check]:
    """Modify existing connector — no scaffold should be created."""
    workspace = Path("/Users/narayan/src/connectors")
    return {
        "No new directory is created (no search-blocks-agent-connector/, "
        "no notion-blocks-agent-connector/, etc.)":
            lambda _p: _check_all([
                path_does_not_exist(workspace / "search-blocks-agent-connector"),
                path_does_not_exist(workspace / "notion-blocks-agent-connector"),
            ]),
    }


# ─── Composition helpers ───────────────────────────────────────────────────


def _check_all(results: list[tuple[bool, str]]) -> tuple[bool, str]:
    """Compose multiple sub-checks: all must pass."""
    failed = [(ok, msg) for ok, msg in results if not ok]
    if failed:
        return False, "; ".join(msg for _, msg in failed)
    return True, "; ".join(msg for _, msg in results)


def _count_classify_kind(
    idx_path: Path, kind: str, *, expected: int
) -> tuple[bool, str]:
    if not idx_path.exists():
        return False, f"{idx_path} does not exist"
    text = idx_path.read_text()
    pattern = re.compile(rf"classify\s*:\s*\{{\s*kind\s*:\s*['\"]{kind}['\"]")
    matches = pattern.findall(text)
    return len(matches) == expected, (
        f"{idx_path}: found {len(matches)} `classify: {{ kind: '{kind}' }}` "
        f"entries (expected {expected})"
    )


# ─── Dispatch ──────────────────────────────────────────────────────────────


CHECKS_BY_EVAL_ID: dict[int, Callable[[Path], dict[str, Check]]] = {
    1: checks_eval_1,
    2: checks_eval_2,
    3: checks_eval_3,
    4: checks_eval_4,
    5: checks_eval_5,
    6: checks_eval_6,
    7: checks_eval_7,
    8: checks_eval_8,
    9: checks_eval_9,
    10: checks_eval_10,
}


def grade(eval_id: int, run_dir: Path) -> dict:
    if eval_id not in CHECKS_BY_EVAL_ID:
        raise SystemExit(f"unknown eval_id {eval_id}; valid: {sorted(CHECKS_BY_EVAL_ID)}")
    checks = CHECKS_BY_EVAL_ID[eval_id](run_dir)

    expectations = []
    for text, check in checks.items():
        try:
            passed, evidence = check(run_dir)
        except Exception as e:
            passed, evidence = False, f"check raised: {type(e).__name__}: {e}"
        expectations.append({"text": text, "passed": passed, "evidence": evidence})

    passed_count = sum(1 for e in expectations if e["passed"])
    total = len(expectations)
    return {
        "expectations": expectations,
        "summary": {
            "passed": passed_count,
            "failed": total - passed_count,
            "total": total,
            "pass_rate": round(passed_count / total, 3) if total else 0.0,
        },
        "note": (
            "This is the programmatic subset only. Subjective expectations "
            "(e.g., 'the skill explained approval modes during interview') "
            "are not evaluated here — use skill-creator's grader subagent for those."
        ),
    }


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: grader.py <eval_id> <run_dir>", file=sys.stderr)
        return 2
    eval_id = int(sys.argv[1])
    run_dir = Path(sys.argv[2]).resolve()

    result = grade(eval_id, run_dir)
    out_path = run_dir / "grading.json"
    out_path.write_text(json.dumps(result, indent=2))
    print(f"wrote {out_path}")
    print(
        f"  programmatic pass rate: {result['summary']['passed']}/{result['summary']['total']} "
        f"({result['summary']['pass_rate'] * 100:.1f}%)"
    )
    failed = [e for e in result["expectations"] if not e["passed"]]
    if failed:
        print("  failed expectations:")
        for e in failed:
            print(f"    - {e['text'][:80]}{'…' if len(e['text']) > 80 else ''}")
            print(f"      evidence: {e['evidence']}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
