import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// Deliberately never prints the MCP URL, its token or credential values.
// Point this at a connection URL you created in the browser:
//   MCP_URL='https://.../mcp/<id>.<token>' npm run smoke

let stage = "startup";
try {
  let url = process.env.MCP_URL;
  if (!url) {
    try {
      const contents = await readFile(resolve(".var.dev"), "utf8");
      url = /^MCP_URL=(.+)$/m.exec(contents)?.[1]?.trim();
    } catch {
      // Fall through to the message below.
    }
  }
  if (!url) throw new Error("Set MCP_URL to a connection URL created in the UI.");

  const client = new Client({ name: "mcp-starter-smoke", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { redirect: "error" },
  });

  stage = "connect";
  await client.connect(transport);
  stage = "list tools";
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "discover",
    "execute_read",
    "execute_write",
  ]);

  stage = "discover";
  const discovered = await client.callTool({
    name: "discover",
    arguments: { detail: true, limit: 100 },
  });
  assert.ok(!discovered.isError, "Discovery failed");
  const catalogue = discovered.structuredContent;
  assert.equal(typeof catalogue.catalog_version, "string");
  assert.equal(typeof catalogue.has_more, "boolean");
  assert.ok(catalogue.operations.length > 0, "This connection has no permitted operations.");

  const list = catalogue.operations.find((operation) => operation.id === "notes:list");
  if (list) {
    stage = "read";
    const read = await client.callTool({
      name: "execute_read",
      arguments: {
        operation_id: "notes:list",
        catalog_version: catalogue.catalog_version,
        arguments: { limit: 2 },
      },
    });
    assert.ok(!read.isError, "Read failed");
    assert.ok(Array.isArray(read.structuredContent.notes));
    assert.equal(typeof read.structuredContent.has_more, "boolean");
  }

  const create = catalogue.operations.find((operation) => operation.id === "notes:create");
  if (create) {
    stage = "write";
    const write = await client.callTool({
      name: "execute_write",
      arguments: {
        operation_id: "notes:create",
        catalog_version: catalogue.catalog_version,
        arguments: { title: "Smoke test note", body: "Created by scripts/smoke.mjs." },
      },
    });
    assert.ok(!write.isError, "Write failed");
    assert.equal(write.structuredContent.mutation_sent, true);
    assert.equal(write.structuredContent.automatic_retry, false);
  } else {
    console.log("Connection is read-only; skipped the write check.");
  }

  await client.close();
  console.log(`Smoke test passed (${catalogue.operations.length} permitted operations).`);
} catch (error) {
  // Do not print error.message: a transport error may include the private URL.
  console.error(`Smoke test failed during: ${stage}`);
  console.error(error instanceof Error ? error.name : "Unknown error");
  process.exitCode = 1;
}
