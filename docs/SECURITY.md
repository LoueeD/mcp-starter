# Security model

This starter handles two valuable things: access to someone’s application data, and an upstream credential that can read and write that data. Treat both as production secrets.

## Assets

1. **Passkeys and sessions** — control who can manage connections.
2. **Connection URLs** — bearer credentials for the MCP endpoint.
3. **Upstream app credentials** — encrypted at rest, decrypted only for an authorized execution.
4. **Application data** — exposed through the operation catalogue and constrained by access policy.
5. **Signing and encryption keys** — Worker secrets that protect ceremonies and stored credentials.

## Adversaries

- Someone who obtains a leaked MCP URL.
- Someone who obtains a leaked session cookie or CSRF token.
- A malicious or compromised MCP client that sends unexpected tool calls or arguments.
- An attacker who can make requests from another origin in a victim’s browser (CSRF, clickjacking).
- Someone with read access to logs, analytics or error reports.
- A compromised dependency or a stolen Cloudflare API token.
- An insider with access to the Cloudflare account.

This starter does not try to defend against a compromised Cloudflare account or a compromised browser/authenticator. Those require account-level controls, hardware keys and incident response outside the code.

## Trust boundaries

```text
Browser ──(passkey + session cookie)──► Worker ──(RPC)──► AccountStore
MCP client ──(bearer URL)─────────────► Worker ──(RPC)──► AccountStore
AccountStore ──(decrypted credential)─► upstream app
```

- The Worker is the only public compute.
- The Durable Object trusts the Worker’s RPC calls. It still re-validates tokens, revisions, access and arguments, because defence in depth is cheap here.
- The upstream app must enforce its own permissions. The access policy limits what this MCP server will request; it is not a substitute for upstream authorization.

## Passkeys

- Registration and authentication use `@simplewebauthn/server`.
- User presence and user verification are required.
- Supported algorithms are ES256 (`-7`) and RS256 (`-257`).
- Attestation is `none`; the starter does not verify authenticator provenance. Add attestation verification if your threat model requires specific hardware.
- The RP ID and origin are validated at startup. `localhost` is the only HTTP host allowed.
- Registration options use `residentKey: "required"` and `userVerification: "required"`.
- The account id is the WebAuthn user handle. Login reads it from the signed assertion; it is never taken from a request field.
- Authentication counters must match the stored counter and must advance when either the old or new counter is non-zero.
- Used challenges are recorded to prevent replay. Expired records are pruned.
- There is no password, email or recovery code. If every passkey is lost, the account is unrecoverable. The UI prompts for a second passkey after signup. Make that a real operational requirement.

## Ceremony cookies

Passkey ceremonies are stateless between the options and verify calls. The state is stored in a `__Host-mcp_starter_ceremony` cookie:

- `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain`.
- Payload is base64url JSON, signed with HMAC-SHA-256 using `CEREMONY_KEY`.
- The signed payload includes purpose, challenge, issued/expiry times, origin, RP ID and (for registration/add-passkey) the account id and label.
- Add-passkey ceremonies also bind the initiating session hash.
- Verification requires an exact origin, RP ID, purpose and time window. Tampering, reuse for another purpose and expired cookies all fail with the same generic `AUTH_FAILED`.
- The cookie is cleared at the start of the verify response, even on failure.

## Sessions

- Session tokens are 256-bit random values in the same routed format as connection tokens (account prefix + random part).
- Only a SHA-256 hash is stored. A database read does not reveal a usable session.
- Cookies are `__Host-mcp_starter_session`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`.
- Sessions expire after 30 minutes. The limit is 20 per account; older sessions are pruned.
- Signing out deletes the session row. Removing a passkey deletes all sessions.
- Session fixation is not possible because the server generates the token after successful verification.

## CSRF and origin checks

- Every mutation requires `X-CSRF-Token`. The expected value is derived from the session token with domain separation; comparison is timing-safe.
- Browser routes require `Origin` to equal the configured origin exactly.
- If `Sec-Fetch-Site` is present, it must be `same-origin`.
- Mutations require `Content-Type: application/json`, which prevents simple cross-site form posts.
- The static UI is served with `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and a restrictive Content-Security-Policy.
- `form-action 'none'` prevents form-based navigation. The client uses `fetch` for all mutations.

## Connection URL model

A token is both an identifier and a secret:

```text
<64-hex-account-id>.<43-char-base64url-random>
```

- The account prefix lets the Worker route without a global index.
- The random part is 256 bits.
- Only `SHA-256("mcp-starter:execution:" + token)` is stored.
- Lookup is by hash, so a stolen database does not yield working URLs.
- URLs are returned only at creation and rotation. The UI clears the input on page hide, and never puts the URL in a query string.
- The server stores no plaintext URL and logs no URL.
- A 404 is returned for unknown, revoked, rotated and disabled connections. No distinction is revealed.
- Every HTTP request resolves the token and checks status, disabled flag and revision.
- Rotation replaces the hash; the old URL stops working immediately. Revocation also clears the encrypted credential and policy.

### Bearer URL risks

Anyone who obtains the URL can use the permitted operations until the connection is rotated or revoked. This is the same trade-off as an API key in a URL. To reduce exposure:

- Keep URLs out of logs, analytics, screenshots, chat transcripts and issue trackers.
- Do not paste a URL into a prompt. Put it in the client’s server configuration.
- Use one connection per client or device so you can revoke one without disrupting the others.
- Start read-only and grant writes deliberately.
- Rotate after a suspected leak.

