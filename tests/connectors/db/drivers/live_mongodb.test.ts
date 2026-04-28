/**
 * Live-integration tests for MongoDriver.
 *
 * Skipped unless `TEST_LIVE_MONGO` is set. Expects a mongodb container from
 * `fixtures/docker-compose.yml`:
 *   docker compose -f tests/drivers/fixtures/docker-compose.yml up -d --wait mongodb
 *   TEST_LIVE_MONGO=1 npx vitest run tests/drivers/live_mongodb.test.ts
 *
 * No CLI E2E here: MongoDriver uses a JSON envelope query format, not SQL,
 * so the CLI's `--sql` surface is not the right test vehicle. We validate
 * the V2.0 OperationType mapping at the classifier level instead.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MongoClient } from "mongodb";

import { MongoDriver } from "../../../../src/connectors/db/lib/drivers/mongodb.js";

const URI = process.env["TEST_MONGO_URI"] ?? "mongodb://localhost:27017";
const DB_NAME = process.env["TEST_MONGO_DB"] ?? "test";
const CONNECT = { uri: URI, database: DB_NAME };

describe.runIf(process.env["TEST_LIVE_MONGO"] !== undefined)(
  "wiki_db.drivers.mongodb (live)",
  () => {
    const drv = new MongoDriver();
    let handle: unknown;

    beforeAll(async () => {
      const client = new MongoClient(URI);
      await client.connect();
      try {
        const coll = client.db(DB_NAME).collection("users");
        await coll.deleteMany({});
        await coll.insertMany([
          { id: 1, name: "Alice", email: "a@x.com" },
          { id: 2, name: "Bob", email: "b@x.com" },
          { id: 3, name: "Carol", email: "c@x.com" },
        ]);
      } finally {
        await client.close();
      }
      handle = await drv.connect(CONNECT);
    }, 30_000);

    afterAll(async () => {
      try {
        const client = new MongoClient(URI);
        await client.connect();
        await client.db(DB_NAME).collection("users").drop();
        await client.close();
      } catch {
        // best-effort
      }
      await drv.shutdown();
    });

    it("executeReadAsync returns 3 seeded documents", async () => {
      const envelope = JSON.stringify({
        collection: "users",
        op: "find",
        filter: {},
        sort: { id: 1 },
        limit: 10,
      });
      const res = await drv.executeReadAsync(handle, envelope);
      expect(res.status).toBe("success");
      expect(res.row_count).toBe(3);
      expect(res.rows![0]!["name"]).toBe("Alice");
    });

    it("getSchemaAsync reports the users collection with inferred fields", async () => {
      const tables = await drv.getSchemaAsync(handle);
      const users = tables.find((t) => t.name === "users");
      expect(users).toBeDefined();
      const colNames = users!.columns.map((c) => c.name);
      expect(colNames).toEqual(expect.arrayContaining(["id", "name", "email"]));
    });

    it("classifyOperation maps envelope ops to the right OperationType (V2.0 vocab)", () => {
      // classifyOperation expects a JSON envelope or dot-notation. Unknown
      // verbs fall through to the default-deny "admin" bucket.
      expect(drv.classifyOperation('{"op":"createCollection"}')).toBe("admin");
      expect(drv.classifyOperation('{"op":"dropCollection"}')).toBe("admin");
      expect(drv.classifyOperation('{"collection":"users","op":"find"}')).toBe("read");
      expect(drv.classifyOperation('{"collection":"users","op":"insertOne"}')).toBe("write");
      expect(drv.classifyOperation('{"collection":"users","op":"deleteMany"}')).toBe("delete");
    });
  },
);
