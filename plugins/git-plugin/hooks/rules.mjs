/**
 * rules.mjs — git command classifier for the git-gate hook.
 *
 * Pure data + pure functions. No I/O. Imported by `git_gate.mjs` (the hook
 * entry point) and by `tests/plugins/git-plugin/rules.test.mjs`.
 *
 * Decision precedence: `deny` > `ask` > `allow`. The hook returns the
 * strictest matching rule's decision; if no rule matches, the hook emits
 * no decision and the default permission flow continues.
 *
 * Each rule is `{name, decision, reason, match: (segment) => boolean}`.
 * Rules are evaluated against each *segment* of a compound bash command
 * (split on `&&`, `||`, `;`, `|`).
 */

/**
 * Default rule set. Keep names stable — operators reference them via
 * GIT_GATE_DISABLE and config files.
 */
export const DEFAULT_RULES = [
  // ── DENY rules (precedence over ask) ────────────────────────────────────
  {
    name: "push_main",
    decision: "deny",
    reason: "Pushing to main/master is denied by policy. Open a PR instead.",
    match: (s) => isGitPush(s) && targetsProtectedBranch(s),
  },

  // ── ASK rules ───────────────────────────────────────────────────────────
  {
    name: "force_push",
    decision: "ask",
    reason: "Force push rewrites remote history. Confirm before proceeding.",
    match: (s) =>
      isGitPush(s) && /\s(--force\b|--force-with-lease\b|-f\b)/.test(s),
  },
  {
    name: "delete_branch_remote",
    decision: "ask",
    reason: "Deleting a remote branch is irreversible. Confirm.",
    match: (s) =>
      isGitPush(s) &&
      (/\s(--delete\b|-d\b)/.test(s) || /\s\S+\s+:[\w./-]+/.test(s)),
  },
  {
    name: "push",
    decision: "ask",
    reason: "Pushing publishes commits. Confirm before proceeding.",
    match: (s) => isGitPush(s),
  },
  {
    name: "delete_branch_local",
    decision: "ask",
    reason: "Force-deleting a local branch can lose unmerged commits.",
    match: (s) =>
      /^git\s+branch\s+(?:.*\s)?(-D\b|--delete\s+--force\b|-Df\b|-fD\b)/.test(s),
  },
  {
    name: "reset_hard",
    decision: "ask",
    reason: "git reset --hard discards working-tree and index changes.",
    match: (s) => /^git\s+reset\s+(?:.*\s)?--hard\b/.test(s),
  },
  {
    name: "checkout_discard",
    decision: "ask",
    reason: "This checkout/restore discards working-tree changes.",
    match: (s) =>
      /^git\s+checkout\s+(?:--\s+|\.|[^\s-]\S*\.\S*)/.test(s) ||
      /^git\s+checkout\s+\S+\s+--\s+\S/.test(s) ||
      /^git\s+restore\s+(?:.*\s)?(--worktree\b|-W\b)/.test(s) ||
      /^git\s+restore\s+\.$/.test(s),
  },
  {
    name: "clean_force",
    decision: "ask",
    reason: "git clean -f removes untracked files (and -fdx removes ignored too).",
    match: (s) => /^git\s+clean\s+(?:.*\s)?-[a-zA-Z]*f/.test(s),
  },
];

/**
 * Bash command splitter. Returns each independent command segment trimmed
 * and stripped of leading env-prefixes (`FOO=bar`) and `sudo`.
 *
 * Limitations: doesn't track quoted strings — a literal `&&` inside a
 * single-quoted string would split the command. This is a safety check,
 * not a parser; over-splitting is the right bias.
 */
export function splitCompound(command) {
  if (typeof command !== "string") return [];
  // Split on chaining operators (greedy for multi-char first).
  const parts = command.split(/\s*(?:&&|\|\||;|\|)\s*/);
  return parts
    .map((p) => stripPrefix(p.trim()))
    .filter((p) => p.length > 0);
}

function stripPrefix(s) {
  let cur = s;
  // Strip leading env-var assignments (FOO=bar BAZ=qux ...)
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(cur)) {
    cur = cur.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
  }
  // Strip leading sudo / nice / time prefixes
  cur = cur.replace(/^(sudo|nice|time)\s+/, "");
  return cur;
}

function isGitPush(s) {
  return /^git\s+push(\s|$)/.test(s);
}

/**
 * Detect that a `git push` targets main or master in any common refspec
 * form. Conservative: any token matching `\bmain\b` or `\bmaster\b` after
 * the `push` keyword counts. Operators with a "feature/main" branch may
 * see false positives — they can disable `push_main` via GIT_GATE_DISABLE.
 */
function targetsProtectedBranch(s) {
  // Strip "git push" prefix; inspect the remainder.
  const tail = s.replace(/^git\s+push\s*/, "");
  if (tail.length === 0) return false;
  // Match :main, :master, HEAD:main, HEAD:master, ` main`, ` master` as
  // word-bounded tokens in the tail.
  return /(^|\s|:)(main|master)(\s|$)/.test(tail);
}

/**
 * Decide for a full bash command. Walks compound segments, runs each
 * against the active rules, returns the strictest match.
 *
 * `disabledNames` is a Set of rule names disabled by env var or config.
 * `extraRules` is appended after the defaults (operator-supplied).
 *
 * Returns `null` if no rule matched (caller should emit no decision).
 */
export function decide(command, options = {}) {
  const disabled = options.disabled ?? new Set();
  const extra = options.extraRules ?? [];
  const rules = [...DEFAULT_RULES, ...extra].filter(
    (r) => !disabled.has(r.name),
  );

  let strictest = null;
  for (const segment of splitCompound(command)) {
    for (const rule of rules) {
      if (rule.match(segment)) {
        if (strictest === null || rank(rule) > rank(strictest)) {
          strictest = rule;
        }
      }
    }
  }
  return strictest;
}

function rank(rule) {
  if (rule.decision === "deny") return 2;
  if (rule.decision === "ask") return 1;
  return 0;
}
