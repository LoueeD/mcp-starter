# Operations

Routine tasks, key rotation, recovery and monitoring.

## Connection lifecycle

### Rotate a URL

Use when a URL may have leaked, when a device is replaced, or periodically for high-value connections.

1. Open the connection menu → **Rotate URL**.
2. Copy the new URL immediately.
3. Update the MCP client configuration.
4. Confirm the old URL returns 404.

The old token hash is replaced in one transaction. In-flight requests that have already resolved the old token may finish; new requests fail. Rotate again deliberately if you lose the new URL.

### Revoke a connection

**Revoke** is permanent. It clears the encrypted credential, the token hash and the access policy, and retains a summary for audit. Create a new connection if you need one later.

Revocation is the right response to a suspected leak. Rotation is the right response to a lost URL you still control.

### Disable and enable

Disabling blocks new MCP requests but keeps the URL and credential. Use it for a temporary pause, for example while investigating unexpected writes. Enabling restores service. Both operations bump the revision, so clients must rediscover.

### Rename

Renaming is cosmetic and bumps the revision. It does not change the URL.

### Replace the app credential

Use when the upstream key rotates but the MCP URL should stay the same. The new credential is validated, encrypted and stored; the old ciphertext is replaced. In-flight requests may still use the old credential until they finish.

### Change access policy

Saving a policy bumps the revision. Existing clients continue on their next request with the new policy and must rediscover the operation set. Start read-only, review the agent’s reads, then grant the writes it actually needs.

## Passkeys

### Add a passkey

Add at least two independently usable passkeys (for example, a platform passkey and a hardware key). Add a passkey before removing the only other one; the server refuses to remove the last credential.

### Remove a passkey

Removing a passkey deletes every session. Sign in again with a remaining passkey. If you remove the last one, the account is unrecoverable.

### Lost all passkeys

There is no recovery path in the starter. Options:

- Restore the Durable Object from a backup if you have one.
- If you have access to the Cloudflare account and the data is disposable, delete the Durable Object and start again.
- If you need account recovery as a product feature, design it deliberately: recovery codes, a second administrator, or an out-of-band identity provider. Do not add an email reset without a full threat review.

## Encryption key rotation

Goal: introduce a new active key without making existing ciphertext unreadable.

