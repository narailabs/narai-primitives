import { Bench } from "tinybench";
import { CredentialResolver } from "../dist/index.js";

class StubProvider {
  constructor(knownKey, value) {
    this._key = knownKey;
    this._value = value;
  }
  async getSecret(name) {
    return name === this._key ? this._value : null;
  }
}

export async function runResolverBench() {
  const bench = new Bench({ time: 100 });

  const resolver = new CredentialResolver();
  resolver.register("p1", new StubProvider("only-in-p1", "v1"));
  resolver.register("p2", new StubProvider("only-in-p2", "v2"));
  resolver.register("p3", new StubProvider("only-in-p3", "v3"));
  resolver.register("p4", new StubProvider("only-in-p4", "v4"));
  resolver.register("p5", new StubProvider("only-in-p5", "v5"));

  const fullChain = { provider: "p1", fallback: ["p2", "p3", "p4", "p5"] };

  bench.add("resolveSecret hit on 1st provider (5-chain)", async () => {
    await resolver.resolveSecret("only-in-p1", fullChain);
  });

  bench.add("resolveSecret hit on 5th provider (5-chain)", async () => {
    await resolver.resolveSecret("only-in-p5", fullChain);
  });

  bench.add("resolveSecret full miss (5-chain)", async () => {
    await resolver.resolveSecret("nowhere", fullChain);
  });

  bench.add("resolveSecret single provider hit", async () => {
    await resolver.resolveSecret("only-in-p1", { provider: "p1" });
  });

  await bench.run();
  return bench;
}