If your client supports custom headers, a future enhancement is to move the token into an `Authorization` header. The starter uses a path token because many remote MCP clients only ask for a URL.

## Credential encryption

- AES-256-GCM with a 96-bit random nonce per encryption.
- The plaintext is limited to 8192 bytes.
- The envelope includes a format version, key version, nonce and ciphertext.
- Additional authenticated data is:

  ```text
  ["mcp-starter", 2, accountId, connectionId, "app_credential", keyVersion]
  ```

- Copying an envelope to another account or connection fails authentication.
- Changing the key version field fails authentication.
- Decryption errors are collapsed into `CREDENTIAL_UNAVAILABLE`; no plaintext, key or internal detail is returned.
- The keyring is a JSON object of version → 32-byte base64url key. It is parsed with strict length, count and encoding checks.
- The ceremony key must differ from every encryption key. This prevents accidental key reuse across primitives.

### Key rotation

`ENCRYPTION_KEY_VERSION` selects the key used for new encryptions. Old versions remain in the keyring for decryption. To retire a version, re-save every connection credential and confirm no rows reference the old version. Removing a key that still has ciphertext makes those credentials permanently unreadable.

## Access enforcement

Access is checked in two places:

1. **Discovery** filters operations with `visibleOperations(policy)`. Hidden operations do not appear.
2. **Execution** looks up the operation, rejects it if not visible (`ACCESS_DENIED`) and repeats the check inside the Durable Object.

A guessed operation id cannot bypass the policy. A stale client cannot use an operation that was just removed because the policy is resolved on each HTTP request, and the Durable Object checks it again.

Write permissions require `read` because every write is read back before success is reported.

The demo access policy is stored as JSON and normalised on save:

```json
{
  "version": 1,
  "resources": {
    "notes": { "read": true, "create": true, "update": false, "delete": false }
  }
}
```

Unknown resources are ignored by execution but remain in the document. A removed resource grants nothing.

## Arguments and errors

- Every operation has a Zod validator applied server-side, regardless of the JSON Schema advertised to the client.
- Objects are strict: unknown properties are rejected. This prevents argument smuggling.
- Errors use stable codes and safe messages. They do not include the token, URL, credential or upstream response body.
- Validation errors include issue paths and messages, not the input values.
- The demo `CONFLICT` error returns the current record so the agent can reconcile. Do not include sensitive fields in conflict payloads for a real app.

## Write safety

- Writes are not retried automatically.
- If a write fails before any upstream mutation, return `AppError` with `mutationSent: false`.
- If a write may have been applied, return an uncertain result with `mutation_sent: "unknown"`, `write_outcome: "uncertain"` and `requires_readback: true`.
- Successful writes are read back and reported with `read_back: true` and `automatic_retry: false`.
- Updates preserve unspecified fields. The demo supports optimistic concurrency with `expected_updated_at`.
- Provide an idempotency key in your own adapter if your upstream API supports one. The starter does not invent one because uniqueness semantics are app-specific.

## Logging and analytics

- The MCP handler logs only an event name and error class on failure. It never logs the token, URL or arguments.
- `wrangler.jsonc` disables invocation logs and redacts query strings.
- Do not add request logging that captures `c.req.url`, the `Cookie` header, the `Authorization` header or tool arguments.
- Error tracking services must be configured to scrub URLs. A URL token in an exception report is a credential leak.
- The UI never writes the install URL to `localStorage`, `sessionStorage` or the URL bar.

## Rate limiting

- Authentication endpoints: per client address, 20 requests per 60 seconds per Cloudflare location.
- Connection creation: per account, 10 requests per 60 seconds per location.
- Limits are approximate and eventually consistent. They are abuse protection, not a billing control.
- If `CF-Connecting-IP` is missing in production, authentication fails closed rather than using a spoofable header. The only fallback is local development on `localhost`.

## What is not covered

- **XSS in your UI.** The starter uses `textContent` and avoids `innerHTML` for dynamic data, but any change can introduce an injection. Keep the CSP strict.
- **Compromised upstream credentials.** Encrypting at rest does not protect a credential used by a compromised Worker. Rotate upstream keys if the Worker or Cloudflare account is compromised.
- **Malicious operations.** An operation that accepts an arbitrary URL or query can be abused. Design narrow operations.
- **Denial of service.** Cloudflare absorbs volumetric attacks, but an authenticated client can still make many legitimate calls. Use access scopes, upstream quotas and rate limits.
- **Legal/compliance requirements.** Add retention policies, audit logs and data residency controls if your app needs them.
- **Account recovery.** Passkeys plus a second passkey are the recovery plan.

## Security checklist before launch

- [ ] `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` are the final production values.
- [ ] `CEREMONY_KEY` and `ENCRYPTION_KEYS` are independent, random and stored as Worker secrets.
- [ ] `.var.dev` is gitignored and not in build artifacts.
- [ ] CI secrets are scoped to the minimum permissions.
- [ ] New connections default to read-only.
- [ ] Every write operation has a read-back path and a conflict strategy.
- [ ] Operation inputs reject unknown fields and bound string/number lengths.
- [ ] No URL, token, cookie or credential is logged or sent to analytics.
- [ ] Error responses do not include upstream bodies or stack traces.
- [ ] The `/health` route reveals no configuration.
- [ ] You have tested rotation and revocation end to end.
- [ ] You have a plan for a leaked URL and a lost passkey.
