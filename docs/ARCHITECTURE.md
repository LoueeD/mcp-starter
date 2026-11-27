# Architecture

This document explains how a request moves through the system and where to change behaviour safely.

## Components

| Component | Location | Responsibility |
| --- | --- | --- |
| Worker entry | `src/index.ts` | Hono app, static UI, `/api` routes, `/mcp/:token`, health. |
| MCP server factory | `src/mcp/server.ts` | Registers `discover`, `execute_read`, `execute_write` and maps `AppSource` results to MCP tool results. |
| Catalogue | `src/app/catalogue.ts` | Generic operation definitions, Zod validators, JSON Schemas, access filtering and catalogue hash. |
| Demo adapter | `src/app/demo.ts` | Notes implementation. Replace this. |
| Account routes | `src/accounts/routes.ts` | Passkey registration/login, passkey management, session summary, sign-out. |
| Connection routes | `src/accounts/connection-routes.ts` | Connection CRUD, credential replacement, rotation, revocation, access policy. |
| AccountStore | `src/accounts/object.ts` | All account state and the only place access policy is enforced for MCP operations. |
| Schema | `src/accounts/schema.sql` | SQLite tables and constraints. |
| Crypto | `src/accounts/crypto.ts` | Token routing, hashing and AES-GCM credential envelopes. |
| Ceremony | `src/accounts/ceremony.ts` | HMAC-signed ceremony cookie contents. |
| Config | `src/accounts/config.ts` | WebAuthn context, origin checks, rate limiting, key configuration. |

## Identifiers

- **Account id**: 32 random bytes, hex encoded, 64 characters.
- **Connection token**: `<64-hex-account-id>.<43-char-base64url-random>`.
- **Connection id**: a UUID.
- **Durable Object name**: the account id.
- **MCP URL**: `https://<origin>/mcp/<connection-token>`.

The account prefix makes routing O(1): the Worker decodes the first 64 characters and calls `env.ACCOUNTS.getByName(accountId)`. The Durable Object finds the connection by a domain-separated SHA-256 hash of the full token. The plaintext token is never stored.

## Browser request flow

### Registration

1. `POST /api/auth/register/options`
   - Validates origin, rate-limits by client address.
   - Generates a WebAuthn creation challenge.
   - Signs a ceremony cookie containing the challenge, account id, label, origin, RP ID and expiry.
2. The browser creates a credential with `navigator.credentials.create`.
3. `POST /api/auth/register/verify`
   - Verifies the ceremony cookie and clears it.
   - Verifies the attestation with `@simplewebauthn/server`.
   - Creates the account, first passkey, first session, a used-challenge record and demo data in one SQLite transaction.
   - Sets the host-only session cookie and returns a CSRF token.

An account id is generated before the browser ceremony. If verification fails, the id is simply discarded.

### Login

1. `POST /api/auth/login/options` signs a login ceremony and returns a discoverable-credential challenge.
2. The browser asserts with `navigator.credentials.get`.
3. `POST /api/auth/login/verify` reads the account id from the WebAuthn `userHandle`, loads that passkey, verifies the assertion, checks the counter, records the used challenge and inserts a new session.

The lookup is by account id embedded in the signed user handle. The server never trusts a client-supplied account id for authentication.

### Session checks

`GET /api/auth/session` hashes the session token and looks it up in SQLite, pruning expired sessions. Invalid sessions are cleared with an expired cookie.

### Mutations

Every non-GET account/connection route requires:

- a valid session cookie;
- an exact `Origin` match (and no cross-site `Sec-Fetch-Site`);
- `Content-Type: application/json`;
- `X-CSRF-Token` equal to `SHA-256("mcp-starter:csrf:" + sessionToken)`.

The CSRF comparison is timing-safe.

## Connection creation flow

1. The Worker validates the session, origin, CSRF token and request body.
2. It applies a per-account provisioning rate limit.
3. It validates the app credential with the app adapter (`validateDemoCredential` in the starter).
4. It generates a UUID connection id and a routed token.
5. It encrypts the credential with AES-GCM, using AAD that includes the account id, connection id and key version.
6. It stores the connection row, the token hash and the default read-only access policy in one transaction.
7. It returns the connection summary and the full install URL. **This is the only time the URL is available.**

