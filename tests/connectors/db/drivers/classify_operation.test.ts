/**
 * Tests for `DatabaseDriver.classifyOperation` (G-DB-1, V2.0 vocab).
 *
 * Verifies that:
 *  - Relational drivers delegate to `classifySqlKeywords`.
 *  - MongoDB classifies envelope and dot-notation queries (find → READ,
 *    insertOne → WRITE, deleteMany → DELETE, dropCollection → ADMIN).
 *  - DynamoDB classifies envelope and AWS-SDK command names (scan → READ,
 *    PutItem → WRITE, DeleteItem → DELETE, CreateTable → ADMIN).
 *  - Unknown verbs default to ADMIN (default-deny).
 *  - Empty input throws.
 */
import { describe, expect, it } from "vitest";

import { OperationType } from "../../../../src/connectors/db/lib/policy.js";
import { SQLiteDriver } from "../../../../src/connectors/db/lib/drivers/sqlite.js";
import { PostgresDriver } from "../../../../src/connectors/db/lib/drivers/postgresql.js";
import { MysqlDriver } from "../../../../src/connectors/db/lib/drivers/mysql.js";
import { SqlServerDriver } from "../../../../src/connectors/db/lib/drivers/sqlserver.js";
import { MongoDriver } from "../../../../src/connectors/db/lib/drivers/mongodb.js";
import {
  DynamoDriver,
  DynamoEnvelopeParseError,
} from "../../../../src/connectors/db/lib/drivers/dynamodb.js";