1. Generate a new 32-byte key:
   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```
2. Add it to the keyring under a new version:
   ```json
   { "v1": "<old>", "v2": "<new>" }
   ```
3. Set `ENCRYPTION_KEY_VERSION=v2` in `wrangler.jsonc`.
4. Update the secret:
   ```bash
   npx wrangler secret put ENCRYPTION_KEYS
   ```
5. Deploy.
6. Open each connection and re-save its credential. New writes use `v2`; connections that still have `v1` ciphertext remain readable because `v1` is still in the keyring.
7. Verify no connection still uses `v1`. A temporary diagnostic query can count envelopes by `key_version` if you expose one privately. Do not add a public endpoint.
8. Remove `v1` from the keyring and update the secret.
9. Deploy and test a decryption.

If you remove a key while ciphertext still references it, those credentials return `CREDENTIAL_UNAVAILABLE` and the connection cannot execute until the credential is replaced.

### Emergency rotation

If the keyring leaked:

1. Generate a completely new keyring with a new active version.
2. Deploy it.
3. Replace every connection credential through the UI. This re-encrypts under the new active key.
4. Remove the old versions.
5. Rotate the upstream credentials themselves. An attacker with the old key and a database copy can decrypt old ciphertext.
6. Rotate `CEREMONY_KEY` too if the leak could include Worker secrets.
7. Review logs and access policy for unexpected changes.

## Ceremony key rotation

`CEREMONY_KEY` only protects short-lived (five-minute) passkey ceremonies. Rotating it:

1. Generate a new 43-character key.
2. `npx wrangler secret put CEREMONY_KEY`.
3. Deploy.

In-flight ceremonies fail and the user retries. Sessions and stored credentials are unaffected. Rotate after a suspected leak or as part of routine secret hygiene.

## Session and challenge housekeeping

The Durable Object prunes expired sessions and challenges during authentication. Limits:

- 20 sessions per account;
- 256 used challenges;
- 20 passkeys;
- 20 active connections;
- 100 retained revoked connections.

If you need stricter session lifetimes, lower `SESSION_MILLISECONDS` in `src/accounts/model.ts`. If you need more connections, raise `MAX_ACTIVE_CONNECTIONS` and consider the UI and rate limits.

## Monitoring

Useful signals:

- **Worker errors** — 5xx rate, error 1102 (CPU), error 1027 (daily request limit).
- **Durable Object errors** — storage unavailable, SQL full, migration failures.
- **429 rate limiting** — authentication and provisioning.
- **MCP tool errors** — count by code (`ACCESS_DENIED`, `WRITE_UNCERTAIN`, `SCHEMA_CHANGED`). Do not log arguments.
- **Usage** — requests, CPU, row reads/writes, storage. Watch for a chatty agent.
- **Deploy health** — `/health` and a smoke test after each deploy.

Configure alerts on error rate and daily usage. Keep log retention minimal and scrub URLs. A token in an error tracker is a credential leak.

## Backups and recovery

- Durable Object SQLite data is replicated by Cloudflare, but replication is not a user-facing backup.
- For production, take periodic logical exports or use the Durable Objects SQLite backup/restore features available to your plan.
- Test a restore into a separate namespace before relying on it.
- A backup contains encrypted credentials. Treat it as sensitive; without the keyring it is not usable, but with the keyring it is.
- Do not copy `.wrangler/state` from development into production or vice versa.

## Limits and quotas

Tune the constants in `src/accounts/model.ts` and the rate limits in `wrangler.jsonc`:

- Lower authentication limits if you see abuse.
- Lower connection creation limits if accounts are being used to spray connections.
- Increase page-size caps only if your upstream can handle it.
- Keep credential plaintext under 8 KB; larger secrets belong in a secrets manager referenced by a short identifier.

## Dependency upgrades

```bash
npm outdated
npm update
npm run check
```

Before deploying an upgrade:

1. Read the changelog for `@modelcontextprotocol/server`, `@modelcontextprotocol/client` and `@simplewebauthn/server`.
2. Run the full test suite.
3. Deploy to a staging Worker with a separate hostname and secrets.
4. Test registration, login, connection creation, discovery, one read, one write, rotation and revocation.
5. Deploy to production during a quiet period.

Pin exact versions for the MCP and WebAuthn packages if reproducibility matters more than automatic patch updates.

## Schema migrations

The `AccountStore` creates its schema inside the first registration transaction. This is convenient for a starter but not a full migration system.

For an existing deployment:

1. Add a new `schema_version` value.
2. Write an idempotent migration that runs when the object opens.
3. Back up first.
4. Test against a copy of real-shaped data.

Never drop a table or column without a migration path. Never assume every object has the latest schema; Durable Objects can be cold for a long time and upgrade lazily.

## Incident response

### Suspected MCP URL leak

1. Rotate or revoke the connection.
2. Review recent tool calls for unexpected reads/writes if you have audit logs.
3. Replace the upstream credential if writes may have occurred.
4. Search logs, issue trackers and chat for the URL; remove it where possible.
5. Notify affected users if data was accessed.

### Suspected session or CSRF leak

1. Sign out all sessions by removing and re-adding a passkey, or add an administrative “delete all sessions” operation.
2. Rotate the passkey if the authenticator may be compromised.
3. Review connection changes.

### Suspected Worker secret leak

1. Rotate `ENCRYPTION_KEYS` and `CEREMONY_KEY`.
2. Re-encrypt every credential by replacing it.
3. Rotate upstream credentials.
4. Review Cloudflare audit logs and deploy history.
5. Revoke the Cloudflare API token used by CI and issue a new one.

### Abuse or runaway agent

1. Disable or revoke the connection.
2. Lower the relevant rate limit.
3. Check upstream quotas and revoke the upstream credential if needed.
4. Add narrower operations or stricter page limits before re-enabling.

## Runbook checklist

- [ ] Two passkeys per account.
- [ ] Read-only by default; writes granted per resource.
- [ ] Connection inventory reviewed monthly; revoke unused connections.
- [ ] Key rotation scheduled and tested.
- [ ] Backups taken and restore tested.
- [ ] Alerts on 5xx, 1102, 1027 and 429.
- [ ] No URLs or credentials in logs or analytics.
- [ ] Deploy pipeline requires tests and protects `main`.
