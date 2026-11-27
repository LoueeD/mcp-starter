# Replacing the demo app

The notes resource exists so the starter is runnable. This guide replaces it with a real upstream API without touching the account, connection or MCP machinery.

## The seam

Everything app-specific is behind `AppSource`:

```ts
export type AppSource = {
  catalogue(): Promise<Catalogue>;
  read(operationId: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  write(operationId: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
};
```

`src/index.ts` currently builds it like this:

```ts
const source: AppSource = {
  catalogue: () => publicCatalogue(resolved.policy),
  read: async (operationId, args) => {
    await check();
    const response = await object.appRead(token, resolved.revision, operationId, args);
    if (!response.ok) throw new AppError(/* ... */);
    return response.value;
  },
  write: async (operationId, args) => {
    await check();
    const response = await object.appWrite(token, resolved.revision, operationId, args);
    if (!response.ok) throw new AppError(/* ... */);
    return response.value;
  },
};
```

You can keep the demo dispatch inside the Durable Object and replace only `demoRead`/`demoWrite`, or move the upstream calls into the Worker. The first option keeps the credential inside the object and avoids passing it around. The second option is simpler if your upstream client only runs in the Worker.

## Step 1: describe your operations

Edit `src/app/catalogue.ts`. Each operation needs:

- `id` — stable, namespaced, for example `invoices:list`.
- `resource` — used by access policy, for example `invoices`.
- `kind` — `list`, `get`, `create`, `update` or `delete`.
- `summary` — one line for compact discovery.
- `description` — when to use it, what it returns, pagination and write semantics.
- `input` — a strict Zod schema.
- `inputSchema` — JSON Schema advertised to clients.
- `examples` — one or two realistic argument objects.

Keep the JSON Schema and Zod schema in sync. A useful pattern is to write the Zod schema first and hand-write the JSON Schema beside it, then add a test that rejects a known-invalid argument.

### Example: invoices

```ts
const invoiceId = z.string().regex(/^inv_[A-Za-z0-9]{12}$/);
const invoiceStatus = z.enum(["draft", "sent", "paid", "void"]);

export const RESOURCES: ResourceDefinition[] = [
  {
    name: "invoices",
    label: "Invoices",
    description: "Customer invoices with line items and payment status.",
  },
];

export const OPERATIONS: OperationDefinition[] = [
  {
    id: "invoices:list",
    resource: "invoices",
    kind: "list",
    summary: "List invoices",
    description:
      "Return invoices newest first. Filter by status. Pass next_cursor back unchanged. has_more tells you whether another page exists.",
    input: z
      .object({
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().max(512).optional(),
        status: invoiceStatus.optional(),
      })
      .strict(),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        cursor: { type: "string", maxLength: 512 },
        status: { type: "string", enum: ["draft", "sent", "paid", "void"] },
      },
    },
    examples: [{ arguments: { status: "sent", limit: 10 } }],
  },
  // invoices:get, invoices:create, invoices:update, invoices:delete
];
```

## Step 2: implement the upstream calls

Create `src/app/invoices.ts` (or replace `demo.ts`). The adapter receives validated arguments and the decrypted credential.

```ts
import { AppError } from "./errors";

type Context = { credential: string; fetch: typeof fetch };

export async function invoiceRead(
  context: Context,
  operationId: string,
  args: Record<string, unknown>,
) {
  if (operationId === "invoices:list") {
    const url = new URL("https://api.example.com/v1/invoices");
    url.searchParams.set("limit", String(args.limit ?? 20));
    if (typeof args.status === "string") url.searchParams.set("status", args.status);
    if (typeof args.cursor === "string") url.searchParams.set("cursor", args.cursor);

    const response = await context.fetch(url, {
      headers: { Authorization: `Bearer ${context.credential}` },
    });
    if (!response.ok) throw upstreamError(response.status);
    const body = (await response.json()) as {
      data: unknown[];
      has_more: boolean;
      next_cursor: string | null;
    };
    return {
      invoices: body.data,
      has_more: body.has_more,
      next_cursor: body.next_cursor,
      result_scope: "One page ordered newest first.",
    };
  }
  throw new AppError("WRONG_EXECUTOR", "This operation is not a read.");
}

function upstreamError(status: number) {
  if (status === 401 || status === 403)
    return new AppError("UPSTREAM_AUTH", "The app credential was rejected.");
  if (status === 404) return new AppError("NOT_FOUND", "No matching record exists.");
  if (status === 409) return new AppError("CONFLICT", "The record changed. Read it again.");
  if (status === 429)
    return new AppError("RATE_LIMITED", "The app is rate limiting requests. Try again shortly.");
  return new AppError("UPSTREAM_ERROR", "The app could not complete the request.");
}
```

Do not include the upstream response body in the error. It may contain secrets, internal identifiers or data outside the connection’s access scope.

### Where the credential comes from

