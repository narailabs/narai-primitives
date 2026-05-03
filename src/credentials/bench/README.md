# bench/

Micro-benchmarks for `@narai/credential-providers` hot paths, built on
[`tinybench`](https://github.com/tinylibs/tinybench). No CI gating; this is
a developer convenience for spot-checking changes to `EnvVarProvider`,
`parseCredentialRef`, `CredentialResolver`, and `FileProvider`.

## Running

```
npm run build    # bench imports from dist/
node bench/run.mjs
```

The orchestrator runs every `*.bench.mjs` suite below and prints one
combined table sorted by `ops/s`.

## Suites

- `env_var.bench.mjs` — `EnvVarProvider.getSecret`: normalized-name hit,
  miss, literal hit, and prefix variant.
- `parse_ref.bench.mjs` — `parseCredentialRef` across a pre-generated
  1000-entry mix of legacy `provider:key` refs, URI-shaped refs, and plain
  literals. Corpus is pre-generated so iteration is deterministic.
- `resolver.bench.mjs` — `CredentialResolver.resolveSecret` over a
  5-provider chain, covering first-hit, last-hit, full miss, and
  single-provider paths.
- `file.bench.mjs` — `FileProvider.getSecret`: cold load (new provider per
  call, forces disk read + JSON parse) vs cached top-level, cached
  dot-path, and cached miss.

## Interpreting output

- `ops/s` — operations per second. Higher is better.
- `avg (ns)` — mean latency per call in nanoseconds.
- `samples` — number of samples tinybench collected within the 100 ms
  time budget per task.
