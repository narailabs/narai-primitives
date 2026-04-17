import { runEnvVarBench } from "./env_var.bench.mjs";
import { runParseRefBench } from "./parse_ref.bench.mjs";
import { runResolverBench } from "./resolver.bench.mjs";
import { runFileBench } from "./file.bench.mjs";

const suites = [
  ["env_var", runEnvVarBench],
  ["parse_ref", runParseRefBench],
  ["resolver", runResolverBench],
  ["file", runFileBench],
];

const rows = [];
for (const [label, run] of suites) {
  process.stdout.write(`running ${label}...\n`);
  const bench = await run();
  for (const task of bench.tasks) {
    const r = task.result;
    if (!r) continue;
    rows.push({
      suite: label,
      task: task.name,
      "ops/s": Math.round(r.throughput.mean),
      "avg (ns)": Math.round(r.latency.mean * 1e6),
      samples: r.latency.samplesCount,
    });
  }
}

rows.sort((a, b) => b["ops/s"] - a["ops/s"]);
console.log("\n=== combined results (sorted by ops/s) ===");
console.table(rows);
