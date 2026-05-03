import { Bench } from "tinybench";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileProvider } from "../dist/index.js";

function writeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cred-bench-"));
  const file = path.join(dir, "creds.json");
  const data = { flat: "v1" };
  for (let i = 0; i < 50; i++) {
    data[`key_${i}`] = `value_${i}`;
  }
  data["db-prod"] = { username: "alice", password: "hunter2" };
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export async function runFileBench() {
  const bench = new Bench({ time: 100 });
  const fixture = writeFixture();

  bench.add("FileProvider.getSecret cold load (new provider each call)", async () => {
    const p = new FileProvider({ path: fixture, suppressWarning: true });
    await p.getSecret("flat");
  });

  const cached = new FileProvider({ path: fixture, suppressWarning: true });
  await cached.getSecret("flat");

  bench.add("FileProvider.getSecret cached top-level hit", async () => {
    await cached.getSecret("flat");
  });

  bench.add("FileProvider.getSecret cached dot-path hit", async () => {
    await cached.getSecret("db-prod.username");
  });

  bench.add("FileProvider.getSecret cached miss", async () => {
    await cached.getSecret("does-not-exist");
  });

  await bench.run();
  return bench;
}
