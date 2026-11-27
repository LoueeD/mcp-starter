import { exports } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, it } from "vitest";
import { type VirtualAuthenticator, virtualAuthenticator } from "./helpers/webauthn";

/**
 * End-to-end flow against the real Worker: synthetic WebAuthn credentials,
 * account sessions, connection management and the MCP endpoint.
 *
 * The tests use the `exports` service binding so the Worker runs with the same
 * bindings and Durable Objects as `wrangler dev`.
 */

const BASE = "http://localhost:8787";
const SESSION_COOKIE = "__Host-mcp_starter_session";
const CEREMONY_COOKIE = "__Host-mcp_starter_ceremony";

type Json = Record<string, unknown>;
type Session = { cookie: string; csrf: string };
type Connection = { id: string; revision: number; token: string; url: string };

let address = 0;
let ip = "";
const nextIp = () => {
  address += 1;
  ip = `198.51.100.${(address % 240) + 1}`;
  return ip;
};

function headers(session?: Partial<Session>, json = true, includeIp = true) {
  return {
    Origin: BASE,
    "Sec-Fetch-Site": "same-origin",
    ...(includeIp ? { "CF-Connecting-IP": nextIp() } : {}),
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(session?.cookie ? { Cookie: session.cookie } : {}),
    ...(session?.csrf ? { "X-CSRF-Token": session.csrf } : {}),
  };
}