## MCP request flow

```text
POST /mcp/<token>
  │
  ├─ parse account id from token
  ├─ AccountStore.resolveExecution(token)
  │    ├─ hash token, find active connection
  │    ├─ reject disabled or revoked
  │    ├─ decrypt credential
  │    └─ return connection id, revision, access policy
  │
  ├─ build AppSource bound to token + revision
  │    ├─ catalogue() = visible operations for policy
  │    ├─ read()     = authorize revision, then AccountStore.appRead
  │    └─ write()    = authorize revision, then AccountStore.appWrite
  │
  └─ createMcpHandler(() => createMcpServer(source))
```

The MCP handler is constructed per HTTP request. No MCP session state survives the request, so a revoked or rotated token cannot continue an old conversation.

### Why the source re-checks authorization

`resolveExecution` runs at the start of each HTTP request. Within that request, the MCP handler may construct a server and call a tool later. `AppSource.read` and `AppSource.write` call `authorizeExecution(token, revision)` immediately before the Durable Object operation. This closes the window where a token is revoked between resolution and execution, and it verifies that the connection revision has not changed.

### Revision checks

Every connection row has a `revision`, incremented by rename, credential replacement, rotation, disable/enable, revocation and access-policy changes.

- The MCP URL handler captures the revision when resolving the request.
- `authorizeExecution` rejects a different revision with `CONNECTION_CHANGED`.
- The `/mcp` route maps that to `SCHEMA_CHANGED`, telling the agent to rediscover.

Clients do not need to reconnect after a policy change. Their next HTTP request resolves the new revision, discovers the new operation set and continues. Their next *tool call* must use the new catalogue version if the operation set changed. (The catalogue hash only changes when the operation definitions change, not on every policy save.)

## Catalogue version

`catalogueVersion()` canonicalises every operation definition **without** its runtime Zod validator, hashes it with SHA-256, and returns 64 hex characters. Discovery and execution both compute it.

- If a client sends a version that does not match, execution fails with `SCHEMA_CHANGED` before touching data.
- The version is global to the starter’s operation set, not per connection. Access changes alter which operations are visible, not the hash of the definitions.
- If you change a description, schema or example, the hash changes. Agents must rediscover.

## The three tools

### `discover`

- `source.catalogue()` returns `publicCatalogue(policy)`, which filters operations with `operationAllowed`.
- Compact mode omits input schemas and examples to keep tool responses small.
- Results are paginated with an opaque `next_cursor`; the default page is 50 operations and the maximum is 100. The cursor encodes an offset into the stable operation array and is validated against the current total, so a cursor from a different catalogue is rejected.
- `operation_id` returns one operation with its schema and ignores pagination.
- `detail: true` returns schemas and examples for the returned page.
- Every response includes `total_operations`, `has_more` and `next_cursor` so a caller never mistakes a partial page for the full surface.

### `execute_read` / `execute_write`

1. Compare `catalog_version` to the current catalogue.
2. Find the operation in the visible set.
3. Distinguish `UNKNOWN_OPERATION` from `ACCESS_DENIED`.
4. Enforce the right executor (`WRONG_EXECUTOR`).
5. Validate arguments with the operation’s Zod schema.
6. Call `AppSource.read`/`write`.
7. Map `AppError` to a structured tool result.

The Durable Object repeats the operation lookup, access check, executor check and validation in `appRead`/`appWrite`. This is deliberate defence in depth: the MCP layer is not the only enforcement point, and the Durable Object methods are private RPC, not public HTTP.

## Durable Object RPC surface

