# DB connector: per-repo config overlay

The `db` connector reads its target servers and policy from the same two-level
config the rest of `narai-primitives` uses. A user-level file provides defaults;
a repo-level file overlays them. You do not need a flag to opt in — the overlay
is always applied.

## The two files

- User level: `~/.connectors/config.yaml`
- Repo level: `<cwd>/.connectors/config.yaml`

Both are loaded by `loadResolvedConfig` (`src/config/load.ts`), deep-merged with
the repo file winning on conflict. Plain objects merge recursively; arrays and
scalars are replaced wholesale by the repo overlay.

## Overriding a target and policy per-repo

User level (`~/.connectors/config.yaml`) sets the defaults:

```yaml
connectors:
  db:
    skill: db-agent-connector
    policy:
      write: escalate
    servers:
      orders:
        driver: postgresql
        host: db.shared.internal
        database: orders
        user: ro
        password: env:DB_PW
```

Repo level (`<cwd>/.connectors/config.yaml`) overrides only what it names:

```yaml
connectors:
  db:
    policy:
      write: deny            # tighten the global write rule for this repo
    servers:
      orders:
        host: db.local.test  # point the same server at a local target
        policy:
          read: deny         # per-server override, merged onto the global policy
```

After the merge, `connectors.db.servers.orders.host` is `db.local.test` and the
effective `write` rule is `deny` — the repo values win. Keys the repo file does
not mention (`driver`, `database`, `user`, `password`) are inherited from the
user file. The per-server `policy` block is merged onto the connector-level
policy at dispatch time (`mergePolicy` in
`src/connectors/db/lib/plugin_config.ts`).

## The admin/privilege ceiling survives the overlay

The overlay cannot escalate privileges. After merging, the resolved `db` slice
is re-validated by `pluginConfigFromSlice` -> `validateServer`. The safety floor
forbids `admin: allow` and `privilege: allow` at every level — global or
per-server. A repo overlay that sets, for example:

```yaml
connectors:
  db:
    servers:
      orders:
        policy:
          admin: allow       # rejected
```

fails validation with a config error and the connector refuses to run. An
overlay can tighten policy but can never lift the `admin`/`privilege` ceiling.
