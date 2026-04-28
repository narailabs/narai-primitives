#!/usr/bin/env node
import {
  aggregateCrossSession,
  renderCrossSessionMarkdown,
} from "../usage/aggregate-cross-session.js";
import { join } from "node:path";

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
        throw new Error(`--format must be 'json' or 'md', got '${next}'`);
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
      throw new Error(`Unknown arg: ${a}`);
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
    process.stderr.write(`error: ${(err as Error).message}\n\n${HELP}`);
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
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
