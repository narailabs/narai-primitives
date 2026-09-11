#!/usr/bin/env node
import {
  aggregateCrossSession,
  renderCrossSessionMarkdown,
} from "../usage/aggregate-cross-session.js";
import { scrubSecrets } from "../audit/writer.js";
import { join } from "node:path";

/** OUR flag names, so they are safe to echo in a rejection message. */
const FLAG_LIST = "--connector, --since, --format, --dir, --help";

interface Parsed {
  connector?: string;
  since: string;
  format: "json" | "md";
  dir: string;
}

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = {
    since: "30d",
    format: "md",
    dir: join(process.cwd(), ".claude", "connectors"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--connector" && next) { out.connector = next; i++; }
    else if (a === "--since" && next) { out.since = next; i++; }
    else if (a === "--format" && next) {
      if (next !== "json" && next !== "md") {
        // A REJECTED value is caller text. The accepted set is the diagnostic
        // half of this message; the caller's own token is not, and it can be a
        // bare credential that no shape-based scrub downstream recognises.
        // Same rule src/hub/cli.ts and src/connectors/db/config.ts apply.
        throw new Error("--format must be 'json' or 'md'");
      }
      out.format = next;
      i++;
    }
    else if (a === "--dir" && next) { out.dir = next; i++; }
    else if (a === "--help" || a === "-h") {
      process.stdout.write(HELP);
      process.exit(0);
    }
    else {
      // See the --format case above: our own flag names are safe to print,
      // the caller's rejected token is not.
      throw new Error(`Unknown argument (expected ${FLAG_LIST})`);
    }
  }
  return out;
}

const HELP = `Usage: usage-report [options]

Options:
  --connector <name>    Filter to one connector (default: all)
  --since 7d|30d|all    Time window (default: 30d)
  --format json|md      Output format (default: md)
  --dir <path>          Root dir (default: .claude/connectors)
  -h, --help            Show help
`;

async function main(): Promise<void> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    // Defence in depth: the throws above no longer echo caller tokens, but a
    // future one might, and this catch is the sink that reaches stderr —
    // main().catch never sees a synchronous parseArgs throw.
    process.stderr.write(
      `error: ${scrubSecrets((err as Error).message)}\n\n${HELP}`,
    );
    process.exit(2);
  }

  const report = await aggregateCrossSession({
    dir: parsed.dir,
    since: parsed.since,
    ...(parsed.connector ? { connector: parsed.connector } : {}),
  });

  if (parsed.format === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(renderCrossSessionMarkdown(report));
  }
}

main().catch((err) => {
  process.stderr.write(
    `error: ${scrubSecrets(err instanceof Error ? err.message : String(err))}\n`,
  );
  process.exit(1);
});
