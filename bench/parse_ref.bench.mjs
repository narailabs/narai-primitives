import { Bench } from "tinybench";
import { parseCredentialRef } from "../dist/index.js";

function buildCorpus() {
  const providers = ["env_var", "keychain", "file", "cloud_secrets"];
  const aliases = ["env", "cloud"];
  const legacy = [];
  const uri = [];
  const literals = [];

  for (let i = 0; i < 1000; i++) {
    const p = providers[i % providers.length];
    const a = aliases[i % aliases.length];
    legacy.push(`${p}:secret_${i}`);
    legacy.push(`${a}:secret_${i}`);
    uri.push(`${p}://bucket/path/secret_${i}`);
    literals.push(`plain-value-${i}`);
  }
  return { legacy, uri, literals };
}

export async function runParseRefBench() {
  const bench = new Bench({ time: 100 });
  const { legacy, uri, literals } = buildCorpus();

  let legIdx = 0;
  let uriIdx = 0;
  let litIdx = 0;

  bench.add("parseCredentialRef legacy provider:key", () => {
    parseCredentialRef(legacy[legIdx++ % legacy.length]);
  });

  bench.add("parseCredentialRef URI-ish provider://path", () => {
    parseCredentialRef(uri[uriIdx++ % uri.length]);
  });

  bench.add("parseCredentialRef literal (no colon)", () => {
    parseCredentialRef(literals[litIdx++ % literals.length]);
  });

  await bench.run();
  return bench;
}
