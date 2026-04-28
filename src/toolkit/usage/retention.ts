import { readdirSync, statSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export interface RetentionOptions {
  gzipDays: number;   // 0 disables gzip
  deleteDays: number; // 0 disables delete
}

const TARGETS = /\.(jsonl|md)$/;
const GZIPPED = /\.(jsonl|md)\.gz$/;

export async function runRetention(dir: string, opts: RetentionOptions): Promise<void> {
  const now = Date.now();
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }

  // Gzip pass
  if (opts.gzipDays > 0) {
    const cutoff = now - opts.gzipDays * 24 * 60 * 60 * 1000;
    for (const name of entries) {
      if (!TARGETS.test(name)) continue;
      const p = join(dir, name);
      let s;
      try { s = statSync(p); } catch { continue; }
      if (s.mtimeMs > cutoff) continue;
      try {
        const data = readFileSync(p);
        writeFileSync(`${p}.gz`, gzipSync(data));
        unlinkSync(p);
      } catch {
        // swallow — next run will retry
      }
    }
  }

  // Delete pass (re-read: gzip pass may have added .gz files)
  if (opts.deleteDays > 0) {
    const cutoff = now - opts.deleteDays * 24 * 60 * 60 * 1000;
    let entries2: string[];
    try { entries2 = readdirSync(dir); } catch { return; }
    for (const name of entries2) {
      if (!GZIPPED.test(name)) continue;
      const p = join(dir, name);
      let s;
      try { s = statSync(p); } catch { continue; }
      if (s.mtimeMs > cutoff) continue;
      try { unlinkSync(p); } catch {}
    }
  }
}
