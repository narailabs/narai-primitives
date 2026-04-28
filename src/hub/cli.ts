#!/usr/bin/env node
/** CLI entrypoint: parses argv, calls `gather`, prints the JSON output. */

import { gather } from "./index.js";
import type { GatherInput } from "./types.js";

const HELP = `Usage: connector-hub --prompt <text> [--consumer <name>] [--environment <name>] [--extra-context <text>]

Options:
  --prompt <text>           Natural-language prompt (required).
  --consumer <name>         Apply consumers.<name> overrides from config.yaml.
  --environment <name>      Apply environments.<name> overrides from config.yaml.
  --extra-context <text>    Extra context appended after the prompt.
  -h, --help                Show this help.
`;

interface RawArgs {
  prompt?: string;
  consumer?: string;
  environment?: string;
  "extra-context"?: string;
  help?: boolean;
}

// TODO: fold this back into parseAgentArgs once the toolkit supports arbitrary string flags.
/** Tiny extension of `parseAgentArgs` that accepts arbitrary string flags. */
function parseHubArgs(argv: readonly string[]): RawArgs {
  // We cannot reuse `parseAgentArgs` directly because it only surfaces
  // `action` / `params` / `help`. Reimplement the same shape with the hub's
  // flags. (Same throw-on-unknown semantics.)
  const valid = new Set(["prompt", "consumer", "environment", "extra-context"]);
  const out: RawArgs = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === undefined) {
      i++;
      continue;
    }
    if (a === "-h" || a === "--help") {
      out.help = true;
      i++;
      continue;
    }
    if (!a.startsWith("--")) {
      throw new Error(`unrecognized argument: ${a}`);
    }
    const eq = a.indexOf("=");
    let name: string;
    let value: string | undefined;
    if (eq >= 0) {
      name = a.slice(2, eq);
      value = a.slice(eq + 1);
      i++;
    } else {
      name = a.slice(2);
      value = argv[i + 1];
      i += 2;
    }
    if (!valid.has(name)) {
      throw new Error(`unrecognized argument: --${name}`);
    }
    (out as Record<string, string | undefined>)[name] = value ?? "";
  }
  return out;
}

async function main(): Promise<void> {
  let args: RawArgs;
  try {
    args = parseHubArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${HELP}`);
    process.exit(1);
  }
  if (args.help === true) {
    process.stdout.write(HELP);
    return;
  }
  if (args.prompt === undefined || args.prompt === "") {
    process.stderr.write(`missing required --prompt\n${HELP}`);
    process.exit(1);
  }
  const input: GatherInput = { prompt: args.prompt };
  if (args.consumer !== undefined) input.consumer = args.consumer;
  if (args.environment !== undefined) input.environment = args.environment;
  if (args["extra-context"] !== undefined) input.extraContext = args["extra-context"];
  try {
    const out = await gather(input);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`hub failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`hub crashed: ${String(err)}\n`);
  process.exit(1);
});