describe("DatabaseDriver.classifyOperation — G-DB-1", () => {
  describe("relational drivers (delegate to SQL keyword classifier)", () => {
    const drivers: [string, { new (): { classifyOperation(q: string): string } }][] = [
      ["sqlite", SQLiteDriver],
      ["postgres", PostgresDriver],
      ["mysql", MysqlDriver],
      ["sqlserver", SqlServerDriver],
    ];

    for (const [name, Ctor] of drivers) {
      describe(name, () => {
        const d = new Ctor();
        it("SELECT classifies as READ", () => {
          expect(d.classifyOperation("SELECT 1")).toBe(OperationType.READ);
        });
        it("INSERT classifies as WRITE", () => {
          expect(d.classifyOperation("INSERT INTO t (a) VALUES (1)")).toBe(
            OperationType.WRITE,
          );
        });
        it("DELETE classifies as DELETE", () => {
          expect(d.classifyOperation("DELETE FROM t WHERE id=1")).toBe(
            OperationType.DELETE,
          );
        });
        it("TRUNCATE classifies as DELETE (V2.0: moved from admin)", () => {
          expect(d.classifyOperation("TRUNCATE TABLE t")).toBe(
            OperationType.DELETE,
          );
        });
        it("DROP classifies as ADMIN", () => {
          expect(d.classifyOperation("DROP TABLE users")).toBe(OperationType.ADMIN);
        });
        it("GRANT classifies as PRIVILEGE", () => {
          expect(d.classifyOperation("GRANT SELECT ON t TO u")).toBe(
            OperationType.PRIVILEGE,
          );
        });
        it("empty input throws", () => {
          expect(() => d.classifyOperation("   ")).toThrow(/Empty SQL statement/);
        });
        it("unknown first-word defaults to ADMIN", () => {
          expect(d.classifyOperation("VACUUM users")).toBe(OperationType.ADMIN);
        });
      });
    }
  });

  describe("MongoDriver — envelope form", () => {
    const d = new MongoDriver();
    it("find → READ", () => {
      expect(
        d.classifyOperation(JSON.stringify({ collection: "users", op: "find" })),
      ).toBe(OperationType.READ);
    });
    it("insertOne → WRITE", () => {
      expect(
        d.classifyOperation(
          JSON.stringify({ collection: "users", op: "insertOne" }),
        ),
      ).toBe(OperationType.WRITE);
    });
    it("deleteMany → DELETE", () => {
      expect(
        d.classifyOperation(
          JSON.stringify({ collection: "users", op: "deleteMany" }),
        ),
      ).toBe(OperationType.DELETE);
    });
    it("dropCollection → ADMIN", () => {
      expect(
        d.classifyOperation(
          JSON.stringify({ collection: "users", op: "dropCollection" }),
        ),
      ).toBe(OperationType.ADMIN);
    });
    it("createIndex → ADMIN", () => {
      expect(
        d.classifyOperation(
          JSON.stringify({ collection: "users", op: "createIndex" }),
        ),
      ).toBe(OperationType.ADMIN);
    });
    it("unknown op → ADMIN", () => {
      expect(
        d.classifyOperation(
          JSON.stringify({ collection: "users", op: "doSomethingNew" }),
        ),
      ).toBe(OperationType.ADMIN);
    });
  });

  describe("MongoDriver — dot-notation form", () => {
    const d = new MongoDriver();
    it("db.users.find({}) → READ", () => {
      expect(d.classifyOperation("db.users.find({})")).toBe(OperationType.READ);
    });
    it("db.users.insertOne({...}) → WRITE", () => {
      expect(d.classifyOperation('db.users.insertOne({"name": "x"})')).toBe(
        OperationType.WRITE,
      );
    });
    it("db.users.deleteMany({}) → DELETE", () => {
      expect(d.classifyOperation("db.users.deleteMany({})")).toBe(
        OperationType.DELETE,
      );
    });
    it("db.users.createIndex({a: 1}) → ADMIN", () => {
      expect(d.classifyOperation("db.users.createIndex({a: 1})")).toBe(
        OperationType.ADMIN,
      );
    });
    it("empty input throws", () => {
      expect(() => d.classifyOperation("  ")).toThrow(/Empty MongoDB statement/);
    });
  });

  describe("DynamoDriver — envelope form", () => {
    const d = new DynamoDriver();
    it("scan → READ", () => {
      expect(
        d.classifyOperation(JSON.stringify({ table: "users", op: "scan" })),
      ).toBe(OperationType.READ);
    });
    it("get → READ", () => {
      expect(
        d.classifyOperation(JSON.stringify({ table: "users", op: "get" })),
      ).toBe(OperationType.READ);
    });
    it("put → WRITE", () => {
      expect(
        d.classifyOperation(JSON.stringify({ table: "users", op: "put" })),
      ).toBe(OperationType.WRITE);
    });
    it("delete → DELETE", () => {
      expect(
        d.classifyOperation(JSON.stringify({ table: "users", op: "delete" })),
      ).toBe(OperationType.DELETE);
    });
    it("createTable → ADMIN", () => {
      expect(
        d.classifyOperation(
          JSON.stringify({ table: "users", op: "createTable" }),
        ),
      ).toBe(OperationType.ADMIN);
    });
  });

  describe("DynamoDriver — AWS SDK command form", () => {
    const d = new DynamoDriver();
    it("ScanCommand → READ", () => {
      expect(
        d.classifyOperation(
          'await client.send(new ScanCommand({TableName: "users"}))',
        ),
      ).toBe(OperationType.READ);
    });
    it("PutItemCommand → WRITE", () => {
      expect(
        d.classifyOperation(
          'await client.send(new PutItemCommand({TableName: "users", Item: {}}))',
        ),
      ).toBe(OperationType.WRITE);
    });
    it("DeleteItemCommand → DELETE", () => {
      expect(
        d.classifyOperation(
          'await client.send(new DeleteItemCommand({TableName: "users", Key: {}}))',
        ),
      ).toBe(OperationType.DELETE);
    });
    it("CreateTableCommand → ADMIN", () => {
      expect(
        d.classifyOperation(
          'await client.send(new CreateTableCommand({TableName: "users"}))',
        ),
      ).toBe(OperationType.ADMIN);
    });
    it("empty input throws", () => {
      expect(() => d.classifyOperation("  ")).toThrow(/Empty DynamoDB statement/);
    });
  });

  // G-DYNAMO-PARSE-ERROR: a truncated JSON envelope used to fall
  // through to SDK-name regex matching and default to ADMIN with the
  // unhelpful "ADMIN statements are never allowed" deny reason. The
  // driver now surfaces a distinct parse error.
  describe("DynamoDriver — malformed envelope", () => {
    const d = new DynamoDriver();
    it("truncated envelope throws DynamoEnvelopeParseError, not ADMIN", () => {
      const truncated = '{"table":"users","op":"Get';
      expect(() => d.classifyOperation(truncated)).toThrow(
        DynamoEnvelopeParseError,
      );
      expect(() => d.classifyOperation(truncated)).toThrow(
        /Malformed envelope JSON/,
      );
    });
    it("trailing comma in envelope throws parse error", () => {
      expect(() => d.classifyOperation('{"op":"scan",}')).toThrow(
        DynamoEnvelopeParseError,
      );
    });
  });
});
