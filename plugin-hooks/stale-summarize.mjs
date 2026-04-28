#!/usr/bin/env node
// SessionStart hook — summarize any orphaned <sid>.jsonl whose mtime is older
// than USAGE_SUMMARY_STALE_HOURS and has no matching summary-<sid>.json.

import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
// Reuse summarizeSession by re-importing — but importing a sibling .mjs means
// the same file must be runnable standalone AND exportable. Simpler: inline
// a tiny wrapper that delegates to session-summary.mjs via dynamic import.

async function main() {
  const connector = process.env["USAGE_CONNECTOR_NAME"];
  if (!connector) return;
  const staleHours = Number(process.env["USAGE_SUMMARY_STALE_HOURS"] ?? "12");
  if (!Number.isFinite(staleHours) || staleHours <= 0) return;

  const baseDir =
    process.env["USAGE_STORAGE_DIR"] ||
    join(process.cwd(), ".claude", "connectors", connector, "usage");

  let entries;
  try { entries = readdirSync(baseDir); } catch { return; }

  const cutoff = Date.now() - staleHours * 60 * 60 * 1000;

  // Dynamic-import the sibling summarizer module.
  let summarizeSession;
  try {
    const mod = await import(new URL("./session-summary.mjs", import.meta.url).href);
    summarizeSession = mod.summarizeSession;
  } catch {
    return;
  }
  if (typeof summarizeSession !== "function") return;

  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = name.slice(0, -".jsonl".length);
    const summaryPath = join(baseDir, `summary-${sessionId}.json`);
    if (existsSync(summaryPath)) continue;
    let st;
    try { st = statSync(join(baseDir, name)); } catch { continue; }
    if (st.mtimeMs > cutoff) continue;
    try { summarizeSession(baseDir, connector, sessionId); } catch {}
  }

  // Retention pass — gzip old files, delete very-old gz files.
  const gzipDays = Number(process.env["USAGE_RETENTION_GZIP_DAYS"] ?? "30");
  const deleteDays = Number(process.env["USAGE_RETENTION_DELETE_DAYS"] ?? "180");
  if ((Number.isFinite(gzipDays) && gzipDays > 0) || (Number.isFinite(deleteDays) && deleteDays > 0)) {
    try {
      const { runRetention } = await import(
        new URL(
          "../dist/usage/retention.js",
          import.meta.url,
        ).href,
      );
      if (typeof runRetention === "function") {
        await runRetention(baseDir, {
          gzipDays: Number.isFinite(gzipDays) ? gzipDays : 0,
          deleteDays: Number.isFinite(deleteDays) ? deleteDays : 0,
        });
      }
    } catch {
      // swallow — retention is best-effort
    }
  }
}

main().catch(() => {}).finally(() => process.exit(0));
