# Evals for `create-connector`

This directory has two eval suites:

| File | Purpose | Used by |
|---|---|---|
| `evals.json` | **Quality evals** — does the skill produce a working scaffold (or correctly redirect/decline) for realistic prompts? | skill-creator's `eval-viewer/generate_review.py` + grader subagent |
| `trigger-eval.json` | **Trigger evals** — does the skill's `description` correctly fire on phrasings that should match, and stay quiet on near-misses? | skill-creator's `scripts/run_loop.py` (description optimization) |

## Quality evals (`evals.json`)

10 realistic test cases covering the skill's full surface:

| ID | Name | What it checks |
|---|---|---|
| 1 | stripe-readonly-bearer | Bearer-token + read-only — the dominant pattern |
| 2 | internal-rest-custom-header | X-API-Key auth (not Bearer) — auth flexibility |
| 3 | graphql-endpoint | Single POST /graphql client pattern — protocol flexibility |
| 4 | write-action-with-approval | Mixed read/write actions — classification + approval-mode handling |
| 5 | database-redirect | Should NOT scaffold; redirect to db-agent-connector |
| 6 | mcp-out-of-scope | Should NOT scaffold; point at MCP docs |
| 7 | multi-secret-github-enterprise | token + org auth — multi-secret pattern |
| 8 | salesforce-oauth-flagged | OAuth flagged as not-templated — placeholder credentials |
| 9 | cli-tool-wrap | Client shells out via child_process — non-HTTP pattern |
| 10 | modify-existing-connector | Should NOT scaffold; user wants to edit notion-agent-connector |

Each case has:
- `prompt` — what the user types (realistic, with specific names/URLs/env vars)
- `expected_output` — human-readable success state
- `expectations` — 5–18 verifiable statements that the grader (LLM or human) evaluates against the run's output

Cases 1, 2, 3, 4, 7, 8, 9 are **scaffold-success** cases — the skill should produce files. Cases 5, 6, 10 are **redirect/decline** cases — the skill should NOT scaffold and should provide guidance instead.

### Running quality evals via skill-creator

The skill-creator workflow expects to spawn subagents that run each prompt with-skill and without-skill in parallel, then grade the outputs. Quick recipe:

```bash
SKILL=/Users/narayan/.claude/skills/create-connector
WORKSPACE=$SKILL/eval-workspace/iteration-1

# 1. For each eval, spawn one with-skill subagent and one without-skill
#    (skill-creator's standard workflow handles this — see its SKILL.md for the
#    exact subagent prompt format)

# 2. After runs complete, aggregate:
python -m scripts.aggregate_benchmark $WORKSPACE --skill-name create-connector

# 3. Open the viewer:
python ~/.claude/plugins/cache/claude-plugins-official/skill-creator/unknown/skills/skill-creator/eval-viewer/generate_review.py \
  $WORKSPACE \
  --skill-name create-connector \
  --benchmark $WORKSPACE/benchmark.json
```

### What to look for in the results

**Scaffold cases (1, 2, 3, 4, 7, 8, 9)**:
- File-system facts: directory exists, all expected files created, file is executable where appropriate
- Content correctness: package.json deps + versions, action classifications, auth header pattern in client
- Build/test outcomes: `npm run build` clean, `npm run typecheck` silent, `npm test` all green
- Smoke envelope: valid JSON with `status: "error"` and `error_code: "CONFIG_ERROR"` (since no real creds are set)

**Redirect/decline cases (5, 6, 10)**:
- No new files under `/Users/narayan/src/connectors/`
- Response mentions the right alternative (db-agent / MCP docs / "edit the existing file")
- Skill does NOT walk through the standard scaffolding interview

### Common failure modes

| Failure | Likely cause | Fix |
|---|---|---|
| `tsc` errors about missing modules | `node_modules/@narai/*` not resolved | Symlink from `notion-agent-connector/node_modules` for fast iteration; otherwise `npm install` |
| Tests fail with "fetchImpl is not a function" | Test template `TEST_CLIENT_CREDS` substitution missing/wrong | Re-check the auth-pattern → test-creds mapping in `references/auth-patterns.md` |
| Smoke envelope is not valid JSON | The cli.ts threw before `connector.main()` could format the envelope | Check that `loadConnectorEnvironment` is called correctly; check stderr for the actual error |
| Action classified wrong | Skill defaulted to `read` on a write-named action | Tighten the classification heuristics in SKILL.md (interview step 4) |

