import { Bench } from "tinybench";
import { EnvVarProvider } from "../dist/index.js";

export async function runEnvVarBench() {
  const bench = new Bench({ time: 100 });

  const provider = new EnvVarProvider();
  const prefixed = new EnvVarProvider({ prefix: "MYAPP_" });

  process.env.DB_PROD_USERNAME = "alice";
  process.env.MYAPP_DB_PROD_USERNAME = "bob";
  process.env["literal-name"] = "literal-hit";

  bench.add("EnvVarProvider.getSecret hit (normalized)", async () => {
    await provider.getSecret("db-prod-username");
  });

  bench.add("EnvVarProvider.getSecret miss", async () => {
    await provider.getSecret("not-a-real-secret-xyz-12345");
  });

  bench.add("EnvVarProvider.getSecret literal hit", async () => {
    await provider.getSecret("literal-name");
  });

  bench.add("EnvVarProvider.getSecret with prefix", async () => {
    await prefixed.getSecret("db-prod-username");
  });

  await bench.run();
  return bench;
}
