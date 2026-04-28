/**
 * Live-integration tests for DynamoDriver.
 *
 * Skipped unless `TEST_LIVE_DYNAMO` is set. Expects the dynamodb-local service
 * from `fixtures/docker-compose.yml`:
 *   docker compose -f tests/drivers/fixtures/docker-compose.yml up -d --wait dynamodb-local
 *   TEST_LIVE_DYNAMO=1 npx vitest run tests/drivers/live_dynamodb.test.ts
 *
 * No CLI E2E here: DynamoDriver uses a JSON envelope query format, not SQL.
 * We validate the V2.0 OperationType mapping at the classifier level instead.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";

import { DynamoDriver } from "../../../../src/connectors/db/lib/drivers/dynamodb.js";

const ENDPOINT = process.env["TEST_DYNAMO_ENDPOINT"] ?? "http://localhost:8000";
const CONNECT = {
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
};

async function waitForActive(client: DynamoDBClient, table: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const desc = await client.send(new DescribeTableCommand({ TableName: table }));
    if (desc.Table?.TableStatus === "ACTIVE") return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`DynamoDB table ${table} did not reach ACTIVE in ${timeoutMs}ms`);
}

describe.runIf(process.env["TEST_LIVE_DYNAMO"] !== undefined)(
  "wiki_db.drivers.dynamodb (live)",
  () => {
    const drv = new DynamoDriver();
    let handle: unknown;

    beforeAll(async () => {
      const client = new DynamoDBClient(CONNECT);
      try {
        // Best-effort delete before recreate so reruns are idempotent.
        try {
          await client.send(new DeleteTableCommand({ TableName: "users" }));
        } catch {
          // table didn't exist
        }
        await client.send(
          new CreateTableCommand({
            TableName: "users",
            KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
            AttributeDefinitions: [{ AttributeName: "id", AttributeType: "N" }],
            BillingMode: "PAY_PER_REQUEST",
          }),
        );
        await waitForActive(client, "users");
        for (const [id, name, email] of [
          [1, "Alice", "a@x.com"],
          [2, "Bob", "b@x.com"],
          [3, "Carol", "c@x.com"],
        ] as const) {
          await client.send(
            new PutItemCommand({
              TableName: "users",
              Item: {
                id: { N: String(id) },
                name: { S: name },
                email: { S: email },
              },
            }),
          );
        }
      } finally {
        client.destroy();
      }
      handle = await drv.connect(CONNECT);
    }, 30_000);

    afterAll(async () => {
      try {
        const client = new DynamoDBClient(CONNECT);
        await client.send(new DeleteTableCommand({ TableName: "users" }));
        client.destroy();
      } catch {
        // best-effort
      }
      await drv.shutdown();
    });

    it("executeReadAsync returns 3 seeded items via scan", async () => {
      const envelope = JSON.stringify({
        table: "users",
        op: "scan",
        limit: 10,
      });
      const res = await drv.executeReadAsync(handle, envelope);
      expect(res.status).toBe("success");
      expect(res.row_count).toBe(3);
    });

    it("getSchemaAsync reports the users table with id as key", async () => {
      const tables = await drv.getSchemaAsync(handle);
      const users = tables.find((t) => t.name === "users");
      expect(users).toBeDefined();
      const colNames = users!.columns.map((c) => c.name);
      expect(colNames).toContain("id");
    });

    it("classifyOperation maps envelope ops to the right OperationType (V2.0 vocab)", () => {
      // Unknown verbs fall through to the default-deny "admin" bucket.
      expect(drv.classifyOperation('{"op":"createTable"}')).toBe("admin");
      expect(drv.classifyOperation('{"op":"deleteTable"}')).toBe("admin");
      expect(drv.classifyOperation('{"table":"users","op":"scan"}')).toBe("read");
      expect(drv.classifyOperation('{"table":"users","op":"put"}')).toBe("write");
      expect(drv.classifyOperation('{"table":"users","op":"delete"}')).toBe("delete");
    });
  },
);