| Method | Used by | Purpose |
| --- | --- | --- |
| `getAccount` | registration/login | Confirm an account and id. |
| `getPasskey` | login | Load a credential for WebAuthn verification. |
| `register` | registration verify | Create account, passkey, session, challenge and demo data. |
| `commitAuthentication` | login verify | Atomically advance the counter and create a session. |
| `sessionSummary` | session route | Return account, expiry and passkey count. |
| `listPasskeys` | passkey UI | List credential labels and metadata. |
| `addPasskey` | add-passkey verify | Add a credential and consume the challenge. |
| `removePasskey` | passkey UI | Remove a credential and invalidate sessions. |
| `signOut` | sign-out | Delete one session. |
| `listConnections` | connection UI | Cursor pagination over connections. |
| `createConnection` | connection create | Encrypt credential, store token hash and default policy. |
| `getConnection` | connection UI | Current connection summary. |
| `ownerAccess` | access UI | Connection summary plus policy. |
| `saveAccessPolicy` | access UI | Validate, normalise and store the policy; bump revision. |
| `changeConnection` | connection UI | Rename, replace credential, rotate, revoke, disable, enable. |
| `resolveExecution` | MCP route | Resolve token to credential, revision and policy. |
| `authorizeExecution` | MCP execution | Re-check token, status and revision. |
| `appRead` | MCP read | Access check, validation, demo read. |
| `appWrite` | MCP write | Access check, validation, demo write. |

All methods return an `ok` flag with either a `value` or an `error: { code, message, status }`. A single object shape (rather than a discriminated union) is used because Cloudflare’s RPC type mapping adds `& Disposable` to returned objects and handles unions poorly. The Worker unwraps them and maps them to HTTP or tool errors. This keeps exceptions from crossing the RPC boundary with unexpected shapes.

## Storage schema

- `account` — one row per Durable Object, slot 1.
- `passkeys` — credential id, public key (BLOB), counter, transports, device type, backup state, label, timestamps.
- `sessions` — token hash, creation and expiry.
- `used_challenges` — challenge hash and expiry, for replay protection.
- `connections` — id, name, status, disabled flag, encrypted credential, token hash, revision, timestamps.
- `connection_policy` — one JSON policy document per connection.
- `demo_notes` — replaceable demo data.
- `schema_version` — one row, version 1.

Constraints enforce lengths, hex formats, status transitions and the relationship between status, credential and token hash. For example, a revoked connection must have no credential and no token hash.

## Limits

Constants in `src/accounts/model.ts`:

| Constant | Value |
| --- | --- |
| `SESSION_MILLISECONDS` | 30 minutes |
| `MAX_SESSIONS` | 20 per account |
| `MAX_ACTIVE_CONNECTIONS` | 20 |
| `MAX_REVOKED_CONNECTIONS` | 100 retained |
| `MAX_USED_CHALLENGES` | 256 |
| `MAX_PASSKEYS` | 20 |

Rate limits in `wrangler.jsonc`:

- authentication: 20 per 60 seconds per address per location;
- connection creation: 10 per 60 seconds per account per location.

Change these deliberately. Lower limits improve abuse resistance; higher limits make testing easier but widen the window.

## Failure behaviour

| Situation | Behaviour |
| --- | --- |
| Unknown token | 404, no detail. |
| Disabled or revoked connection | 404, no detail. |
| Changed revision | `SCHEMA_CHANGED`, `mutation_sent: false`. |
| Unknown operation | `UNKNOWN_OPERATION`. |
| Operation hidden by policy | `ACCESS_DENIED`. |
| Wrong tool for operation | `WRONG_EXECUTOR`. |
| Invalid arguments | `VALIDATION_FAILED` with issue paths. |
| Write failed before sending to upstream | `AppError` with `mutation_sent: false` if the adapter sets it. |
| Write outcome unknown | `WRITE_UNCERTAIN`, `mutation_sent: "unknown"`, `requires_readback: true`. |
| Durable Object unavailable | 503 with a generic message. |

## Design trade-offs

- **One Durable Object per account** keeps routing simple and gives a natural transaction boundary. A single very busy account is limited by one object’s throughput; scale by adding accounts, not by sharding an account.
- **Demo data in the account object** makes the starter runnable without a second service. For a real app, call the upstream API and remove `demo_notes`.
- **Policy as JSON** is flexible and easy to evolve. It is validated and normalised on both save and use.
- **Plain JSON Schema in code** avoids a schema-generation dependency and keeps discovery output predictable. Pair each JSON Schema with a Zod validator and a test that they agree.
- **No automatic retries** is a correctness choice. Distributed writes without idempotency keys are safer when the caller decides whether to retry after reading state.
