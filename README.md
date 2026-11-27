# Remote MCP starter for Cloudflare Workers

A complete, self-hosted starting point for exposing your application to AI agents through the Model Context Protocol (MCP). It runs entirely on Cloudflare Workers: a Hono app, a stateless streamable-HTTP MCP endpoint, passkey accounts, and one SQLite-backed Durable Object per account.

The MCP surface is deliberately tiny and generic:

| Tool | Purpose |
| --- | --- |
| `discover` | List the operations this connection may use, with compact summaries or full JSON Schemas. |
| `execute_read` | Run list/get operations with validation and pagination metadata. |
| `execute_write` | Run create/update/delete operations with explicit uncertainty reporting. |

A demo “notes” resource is included so the whole flow works immediately. Replace it with your own operations when you are ready; the account, connection, security and MCP layers stay the same.

---

## Contents

- [What you get](#what-you-get)
- [How it fits together](#how-it-fits-together)
- [Local development](#local-development)
- [Deploy](#deploy)
- [Connect an MCP client](#connect-an-mcp-client)
- [The three tools](#the-three-tools)
- [Access model](#access-model)
- [Security design](#security-design)
- [Replace the demo app](#replace-the-demo-app)
- [Tests and checks](#tests-and-checks)
- [Free-tier notes](#free-tier-notes)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)
- [Further documentation](#further-documentation)

---

## What you get

- **Passkey-only accounts** using `@simplewebauthn/server`. No passwords, no email recovery, no password reset flow to secure.
- **Secure browser sessions** in `HttpOnly; Secure; SameSite=Strict` cookies with a CSRF token required for every mutation.
- **Per-connection MCP URLs** shaped like `https://your-worker.example/mcp/<account>.<secret>`. Only a domain-separated SHA-256 hash of the full token is stored.
- **Encrypted upstream credentials** using AES-GCM with a versioned Worker-secret keyring and additional authenticated data bound to the account and connection.
- **Explicit per-resource access policy** enforced inside the Durable Object on every read and write. New connections start read-only.
- **Connection lifecycle** — rename, replace credential, rotate URL, disable, enable and revoke. Rotation and revocation invalidate the old URL immediately.
- **Versioned discovery** — clients send the catalogue version they discovered; stale clients get a structured `SCHEMA_CHANGED` and must rediscover.
- **Structured errors** with stable codes, partial-page signalling, read-back after writes, and no automatic retry of uncertain writes.
- **Tests** that run in the real Workers runtime, including synthetic WebAuthn registration and login, connection creation, discovery, authorized reads/writes, denied access, rotation and revocation.
- **CI** that lints, typechecks and tests on every push, then deploys `main` with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- **No app-specific assumptions** — the domain layer is replaceable and the security layer is generic.

---

## How it fits together

```text
Browser                      MCP client
   │                              │
   │ passkey + session cookie     │ POST /mcp/<account>.<secret>
   ▼                              ▼
┌────────────────────────────────────────────────────────────┐
│ Cloudflare Worker (Hono)                                   │
│  • static UI and /api account routes                       │
│  • WebAuthn verification and signed ceremony cookies       │
│  • stateless MCP streamable-HTTP handler                   │
└───────────────┬────────────────────────────────────────────┘
                │ RPC by account id
                ▼
┌────────────────────────────────────────────────────────────┐
│ AccountStore Durable Object (SQLite)                       │
│  • account, passkeys, sessions, used challenges            │
│  • connections, encrypted credentials, access policy       │
│  • demo notes                                               │
└────────────────────────────────────────────────────────────┘
                │ (replace the demo)
                ▼
         your application API
```

- The Worker is the only public entry point. The Durable Object has **no public `fetch` handler**; it only exposes typed RPC methods to the Worker.
- Each account gets one Durable Object named after the 64-hex account id. The account id is the first part of every connection URL, so routing needs no global index.
- MCP requests are stateless. The handler validates the token, resolves the connection revision and policy, runs the tool, and returns. There are no MCP sessions to keep in sync with revocation.

---

## Local development

### Prerequisites

- Node.js 24.11 or newer (`.node-version` is included for version managers).
- npm.
- A browser with passkeys (Safari, Chrome, Edge, Firefox with a platform or security-key authenticator). `http://localhost` is treated as a secure context, so local passkeys work without TLS.
- For deployment only: a Cloudflare account and `wrangler login`.

### First run

```bash
npm install
cp .var.dev.example .var.dev
npm run secrets
npm run dev
```

`npm run secrets` fills the missing `CEREMONY_KEY` and `ENCRYPTION_KEYS` values in `.var.dev`. It never prints them and never rotates values that already exist.

Open <http://localhost:8787>, click **Sign up**, create a passkey, then create a connection. The demo accepts a credential such as:

```text
demo_local_development
```

Copy the MCP URL shown once, then use it in a client (see below).

> `wrangler dev` stores local Durable Object data under `.wrangler/`. Local accounts and notes are completely separate from production.

### Useful commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the Worker on `http://localhost:8787`. |
| `npm test` | Run the Vitest suite in the Workers runtime. |
| `npm run typecheck` | Run TypeScript with no emit. |
| `npm run lint` | Check formatting and lint rules with Biome. |
| `npm run lint:fix` | Apply safe formatting and lint fixes. |
| `npm run check` | Lint, typecheck and test in one go. |
| `npm run secrets` | Generate or preserve local development secrets. |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` from `wrangler.jsonc`. |
| `npm run smoke` | Exercise an existing connection with the MCP client. Requires `MCP_URL`. |

### Smoke test against a running local Worker

Create a connection in the browser, copy its URL, then:

```bash
MCP_URL='http://localhost:8787/mcp/<account>.<token>' npm run smoke
```

The script lists tools, discovers operations, reads a page and attempts a write if the connection permits it. It never prints the URL or token.

---

## Deploy

### 1. Choose the hostname first

WebAuthn binds passkeys to an exact hostname. Decide now whether you will use the default `workers.dev` hostname or a custom domain.

Edit `wrangler.jsonc`:

```jsonc
{
  "name": "your-mcp-starter",
  "vars": {
    "APP_NAME": "Your app",
    "ENVIRONMENT": "production",
    "ENCRYPTION_KEY_VERSION": "v1",
    "WEBAUTHN_RP_ID": "your-mcp-starter.your-subdomain.workers.dev",
    "WEBAUTHN_ORIGIN": "https://your-mcp-starter.your-subdomain.workers.dev"
  }
}
```

Rules:

- `WEBAUTHN_RP_ID` is a bare hostname: no scheme, port or path.
- `WEBAUTHN_ORIGIN` is the exact browser origin, including `https://` and any non-default port.
- They must refer to the same host. `localhost` is the only host allowed over plain `http`.
- If you later move to a custom domain, change both values and expect existing passkeys to stop working for the old hostname. Plan the move before inviting users.

### 2. Create the two production secrets

The Worker needs independent signing and encryption keys:

```bash
# Generate local values if you have not already.
npm run secrets

# Read the two values from .var.dev (do not paste secrets into shell history on a shared machine).
npx wrangler secret put CEREMONY_KEY
npx wrangler secret put ENCRYPTION_KEYS
```

`ENCRYPTION_KEYS` is a JSON object mapping key versions to 32-byte base64url keys, for example:

```json
{ "v1": "<43-character-base64url-key>" }
```

`ENCRYPTION_KEY_VERSION` must name the active entry. To rotate later, add a new version, switch the active version, keep the old key for decryption, and re-save each connection credential when convenient. See `docs/OPERATIONS.md`.

### 3. Deploy

```bash
npm run deploy
```

The first deploy creates the `AccountStore` Durable Object migration. Open the deployed origin, create an account and create a connection. The URL shown at creation is the only time the full token is available.

### 4. Test the deployment

```bash
MCP_URL='https://your-host/mcp/<account>.<token>' npm run smoke
```

---

## Connect an MCP client

The connection URL is a bearer credential. Treat it like a password.

General steps:

1. In your MCP client, add a **custom remote MCP server** / **connector**.
2. Paste the full `https://…/mcp/<account>.<token>` URL.
3. Choose **No authentication** (the URL itself authorizes the connection).
4. Save and ask the agent to **discover** operations.

See `docs/CLIENTS.md` for client-specific notes and troubleshooting.

> If a client only accepts an origin without a path, or insists on OAuth discovery, it cannot use this bearer-URL pattern. Use a client that supports custom remote MCP servers with headers/paths, or put an authenticating proxy in front.

---

## The three tools

### `discover`

Inputs:

```json
{ "operation_id": "notes:list", "detail": true, "limit": 50, "cursor": "<next_cursor>" }
```

- Default output is compact: operation id, resource, kind, summary and description.
- Results are paginated: `limit` defaults to 50 and is capped at 100. Pass `next_cursor` back unchanged while `has_more` is true.
- `operation_id` returns one full contract and ignores `limit`/`cursor`.
- `detail: true` returns JSON Schemas and examples for the returned page.
- The response includes `catalog_version`, `total_operations`, `has_more` and `next_cursor`. Send `catalog_version` back with every execution.
- An invalid or foreign cursor returns `INVALID_CURSOR`.

### `execute_read`

```json
{
  "operation_id": "notes:list",
  "catalog_version": "<hash from discover>",
  "arguments": { "limit": 10, "status": "open" }
}
```

- Only list/get operations are accepted.
- Arguments are validated with Zod **on the server** before execution.
- Paginated results include `has_more` and an opaque `next_cursor`. A partial page is never presented as complete.
- A stale `catalog_version` returns `SCHEMA_CHANGED` with `mutation_sent: false`.

### `execute_write`

```json
{
  "operation_id": "notes:create",
  "catalog_version": "<hash from discover>",
  "arguments": { "title": "Call the supplier" }
}
```

- Only create/update/delete operations are accepted.
- Access is checked again inside the Durable Object.
- Successful writes are read back before being reported.
- An unexpected failure returns `WRITE_UNCERTAIN`, `mutation_sent: "unknown"`, `write_outcome: "uncertain"`, `requires_readback: true` and `automatic_retry: false`.
- The agent should read current state before retrying an uncertain write. The server never retries by itself.
- Updates preserve unspecified fields. The demo also supports `expected_updated_at` for optimistic concurrency and returns `CONFLICT` with the current record.

### Error codes

| Code | Meaning |
| --- | --- |
| `VALIDATION_FAILED` | Arguments do not match the operation schema. `issues` lists paths. |
| `UNKNOWN_OPERATION` | No such operation id. |
| `ACCESS_DENIED` | The operation exists but is outside this connection’s policy. |
| `WRONG_EXECUTOR` | Reads must use `execute_read`; writes must use `execute_write`. |
| `SCHEMA_CHANGED` | The catalogue or connection revision changed. Rediscover. |
| `INVALID_CURSOR` | Use a cursor returned by the same catalogue or list. |
| `NOT_FOUND` | The record does not exist or is not visible. |
| `CONFLICT` | Optimistic concurrency check failed; `current` contains the latest record. |
| `WRITE_UNCERTAIN` | The write may have been applied. Read before retrying. |
| `AUTH_FAILED` | Passkey/session verification failed. |
| `CSRF` | A mutation is missing a valid CSRF token. |
| `RATE_LIMITED` | Wait and retry the HTTP request later. |
| `SERVICE_UNAVAILABLE` | A generic infrastructure failure with no safe detail. |

---

## Access model

Each connection stores a policy document:

```json
{
  "version": 1,
  "resources": {
    "notes": { "read": true, "create": false, "update": false, "delete": false }
  }
}
```

- `read` gates `list` and `get`.
- `create`, `update` and `delete` also require `read`, because every write is read back.
- A connection with no policy starts read-only for every resource.
- Operations outside the policy are omitted from `discover` and rejected with `ACCESS_DENIED` even if a client guesses the operation id.
- Saving a policy increments the connection revision. The next MCP request re-resolves the revision; clients do not need to reconnect, but they must rediscover to see the new operation set.

The UI exposes this as **Control access** per connection.

---

## Security design

- **Passkeys only.** Registration, login and add-passkey ceremonies are verified with `@simplewebauthn/server`, requiring user presence and user verification. Supported algorithms are ES256 and RS256.
- **Signed ceremony state.** Ceremony data lives in a `__Host-` cookie signed with HMAC-SHA-256; it is bound to the purpose, origin, RP ID and, for add-passkey, the account and session hash.
- **Sessions.** Session tokens are 256-bit random values. Only their SHA-256 hash is stored. Cookies are `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/` and host-only.
- **CSRF.** Mutations require `X-CSRF-Token`, derived from the session token. The check is timing-safe.
- **Origin checks.** Browser API routes require the exact configured `Origin` and reject cross-site requests. JSON bodies are required for mutations.
- **Replay protection and counters.** Used WebAuthn challenges are recorded; authentication counters must advance. Session and challenge tables are pruned.
- **Rate limits.** A per-address limiter protects authentication and a per-account limiter protects connection creation. Limits are approximate and per Cloudflare location.
- **Connection tokens.** Each token contains the account id plus 256 random bits. Only a domain-separated SHA-256 hash is stored. URLs are returned only at creation or rotation; the UI clears them on page hide.
- **Encryption at rest.** Upstream credentials are encrypted with AES-256-GCM. Additional authenticated data binds the ciphertext to the format version, account id, connection id and key version, so copying an envelope to another connection fails.
- **No secret logging.** The Worker logs neither tokens, URLs, arguments nor credentials. Observability has `invocation_logs` and `redact_query_string` configured, and `upload_source_maps` only affects source maps.
- **Small public surface.** No public Durable Object fetch handler, no wildcard CORS, no `/debug` endpoint, no query-string secrets.
- **Revocation is immediate.** Every MCP request resolves the current token hash, status, disabled flag and revision before running a tool.
- **Writes do not retry.** Ambiguous outcomes are reported explicitly so an agent can read before acting.

See `docs/SECURITY.md` for the threat model and operational guidance.

---

## Replace the demo app

The app-specific code is isolated in four files:

| File | Responsibility |
| --- | --- |
| `src/app/types.ts` | `AppSource`, access policy and operation types. |
| `src/app/catalogue.ts` | Resource and operation definitions, Zod validators, JSON Schemas, examples and the catalogue hash. |
| `src/app/demo.ts` | Demo implementation against the account SQLite database. |
| `src/index.ts` | The `AppSource` factory that wires the MCP tools to the demo. |

### Steps

1. Edit `src/app/catalogue.ts`:
   - Change `RESOURCES`.
   - Replace `OPERATIONS` with your operations. Give each a stable id, resource, kind, summary, description, Zod input schema, JSON Schema and examples.
2. Replace `src/app/demo.ts` with your implementation, or delete it and call your upstream API from `src/index.ts`.
3. Keep the `AppSource` contract:
   ```ts
   type AppSource = {
     catalogue(): Promise<Catalogue>;
     read(operationId: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
     write(operationId: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
   };
   ```
4. Throw `AppError` for safe, structured failures. Set `mutationSent` when you know whether an upstream mutation was sent.
5. Optionally replace `validateDemoCredential` with a real upstream credential check.
6. Remove the `demo_notes` table from `src/accounts/schema.sql` and the seed call in `src/accounts/object.ts` once your data no longer lives in the Durable Object.
7. Update `public/index.html`, `public/how-it-works.html` and `src/mcp/server.ts` instructions to describe your app.

`docs/REPLACING_THE_DEMO.md` walks through a complete example with an upstream REST API.

### Design guidance for operations

- Prefer explicit operations over a generic query language. They are easier to validate, audit and scope.
- Give list operations a bounded page size and an opaque cursor.
- Include a `get` operation so agents can read before writing.
- For updates, accept partial changes and preserve unspecified fields.
- Offer optimistic concurrency (`expected_updated_at` or an etag) where stale writes matter.
- Never expose raw SQL, arbitrary URLs, shell commands or unrestricted HTTP as operations.
- Keep descriptions short but state when to use the operation, what it returns and how pagination behaves.

---

## Tests and checks

```bash
npm run check
```

What is covered:

- `tests/security.test.ts` — credential encryption AAD/keyring boundaries, token routing and hash separation, ceremony signing/expiry/tampering, origin validation, access-policy normalization and catalogue visibility.
- `tests/account-flow.test.ts` — a real synthetic WebAuthn registration and login, session cookies and CSRF, connection creation with a credential, MCP tool listing, discovery, authorized read, denied write on a read-only connection, policy update, read-back write, rotation, revocation, and invalid tokens.

The tests run inside the Workers runtime via `@cloudflare/vitest-plugin`, with fresh keys generated by `vitest.config.ts`. They do not need Cloudflare credentials or network access.

---

## Free-tier notes

Workers Free (checked November 2026):

| Resource | Free allowance |
| --- | --- |
| Worker requests | 100,000 per day (all Workers on the account) |
| Worker CPU time | 10 ms per invocation |
| Durable Objects | SQLite-backed only |
| Durable Object requests | 100,000 per day |
| Durable Object duration | 13,000 GB-s per day |
| SQL rows read | 5 million per day |
| SQL rows written | 100,000 per day |
| Durable Object storage | 5 GB total |
| Static asset requests | Free and unlimited |

Practical implications:

- This starter is a good fit for a personal or small-team deployment, but **10 ms of CPU per request is tight for WebAuthn verification**. If passkey registration or login intermittently fails with “Worker exceeded resource limits” (error 1102), move to the Workers Paid plan, which raises the CPU limit and includes 10 million requests and 30 million CPU-ms per month.
- Every MCP tool call is a Worker request plus one or more Durable Object RPC requests. Each read/write also counts SQL rows. A chatty agent can exhaust the daily row-write allowance with rapid writes.
- Rate limiting counters are approximate and per location. They are abuse protection, not a strict global quota.
- Durable Objects are per-account and single-threaded; this design is intentionally simple and scales by adding accounts, not by sharding one account.

See `docs/FREE_TIER.md` for the full breakdown and cost-control suggestions. Always confirm current limits on Cloudflare’s pricing pages before relying on them.

---

## Project layout

```text
.
├── src/
│   ├── index.ts                     Worker entry, Hono routes, MCP mount
│   ├── app/
│   │   ├── types.ts                 AppSource and policy types
│   │   ├── catalogue.ts             Operation definitions and JSON Schemas
│   │   ├── demo.ts                  Demo notes implementation
│   │   └── errors.ts                Structured application errors
│   ├── accounts/
│   │   ├── object.ts                AccountStore Durable Object
│   │   ├── schema.sql               Account and demo SQLite schema
│   │   ├── routes.ts                WebAuthn and session routes
│   │   ├── connection-routes.ts     Connection and access management
│   │   ├── config.ts                WebAuthn/origin/rate-limit validation
│   │   ├── ceremony.ts              Signed ceremony cookies
│   │   ├── session.ts               Session cookie helpers
│   │   ├── crypto.ts                Token routing and AES-GCM envelopes
│   │   ├── keyring.ts               Versioned keyring parsing
│   │   ├── access.ts                Access policy schemas
│   │   ├── connections.ts           Connection schemas and cursors
│   │   └── model.ts                 Account models and limits
│   └── mcp/
│       └── server.ts                Three-tool MCP server
├── public/                          Self-contained UI (no build step)
├── tests/                           Workers-runtime tests
├── scripts/                         Secrets generator and smoke test
├── docs/                            Setup, security, operations, clients
├── .github/workflows/main.yml       CI and deploy
├── wrangler.jsonc
└── vitest.config.ts
```

---

## Troubleshooting

### Passkeys do not appear

- Check `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` match the exact address in your browser.
- `http://` is only allowed for `localhost`. Everything else needs `https://`.
- If you changed hostnames, old passkeys are bound to the old hostname. Create a new account or add a passkey while still on the old hostname.
- Some browsers require a platform authenticator or a security key. Try a different browser before changing code.

### “Worker exceeded resource limits” / error 1102

WebAuthn verification or encryption may exceed the Free plan’s 10 ms CPU allowance. Move to Workers Paid, or test again with a smaller payload. The error code is visible in Workers metrics.

### “Too many passkey requests”

The per-address authentication limiter fired. Wait about a minute. The limiter is per Cloudflare location. If you are testing, use a fresh browser profile or wait.

### A connection URL returns 404

The token is unknown, revoked, rotated or disabled. A 404 is intentional: it does not reveal whether the account exists. Create or rotate a connection to get a working URL.

### The URL was lost after creating a connection

By design it is shown once. Rotate the connection to get a new URL; all previously issued URLs for that connection stop working.

### `wrangler secret put` complains about missing configuration

Run `npx wrangler deploy --dry-run` first to validate `wrangler.jsonc`. Secrets must be set per environment; if you add a Wrangler environment later, set them there too.

### MCP client reports “unsupported protocol version”

Update the client. This server speaks the current MCP revision and supports the 2025-era stateless fallback. A very old client that requires sessionful transport may not work.

### Local data vanished

`wrangler dev` may clear `.wrangler/state` depending on flags and version. Local data is disposable. Never treat it as production data.

---

## Further documentation

- [`docs/SETUP.md`](docs/SETUP.md) — deployment, secrets, custom domains, CI and first-run checklist.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — request flow, Durable Object methods, storage schema and lifecycle.
- [`docs/SECURITY.md`](docs/SECURITY.md) — threat model, token and key handling, revocation, incident response.
- [`docs/REPLACING_THE_DEMO.md`](docs/REPLACING_THE_DEMO.md) — adapt the starter to a real upstream API.
- [`docs/CLIENTS.md`](docs/CLIENTS.md) — client setup patterns and compatibility notes.
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — key rotation, connection rotation, backup and recovery.
- [`docs/FREE_TIER.md`](docs/FREE_TIER.md) — limits and cost control.

Use this starter as a starting point, not a finished product. Review the access scopes, operation set, logging and upstream credential handling for your own threat model before exposing it to users.

---

## License

MIT. Use it for any project, commercial or otherwise. See [LICENSE](LICENSE).
