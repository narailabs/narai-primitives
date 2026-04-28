/**
 * Coverage extras for the SQL drivers' connect-time config branches:
 * SSL handling (true | object | undefined), pool sizing, optional
 * user/password, and connection-string form. These are the branches
 * the existing test_*.test.ts suites only partially cover.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks shared via vi.hoisted ────────────────────────────────────────

const mysqlMocks = vi.hoisted(() => {
  class MockPool {
    public readonly config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
    }
    async getConnection(): Promise<unknown> {
      return {
        query: vi.fn(async () => [[], []]),
        release: vi.fn(),
        beginTransaction: vi.fn(async () => undefined),
        commit: vi.fn(async () => undefined),
        rollback: vi.fn(async () => undefined),
      };
    }
    end(): Promise<void> {
      return Promise.resolve();
    }
  }
  const instances: MockPool[] = [];
  return { MockPool, instances };
});

vi.mock("mysql2/promise", () => ({
  createPool: (config: Record<string, unknown>) => {
    const p = new mysqlMocks.MockPool(config);
    mysqlMocks.instances.push(p);
    return p;
  },
  default: {
    createPool: (config: Record<string, unknown>) => {
      const p = new mysqlMocks.MockPool(config);
      mysqlMocks.instances.push(p);
      return p;
    },
  },
}));

const pgMocks = vi.hoisted(() => {
  class MockPool {
    public readonly config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
    }
    async connect(): Promise<unknown> {
      return {
        query: vi.fn(async () => ({ rows: [], fields: [] })),
        release: vi.fn(),
      };
    }
    end(): Promise<void> {
      return Promise.resolve();
    }
  }
  const instances: MockPool[] = [];
  return { MockPool, instances };
});

vi.mock("pg", () => ({
  default: {
    Pool: function (config: Record<string, unknown>) {
      const p = new pgMocks.MockPool(config);
      pgMocks.instances.push(p);
      return p;
    },
  },
  Pool: function (config: Record<string, unknown>) {
    const p = new pgMocks.MockPool(config);
    pgMocks.instances.push(p);
    return p;
  },
}));

const mssqlMocks = vi.hoisted(() => {
  class MockConnectionPool {
    public readonly config: Record<string, unknown>;
    public _connected = false;
    constructor(config: Record<string, unknown>) {
      this.config = config;
    }
    async connect(): Promise<this> {
      this._connected = true;
      return this;
    }
    request(): unknown {
      return {
        input: vi.fn().mockReturnThis(),
        query: vi.fn(async () => ({ recordset: [] })),
      };
    }
    transaction(): unknown {
      return {
        begin: vi.fn(async () => undefined),
        commit: vi.fn(async () => undefined),
        rollback: vi.fn(async () => undefined),
        request: () => this.request(),
      };
    }
    close(): Promise<void> {
      this._connected = false;
      return Promise.resolve();
    }
  }
  const instances: MockConnectionPool[] = [];
  return { MockConnectionPool, instances };
});

vi.mock("mssql", () => ({
  default: {
    ConnectionPool: function (config: Record<string, unknown>) {
      const p = new mssqlMocks.MockConnectionPool(config);
      mssqlMocks.instances.push(p);
      return p;
    },
    ISOLATION_LEVEL: { READ_COMMITTED: 0x1000 },
  },
  ConnectionPool: function (config: Record<string, unknown>) {
    const p = new mssqlMocks.MockConnectionPool(config);
    mssqlMocks.instances.push(p);
    return p;
  },
  ISOLATION_LEVEL: { READ_COMMITTED: 0x1000 },
}));

import { MysqlDriver } from "../../../../src/connectors/db/lib/drivers/mysql.js";
import { PostgresDriver } from "../../../../src/connectors/db/lib/drivers/postgresql.js";
import { SqlServerDriver } from "../../../../src/connectors/db/lib/drivers/sqlserver.js";

beforeEach(() => {
  mysqlMocks.instances.length = 0;
  pgMocks.instances.length = 0;
  mssqlMocks.instances.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── MySQL ──────────────────────────────────────────────────────────────

describe("MysqlDriver — connect config branches", () => {
  function latest(): InstanceType<typeof mysqlMocks.MockPool> {
    const p = mysqlMocks.instances[mysqlMocks.instances.length - 1];
    if (!p) throw new Error("no pool");
    return p;
  }

  it("ssl=true => { rejectUnauthorized: false }", async () => {
    const drv = new MysqlDriver();
    await drv.connect({ database: "app", ssl: true });
    expect(latest().config["ssl"]).toEqual({ rejectUnauthorized: false });
  });

  it("ssl=object passes through", async () => {
    const drv = new MysqlDriver();
    await drv.connect({
      database: "app",
      ssl: { ca: "PEM", rejectUnauthorized: true },
    });
    expect(latest().config["ssl"]).toEqual({
      ca: "PEM",
      rejectUnauthorized: true,
    });
  });

  it("ssl=null => undefined (no ssl key)", async () => {
    const drv = new MysqlDriver();
    await drv.connect({ database: "app", ssl: null });
    expect(latest().config).not.toHaveProperty("ssl");
  });

  it("ssl=false => undefined", async () => {
    const drv = new MysqlDriver();
    await drv.connect({ database: "app", ssl: false });
    expect(latest().config).not.toHaveProperty("ssl");
  });

  it("pool_max as number wins over default 10", async () => {
    const drv = new MysqlDriver();
    await drv.connect({ database: "app", pool_max: 25 });
    expect(latest().config["connectionLimit"]).toBe(25);
  });

  it("pool_max non-number falls back to 10", async () => {
    const drv = new MysqlDriver();
    await drv.connect({ database: "app", pool_max: "twenty" });
    expect(latest().config["connectionLimit"]).toBe(10);
  });

  it("missing user/password => fields not present", async () => {
    const drv = new MysqlDriver();
    await drv.connect({ database: "app" });
    expect(latest().config).not.toHaveProperty("user");
    expect(latest().config).not.toHaveProperty("password");
  });

  it("non-string host falls back to localhost", async () => {
    const drv = new MysqlDriver();
    await drv.connect({ database: "app", host: 123 });
    expect(latest().config["host"]).toBe("localhost");
  });

  it("non-number port falls back to 3306", async () => {
    const drv = new MysqlDriver();
    await drv.connect({ database: "app", port: "5432" });
    expect(latest().config["port"]).toBe(3306);
  });

  it("non-string database falls back to empty", async () => {
    const drv = new MysqlDriver();
    const handle = await drv.connect({});
    expect(handle.database).toBe("");
  });
});

// ── PostgreSQL ─────────────────────────────────────────────────────────

describe("PostgresDriver — connect config branches", () => {
  function latest(): InstanceType<typeof pgMocks.MockPool> {
    const p = pgMocks.instances[pgMocks.instances.length - 1];
    if (!p) throw new Error("no pool");
    return p;
  }

  it("ssl=true => { rejectUnauthorized: false }", async () => {
    const drv = new PostgresDriver();
    await drv.connect({ database: "app", ssl: true });
    expect(latest().config["ssl"]).toEqual({ rejectUnauthorized: false });
  });

  it("ssl=object passes through", async () => {
    const drv = new PostgresDriver();
    await drv.connect({
      database: "app",
      ssl: { ca: "PEM", rejectUnauthorized: true },
    });
    expect(latest().config["ssl"]).toEqual({
      ca: "PEM",
      rejectUnauthorized: true,
    });
  });

  it("ssl=false => undefined", async () => {
    const drv = new PostgresDriver();
    await drv.connect({ database: "app", ssl: false });
    expect(latest().config).not.toHaveProperty("ssl");
  });

  it("ssl=null => undefined", async () => {
    const drv = new PostgresDriver();
    await drv.connect({ database: "app", ssl: null });
    expect(latest().config).not.toHaveProperty("ssl");
  });

  it("pool_max=25 wins over default", async () => {
    const drv = new PostgresDriver();
    await drv.connect({ database: "app", pool_max: 25 });
    expect(latest().config["max"]).toBe(25);
  });

  it("non-number port falls back to 5432", async () => {
    const drv = new PostgresDriver();
    await drv.connect({ database: "app", port: "five" });
    expect(latest().config["port"]).toBe(5432);
  });

  it("non-string host falls back to localhost", async () => {
    const drv = new PostgresDriver();
    await drv.connect({ database: "app", host: null });
    expect(latest().config["host"]).toBe("localhost");
  });

  it("missing user/password => not present", async () => {
    const drv = new PostgresDriver();
    await drv.connect({ database: "app" });
    expect(latest().config).not.toHaveProperty("user");
    expect(latest().config).not.toHaveProperty("password");
  });
});

// ── SQL Server ─────────────────────────────────────────────────────────

describe("SqlServerDriver — connect config branches", () => {
  function latest(): InstanceType<typeof mssqlMocks.MockConnectionPool> {
    const p = mssqlMocks.instances[mssqlMocks.instances.length - 1];
    if (!p) throw new Error("no pool");
    return p;
  }

  it("ssl=true => encrypt true, trustServerCertificate false", async () => {
    const drv = new SqlServerDriver();
    await drv.connect({ host: "h", database: "app", user: "u", password: "p", ssl: true });
    const opts = latest().config["options"] as Record<string, unknown>;
    expect(opts?.["encrypt"]).toBe(true);
    expect(opts?.["trustServerCertificate"]).toBe(false);
  });

  it("ssl=false => encrypt false, trustServerCertificate true", async () => {
    const drv = new SqlServerDriver();
    await drv.connect({ host: "h", database: "app", user: "u", password: "p", ssl: false });
    const opts = latest().config["options"] as Record<string, unknown>;
    expect(opts?.["encrypt"]).toBe(false);
    expect(opts?.["trustServerCertificate"]).toBe(true);
  });

  it("instance option passes through to options", async () => {
    const drv = new SqlServerDriver();
    await drv.connect({
      host: "h",
      database: "app",
      user: "u",
      password: "p",
      instance: "SQLEXPRESS",
    });
    const opts = latest().config["options"] as Record<string, unknown>;
    expect(opts?.["instanceName"]).toBe("SQLEXPRESS");
  });

  it("non-number port falls back to 1433", async () => {
    const drv = new SqlServerDriver();
    await drv.connect({ host: "h", database: "app", user: "u", password: "p", port: "abc" });
    expect(latest().config["port"]).toBe(1433);
  });

  it("non-string host falls back to localhost", async () => {
    const drv = new SqlServerDriver();
    await drv.connect({ database: "app", user: "u", password: "p", host: 99 });
    expect(latest().config["server"]).toBe("localhost");
  });
});

// ── Driver lazy-load failure paths ──────────────────────────────────────

describe("Driver lazy-load failure paths", () => {
  it("MysqlDriver raises a helpful error if mysql2 cannot be loaded", async () => {
    vi.doMock("mysql2/promise", () => {
      throw new Error("Cannot find module 'mysql2'");
    });
    vi.resetModules();
    const { MysqlDriver: Fresh } = await import("../../../../src/connectors/db/lib/drivers/mysql.js");
    const drv = new Fresh();
    await expect(drv.connect({ database: "x" })).rejects.toThrow(
      /requires 'mysql2'/,
    );
    vi.doUnmock("mysql2/promise");
  });

  it("PostgresDriver raises a helpful error if pg cannot be loaded", async () => {
    vi.doMock("pg", () => {
      throw new Error("Cannot find module 'pg'");
    });
    vi.resetModules();
    const { PostgresDriver: Fresh } = await import("../../../../src/connectors/db/lib/drivers/postgresql.js");
    const drv = new Fresh();
    await expect(drv.connect({ database: "x" })).rejects.toThrow(
      /requires 'pg'/,
    );
    vi.doUnmock("pg");
  });
});