`AccountStore.resolveExecution` decrypts the credential and returns it. If you keep upstream calls in the Durable Object, extend `appRead`/`appWrite` to receive it. If you move calls to the Worker, pass the decrypted value only inside the request closure. Never put it in a tool result, log, URL or Durable Object response that the browser can read.

## Step 3: validate the credential at connection creation

Replace `validateDemoCredential`:

```ts
export async function validateCredential(credential: string) {
  const response = await fetch("https://api.example.com/v1/me", {
    headers: { Authorization: `Bearer ${credential}` },
  });
  if (!response.ok)
    throw new AppError(
      "INVALID_CREDENTIAL",
      "The app credential was rejected. Check the key and its permissions.",
    );
}
```

Call it from `src/accounts/connection-routes.ts` before `createConnection` and before `changeConnection` when a credential is supplied. Keep the check bounded with an `AbortSignal.timeout(5000)` so a slow upstream does not hold the request open.

### Credential scopes

Ask users for the narrowest upstream credential possible. If your upstream supports per-resource scopes, the MCP access policy and the upstream scope should both be set. The MCP policy limits what this server asks for; the upstream scope limits what the credential can do if the server is compromised.

## Step 4: remove the demo storage

1. Delete the `demo_notes` table and index from `src/accounts/schema.sql`.
2. Remove `seedDemoNotes` from `register` in `src/accounts/object.ts`.
3. Delete `src/app/demo.ts` and its imports.
4. Update `RESOURCES` and `OPERATIONS`.
5. Bump the schema version if you have existing deployments:
   - `schema_version.version` is currently `1`.
   - Change it to `2` and add a migration path in `#account()`. The starter is new, so most users can reset local data and redeploy a fresh production namespace.

## Step 5: preserve the write contract

Your write adapter must return enough information for an agent to know what happened:

```ts
return {
  invoice: updated,
  updated: true,
  mutation_sent: true,
  automatic_retry: false,
  read_back: true,
};
```

Rules:

- Set `mutation_sent: true` only after the upstream confirms the mutation.
- For an unknown outcome, throw with `mutationSent: "unknown"` so the MCP layer returns `WRITE_UNCERTAIN`.
- For a failure before sending, set `mutationSent: false`.
- Read the record back after a successful write when the upstream returns only an id or a partial body.
- Preserve fields the caller did not ask to change. Do not send a full replacement body unless the operation is explicitly a “replace”.
- Return the current record in a conflict response so the agent can reconcile.

### Idempotency

If the upstream supports `Idempotency-Key`, derive a stable key from the tool call and store it with the mutation. Without upstream support, do not retry automatically; report uncertainty and let the agent read first.

### Optimistic concurrency

The demo uses `expected_updated_at`. For an etag-based API:

```ts
input: z.object({
  id: invoiceId,
  changes: z.object({ /* ... */ }).strict(),
  expected_etag: z.string().max(200).optional(),
}).strict()
```

Send `If-Match: expected_etag` upstream and map `412` to `CONFLICT`.

## Step 6: pagination

- Use a bounded page size.
- Return an opaque cursor that the client passes back unchanged.
- Include `has_more` and `next_cursor: null` when the page is complete.
- Do not encode authorization decisions in a cursor unless it is signed or opaque and validated.
- If the upstream uses offset pagination, wrap it in an opaque cursor so you can change the implementation later.

## Step 7: discovery quality

The agent only knows what discovery tells it. Good descriptions:

- say when to use the operation;
- state whether it changes data;
- explain required fields and formats;
- explain pagination;
- mention read-before-write and conflict behaviour;
- include realistic examples.

Keep compact discovery small. Put long explanations in `description`, not in the operation id.

## Step 8: test the adapter

Add tests that cover:

- a successful read with pagination;
- an upstream 401/403 mapped to `UPSTREAM_AUTH`;
- a successful write with read-back;
- a conflict with the current record;
- an uncertain write (`mutationSent: "unknown"`);
- a denied operation at the access-policy layer;
- a stale catalogue version.

You can test the adapter directly with a mocked `fetch`, then keep the end-to-end test in `tests/account-flow.test.ts` for the notes resource or replace it with your resource.

## Checklist

- [ ] `RESOURCES` and `OPERATIONS` describe only real, safe operations.
- [ ] Every operation has a strict Zod schema and a matching JSON Schema.
- [ ] Every list operation is bounded and paginated.
- [ ] Every write operation preserves unspecified fields and reads back.
- [ ] Upstream errors are mapped to safe `AppError` codes.
- [ ] Credentials are validated before storage and never returned to the browser.
- [ ] The demo table and seed call are removed.
- [ ] `src/mcp/server.ts` instructions mention your domain, not notes.
- [ ] `public/index.html` and `public/how-it-works.html` describe your app.
- [ ] Tests cover success, denial, conflict and uncertainty.