async function send(
  path: string,
  method: string,
  body?: unknown,
  session?: Partial<Session>,
  includeIp = true,
) {
  const response = await exports.default.fetch(
    new Request(BASE + path, {
      method,
      headers: headers(session, body !== undefined, includeIp),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const data = response.headers.get("Content-Type")?.includes("application/json")
    ? ((await response.json()) as Json)
    : {};
  return { response, data };
}

async function get(path: string, session?: Partial<Session>) {
  return send(path, "GET", undefined, session, false);
}

function cookie(response: Response, name: string) {
  const list =
    (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  const value = list.find((entry) => entry.startsWith(`${name}=`));
  if (!value) throw new Error(`Missing ${name} cookie`);
  return value.split(";")[0];
}

function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Json;
}

function fromUrl(value: unknown) {
  if (typeof value !== "string") throw new Error("Missing install URL");
  const url = new URL(value);
  const match = /^\/mcp\/([a-f0-9]{64}\.[A-Za-z0-9_-]{43})$/.exec(url.pathname);
  if (!match) throw new Error("Unexpected MCP URL shape");
  return { url: url.href, token: match[1] };
}

function bytesFromHex(value: string) {
  return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

async function connect(url: string) {
  const client = new Client({ name: "starter-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(input, init);
      return exports.default.fetch(request);
    },
  });
  await client.connect(transport);
  return client;
}

async function discover(client: Client) {
  const result = await client.callTool({ name: "discover", arguments: { detail: true } });
  expect(result.isError).toBeFalsy();
  return record(result.structuredContent) as {
    catalog_version: string;
    operations: Array<{ operation_id: string; kind: string }>;
  };
}

let session: Session;
let authenticator: VirtualAuthenticator;
let accountId: string;
let connection: Connection;

describe("account, connection and MCP flow", () => {
  beforeAll(async () => {
    const health = await get("/health");
    expect(health.response.status).toBe(200);

    const registrationOptions = await send("/api/auth/register/options", "POST", {
      label: "Test account",
    });
    expect(registrationOptions.response.status).toBe(200);
    const options = registrationOptions.data as { challenge: string };
    const ceremony = cookie(registrationOptions.response, CEREMONY_COOKIE);

    authenticator = await virtualAuthenticator("localhost", BASE);
    const registration = await send(
      "/api/auth/register/verify",
      "POST",
      { response: authenticator.registration(options.challenge) },
      { cookie: ceremony },
    );
    expect(registration.response.status).toBe(201);
    accountId = String(record(registration.data.account).id);
    expect(accountId).toMatch(/^[a-f0-9]{64}$/);
    session = {
      cookie: cookie(registration.response, SESSION_COOKIE),
      csrf: String(registration.data.csrf_token),
    };

    const created = await send(
      "/api/connections",
      "POST",
      { name: "Test connection", credential: "demo_test_only" },
      session,
    );
    expect(created.response.status).toBe(201);
    const installed = fromUrl(created.data.install_url);
    const row = record(created.data.connection);
    connection = {
      id: String(row.id),
      revision: Number(row.revision),
      token: installed.token,
      url: installed.url,
    };
  });

  it("serves an authenticated passkey session and logs in again", async () => {
    const current = await get("/api/auth/session", session);
    expect(current.response.status).toBe(200);
    expect(current.data.authenticated).toBe(true);
    expect(record(current.data.account).id).toBe(accountId);
    expect(current.data.csrf_token).toBe(session.csrf);

    const signedOut = await send("/api/auth/session", "DELETE", {}, session);
    expect(signedOut.response.status).toBe(200);
    expect(cookie(signedOut.response, SESSION_COOKIE)).toBe(`${SESSION_COOKIE}=`);

    const anonymous = await get("/api/auth/session");
    expect(anonymous.data.authenticated).toBe(false);

    const loginOptions = await send("/api/auth/login/options", "POST", {});
    expect(loginOptions.response.status).toBe(200);
    const challenge = (loginOptions.data as { challenge: string }).challenge;
    const ceremony = cookie(loginOptions.response, CEREMONY_COOKIE);
    const assertion = await authenticator.assertion(challenge, bytesFromHex(accountId));
    const login = await send(
      "/api/auth/login/verify",
      "POST",
      { response: assertion },
      { cookie: ceremony },
    );
    expect(login.response.status).toBe(200);
    expect(login.data.authenticated).toBe(true);
    session = {
      cookie: cookie(login.response, SESSION_COOKIE),
      csrf: String(login.data.csrf_token),
    };

    const afterLogin = await get("/api/auth/session", session);
    expect(afterLogin.data.authenticated).toBe(true);
  });

  it("discovers a compact catalogue and reads with pagination metadata", async () => {
    const client = await connect(connection.url);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "discover",
        "execute_read",
        "execute_write",
      ]);

      const catalogue = await discover(client);
      expect(catalogue.catalog_version).toMatch(/^[a-f0-9]{64}$/);
      expect(catalogue.operations.map((operation) => operation.operation_id).sort()).toEqual([
        "notes:get",
        "notes:list",
      ]);
      expect(catalogue.operations.every((operation) => operation.kind !== "create")).toBe(true);

      const firstPage = record(
        (await client.callTool({ name: "discover", arguments: { limit: 1 } })).structuredContent,
      );
      expect((firstPage.operations as unknown[]).length).toBe(1);
      expect(firstPage.total_operations).toBe(2);
      expect(firstPage.has_more).toBe(true);
      expect(firstPage.next_cursor).toEqual(expect.any(String));
      const secondPage = record(
        (
          await client.callTool({
            name: "discover",
            arguments: { limit: 1, cursor: String(firstPage.next_cursor) },
          })
        ).structuredContent,
      );
      expect((secondPage.operations as unknown[]).length).toBe(1);
      expect(secondPage.has_more).toBe(false);
      expect(secondPage.next_cursor).toBeNull();
      expect(record((secondPage.operations as unknown[])[0]).operation_id).not.toBe(
        record((firstPage.operations as unknown[])[0]).operation_id,
      );

      const invalidCursor = await client.callTool({
        name: "discover",
        arguments: { cursor: "not-a-cursor" },
      });
      expect(invalidCursor.isError).toBe(true);
      expect(record(record(invalidCursor.structuredContent).error).code).toBe("INVALID_CURSOR");

      const read = await client.callTool({
        name: "execute_read",
        arguments: {
          operation_id: "notes:list",
          catalog_version: catalogue.catalog_version,
          arguments: { limit: 2 },
        },
      });
      expect(read.isError).toBeFalsy();
      const page = record(read.structuredContent);
      expect(Array.isArray(page.notes)).toBe(true);
      expect((page.notes as unknown[]).length).toBeLessThanOrEqual(2);
      expect(typeof page.has_more).toBe("boolean");
      expect(page.result_scope).toMatch(/has_more/);
    } finally {
      await client.close();
    }
  });

  it("rejects writes outside the connection's access scope", async () => {
    const client = await connect(connection.url);
    try {
      const catalogue = await discover(client);
      const write = await client.callTool({
        name: "execute_write",
        arguments: {
          operation_id: "notes:create",
          catalog_version: catalogue.catalog_version,
          arguments: { title: "Should not exist" },
        },
      });
      expect(write.isError).toBe(true);
      const error = record(record(write.structuredContent).error);
      expect(error.code).toBe("ACCESS_DENIED");
      expect(record(write.structuredContent).mutation_sent).toBe(false);

      const wrongExecutor = await client.callTool({
        name: "execute_write",
        arguments: {
          operation_id: "notes:list",
          catalog_version: catalogue.catalog_version,
          arguments: {},
        },
      });
      expect(wrongExecutor.isError).toBe(true);
      expect(record(record(wrongExecutor.structuredContent).error).code).toBe("WRONG_EXECUTOR");

      const stale = await client.callTool({
        name: "execute_read",
        arguments: {
          operation_id: "notes:list",
          catalog_version: "0".repeat(64),
          arguments: {},
        },
      });
      expect(stale.isError).toBe(true);
      expect(record(record(stale.structuredContent).error).code).toBe("SCHEMA_CHANGED");
    } finally {
      await client.close();
    }
  });

  it("applies an access policy and permits a read-back write", async () => {
    const saved = await send(
      `/api/connections/${connection.id}/access`,
      "PUT",
      {
        revision: connection.revision,
        policy: {
          version: 1,
          resources: {
            notes: { read: true, create: true, update: true, delete: true },
          },
        },
      },
      session,
    );
    expect(saved.response.status).toBe(200);
    connection.revision = Number(record(saved.data.connection).revision);
    expect(connection.revision).toBeGreaterThan(1);

    const client = await connect(connection.url);
    try {
      const catalogue = await discover(client);
      expect(catalogue.operations.map((operation) => operation.operation_id).sort()).toEqual([
        "notes:create",
        "notes:delete",
        "notes:get",
        "notes:list",
        "notes:update",
      ]);

      const created = await client.callTool({
        name: "execute_write",
        arguments: {
          operation_id: "notes:create",
          catalog_version: catalogue.catalog_version,
          arguments: { title: "Created over MCP", body: "Read back after the write." },
        },
      });
      expect(created.isError).toBeFalsy();
      const result = record(created.structuredContent);
      expect(result.mutation_sent).toBe(true);
      expect(result.automatic_retry).toBe(false);
      expect(result.read_back).toBe(true);
      const note = record(result.note);
      expect(note.title).toBe("Created over MCP");
      expect(String(note.id)).toMatch(/^note_[a-f0-9]{16}$/);

      const readBack = await client.callTool({
        name: "execute_read",
        arguments: {
          operation_id: "notes:get",
          catalog_version: catalogue.catalog_version,
          arguments: { id: note.id },
        },
      });
      expect(readBack.isError).toBeFalsy();
      expect(record(record(readBack.structuredContent).note).id).toBe(note.id);

      // Only the supplied field changes; title and body stay as they were.
      const updated = await client.callTool({
        name: "execute_write",
        arguments: {
          operation_id: "notes:update",
          catalog_version: catalogue.catalog_version,
          arguments: {
            id: note.id,
            changes: { status: "done" },
            expected_updated_at: note.updated_at,
          },
        },
      });
      expect(updated.isError).toBeFalsy();
      const updatedNote = record(record(updated.structuredContent).note);
      expect(updatedNote.status).toBe("done");
      expect(updatedNote.title).toBe(note.title);
      expect(updatedNote.body).toBe(note.body);
      expect(Number(updatedNote.updated_at)).toBeGreaterThan(Number(note.updated_at));

      const conflict = await client.callTool({
        name: "execute_write",
        arguments: {
          operation_id: "notes:update",
          catalog_version: catalogue.catalog_version,
          arguments: {
            id: note.id,
            changes: { title: "Stale overwrite" },
            expected_updated_at: note.updated_at,
          },
        },
      });
      expect(conflict.isError).toBe(true);
      const conflictError = record(record(conflict.structuredContent).error);
      expect(conflictError.code).toBe("CONFLICT");
      expect(record(conflictError.current).status).toBe("done");

      const deleted = await client.callTool({
        name: "execute_write",
        arguments: {
          operation_id: "notes:delete",
          catalog_version: catalogue.catalog_version,
          arguments: { id: note.id },
        },
      });
      expect(deleted.isError).toBeFalsy();
      expect(record(record(deleted.structuredContent).deleted).id).toBe(note.id);

      const missing = await client.callTool({
        name: "execute_read",
        arguments: {
          operation_id: "notes:get",
          catalog_version: catalogue.catalog_version,
          arguments: { id: note.id },
        },
      });
      expect(missing.isError).toBe(true);
      expect(record(record(missing.structuredContent).error).code).toBe("NOT_FOUND");
    } finally {
      await client.close();
    }
  });

  it("renames, disables, enables and replaces the credential without changing the URL", async () => {
    const renamed = await send(
      `/api/connections/${connection.id}`,
      "PATCH",
      { revision: connection.revision, name: "Renamed connection" },
      session,
    );
    expect(renamed.response.status).toBe(200);
    expect(record(renamed.data.connection).name).toBe("Renamed connection");
    connection.revision = Number(record(renamed.data.connection).revision);

    const disabled = await send(
      `/api/connections/${connection.id}/disable`,
      "POST",
      { revision: connection.revision },
      session,
    );
    expect(disabled.response.status).toBe(200);
    expect(record(disabled.data.connection).disabled).toBe(true);
    connection.revision = Number(record(disabled.data.connection).revision);

    const blocked = await exports.default.fetch(
      new Request(connection.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: "{}",
      }),
    );
    expect(blocked.status).toBe(404);

    const enabled = await send(
      `/api/connections/${connection.id}/enable`,
      "POST",
      { revision: connection.revision },
      session,
    );
    expect(enabled.response.status).toBe(200);
    expect(record(enabled.data.connection).disabled).toBe(false);
    connection.revision = Number(record(enabled.data.connection).revision);

    const client = await connect(connection.url);
    try {
      expect((await discover(client)).operations.length).toBe(5);
    } finally {
      await client.close();
    }

    const replaced = await send(
      `/api/connections/${connection.id}`,
      "PATCH",
      { revision: connection.revision, credential: "demo_replacement" },
      session,
    );
    expect(replaced.response.status).toBe(200);
    expect(fromUrl(connection.url).token).toBe(connection.token);
    connection.revision = Number(record(replaced.data.connection).revision);
  });

  it("rotates the URL, invalidating the old token immediately", async () => {
    const oldUrl = connection.url;
    const rotated = await send(
      `/api/connections/${connection.id}/rotate`,
      "POST",
      { revision: connection.revision },
      session,
    );
    expect(rotated.response.status).toBe(200);
    const next = fromUrl(rotated.data.install_url);
    expect(next.token).not.toBe(connection.token);
    expect(Number(record(rotated.data.connection).revision)).toBe(connection.revision + 1);
    connection = {
      id: connection.id,
      revision: Number(record(rotated.data.connection).revision),
      token: next.token,
      url: next.url,
    };

    const old = await exports.default.fetch(
      new Request(oldUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: "{}",
      }),
    );
    expect(old.status).toBe(404);

    const client = await connect(connection.url);
    try {
      const catalogue = await discover(client);
      expect(catalogue.operations.length).toBe(5);
    } finally {
      await client.close();
    }
  });

  it("revokes the connection and rejects the current token", async () => {
    const revoked = await send(
      `/api/connections/${connection.id}`,
      "DELETE",
      { revision: connection.revision },
      session,
    );
    expect(revoked.response.status).toBe(200);
    expect(record(revoked.data.connection).status).toBe("revoked");

    const rejected = await exports.default.fetch(
      new Request(connection.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: "{}",
      }),
    );
    expect(rejected.status).toBe(404);
  });

  it("returns 404 for unroutable or unknown tokens", async () => {
    for (const token of [
      "not-a-token",
      `${"a".repeat(64)}.${"A".repeat(43)}`,
      `${"b".repeat(64)}.${"B".repeat(42)}`,
    ]) {
      const response = await get(`/mcp/${token}`);
      expect(response.response.status).toBe(404);
    }
  });
});