## Trigger evals (`trigger-eval.json`)

20 realistic queries — 10 should-trigger and 10 should-not-trigger — for description optimization.

The should-trigger queries cover:
- Direct phrasings ("wrap Stripe's API as a connector")
- Indirect phrasings ("get claude to query stripe")
- Casual / lowercase / abbreviated language
- Workspace-context phrasings (mentioning `/Users/narayan/src/connectors`)
- Different protocol shapes (REST, GraphQL, OAuth, multi-secret, CLI wrap)
- Range of services (SaaS, internal, GitHub Enterprise, Salesforce, Pipedrive, Confluence)

The should-not-trigger queries cover:
- **Modifying existing connectors** (notion-agent-connector add new action) — user should just edit the file
- **Database queries** — db-agent-connector already covers this
- **MCP servers** — different abstraction
- **Debugging existing connectors** — different task
- **Creating skills** — that's skill-creator territory
- **General API questions** ("how do I auth to Stripe") — not about wrapping
- **Working on toolkit internals** — not creating a new connector
- **Plugin/hook debugging** — different task
- **credential-providers questions** — different package
- **Non-connector code generation** (CLI scripts) — out of scope

### Running trigger evals

skill-creator's `run_loop.py` automates the optimization loop. The recipe:

```bash
SKILL=/Users/narayan/.claude/skills/create-connector
SKILL_CREATOR=~/.claude/plugins/cache/claude-plugins-official/skill-creator/unknown/skills/skill-creator

cd $SKILL_CREATOR
python -m scripts.run_loop \
  --eval-set $SKILL/evals/trigger-eval.json \
  --skill-path $SKILL \
  --model claude-opus-4-7 \
  --max-iterations 5 \
  --verbose
```

This:
1. Splits the 20 queries into 60% train + 40% held-out test.
2. Evaluates the current description by running each query 3× (gets a reliable trigger rate per query).
3. Calls Claude with extended thinking to propose an improved description based on what failed.
4. Re-evaluates each candidate description on both train + test sets.
5. Iterates up to 5 times.
6. Returns `best_description` selected by **test** score (not train) — avoids overfitting.

The output is an HTML report with per-iteration scores and the winning description.

### Edge cases the trigger evals stress

A description that's too narrow (e.g., only mentions "agent connector") will miss queries 1, 8 (which never use the word "connector" — just "ask claude things like..." or "add Salesforce to our agent stack").

A description that's too broad (e.g., catches anything mentioning APIs) will trigger on queries 11–20 (modifying existing, database, MCP, etc.) where it shouldn't.

The current description balances these — it explicitly lists positive trigger phrases ("I want to query Stripe from Claude") AND explicit negative cases (modifying, MCP, databases). The trigger eval will tell you whether that balance is calibrated correctly.

## When to re-run evals

- After **changing SKILL.md** (especially the interview, scaffolding instructions, or out-of-scope list).
- After **changing any template** in `assets/templates/connector/`. New scaffolds may differ.
- After **bumping `@narai/connector-toolkit`** to a new major version. Scaffolded connectors may not build.
- Before **packaging** the skill for distribution (`package_skill.py`) — sanity check.

## Adding new test cases

When a new connector pattern emerges that the skill should handle:

1. Add an entry to `evals.json` with `id`, `name` (descriptive), `prompt`, `expected_output`, `expectations`.
2. Add 1–2 corresponding queries to `trigger-eval.json` if the new case has distinctive trigger phrasings.
3. Re-run the eval suite to confirm the skill handles the new case without regressing existing ones.

Match expectation specificity to the skill-creator schema's grading model — the grader subagent reads each expectation as a sentence and judges pass/fail with evidence. Avoid expectations that are subjective ("the README is well-written"); prefer ones that are objectively verifiable ("the README has an Install section with the npm install command").
