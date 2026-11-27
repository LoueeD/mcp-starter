# Setup

This guide takes you from a checkout to a working production deployment. The README has the short version; this document explains the details and the failure points.

## 1. Prerequisites

- Node.js 24.11+ and npm.
- A Cloudflare account. The Free plan works for development and light use; see `FREE_TIER.md`.
- A browser with passkeys on the machine you will use to create the first account.
- `wrangler` is installed through the project’s dev dependencies, so use `npx wrangler` or the npm scripts.

```bash
node --version   # v24.11.0 or newer
npm install
```

## 2. Local development

```bash
cp .var.dev.example .var.dev
npm run secrets
npm run dev
```

The dev server listens on <http://localhost:8787>. The first request may take a few seconds while Wrangler starts the Durable Object and asset services.

### What `npm run secrets` does

- Copies `.var.dev.example` to `.var.dev` if it does not exist.
- Generates `CEREMONY_KEY` and the active `ENCRYPTION_KEYS` entry if missing.
- Preserves existing values.
- Writes the file with mode `0600`.
- Never prints secret values or passes them on a command line.

`CEREMONY_KEY` must be 32 random bytes encoded as unpadded base64url (43 characters). `ENCRYPTION_KEYS` is a JSON object of the same encoding. The script enforces both.

### Local WebAuthn context

`.var.dev.example` sets:

```text
WEBAUTHN_RP_ID=localhost
WEBAUTHN_ORIGIN=http://localhost:8787
```

These override the production values in `wrangler.jsonc` while running `wrangler dev --env-file .var.dev`. `localhost` is the only hostname allowed over plain HTTP.

### First local account

1. Open <http://localhost:8787>.
2. Choose **Sign up**.
3. Give the account a label and approve the passkey prompt.
4. Add a second passkey when prompted. There is no password recovery; two independent keys are the recovery plan.
5. Create a connection with a name and the demo credential `demo_local_development`.
6. Copy the MCP URL immediately. It is shown once.

## 3. Decide the production hostname

Passkeys are bound to a hostname. Changing it later breaks existing credentials for the old host. Decide before the first real account.

### Option A: workers.dev

The hostname is `<worker-name>.<your-subdomain>.workers.dev`. Change `name` in `wrangler.jsonc` and set:

```json
"WEBAUTHN_RP_ID": "your-worker.your-subdomain.workers.dev",
"WEBAUTHN_ORIGIN": "https://your-worker.your-subdomain.workers.dev"
```

### Option B: custom domain

1. Add the zone to Cloudflare.
2. Add a Workers custom domain in the dashboard, or use a `routes` entry in `wrangler.jsonc`.
3. Set `WEBAUTHN_RP_ID` to the bare hostname and `WEBAUTHN_ORIGIN` to the exact HTTPS origin.

Example `wrangler.jsonc` fragment for a custom domain:

```jsonc
"routes": [
  { "pattern": "mcp.example.com", "custom_domain": true }
],
"vars": {
  "WEBAUTHN_RP_ID": "mcp.example.com",
  "WEBAUTHN_ORIGIN": "https://mcp.example.com"
}
```

Do not include a path in `WEBAUTHN_ORIGIN`. Do not use a wildcard hostname. Do not put the Worker behind a proxy that rewrites the `Host` or `Origin` headers unless you fully understand the consequences.

## 4. Production secrets

Generate local values if needed, then set them on the deployed Worker:

```bash
npm run secrets

npx wrangler secret put CEREMONY_KEY
npx wrangler secret put ENCRYPTION_KEYS
```

Paste the values from `.var.dev` when prompted. On a shared machine, avoid `export` or command-line arguments that leak into shell history or process listings.

### Why the keys are separate

- `CEREMONY_KEY` signs short-lived passkey ceremony cookies. It does not encrypt data at rest.
- `ENCRYPTION_KEYS` protects upstream app credentials. It is versioned so old ciphertext remains readable during rotation.
- The code refuses to start with a ceremony key that equals an encryption key.

### Changing the active encryption version

1. Add a new entry to the JSON object, for example `{ "v1": "...", "v2": "..." }`.
2. Set `ENCRYPTION_KEY_VERSION=v2` in `wrangler.jsonc` (or as a dashboard variable).
3. `npx wrangler secret put ENCRYPTION_KEYS` with the full new object.
4. Deploy. New and re-saved credentials use `v2`; `v1` remains available for decryption.
5. Re-save each connection credential through the UI when convenient.
6. Remove `v1` only after every connection has been migrated.

`docs/OPERATIONS.md` has the full procedure and failure handling.

### Changing the ceremony key

Rotating `CEREMONY_KEY` only invalidates in-flight passkey ceremonies (five minutes). It does not sign users out and does not affect stored credentials. Rotate it if you suspect the key leaked.

## 5. Deploy

```bash
npm run deploy
```

This runs `wrangler deploy --minify` and applies the Durable Object migration declared in `wrangler.jsonc`. The migration creates the `AccountStore` class with SQLite storage.

### First-deploy checklist

- [ ] `name` and `WEBAUTHN_*` values match the final hostname.
- [ ] `CEREMONY_KEY` and `ENCRYPTION_KEYS` are set as Worker secrets.
- [ ] `ENCRYPTION_KEY_VERSION` names an entry in `ENCRYPTION_KEYS`.
- [ ] `npm run check` passes locally.
- [ ] The deploy output shows the expected Worker and Durable Object migration.
- [ ] `https://<host>/health` returns `{"status":"ok",...}`.
- [ ] A passkey account can be created on the deployed host.
- [ ] A connection URL can be created and used with `npm run smoke`.

Production data is separate from local data. Creating an account locally does not create one in production, and vice versa.

## 6. CI and deployment from GitHub

`.github/workflows/main.yml` runs lint, typecheck and tests on every push and pull request. On a push to `main`, it deploys with Wrangler.

Create two repository secrets:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | An API token with permission to edit Workers scripts for the account. The “Edit Cloudflare Workers” template is a good starting point. |
| `CLOUDFLARE_ACCOUNT_ID` | The account id from the Cloudflare dashboard. |

Notes:

- The workflow uses `cloudflare/wrangler-action`. Pin or review the action version if your organisation requires it.
- If the two Cloudflare secrets are missing, the deploy step is skipped with a notice instead of failing CI. Add the secrets when you are ready to deploy.
- Optionally set a repository variable `DEPLOY_ORIGIN` (for example `https://mcp.example.com`) to enable the post-deploy health check. Without it, the deploy still runs and the check is skipped.
- Tests do not need Cloudflare credentials; `vitest.config.ts` generates its own keys.
- `wrangler deploy` preserves existing Worker secrets. Set `CEREMONY_KEY` and `ENCRYPTION_KEYS` once with `wrangler secret put`; do not put them in GitHub unless you deliberately want CI to manage them.
- If you use Wrangler environments, the deploy command and secret names must target the same environment.
- Protect `main` and require the test job before merging if multiple people deploy.

### Optional: deploy only after tests

The workflow already has `needs: test`. If you want manual approval, add a GitHub Environment named `production` to the deploy job and configure required reviewers.

## 7. Multiple environments

Wrangler environments create separate Workers and, by default, separate Durable Object namespaces. Each environment needs:

- its own `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` (hostnames must be unique);
- its own `CEREMONY_KEY` and `ENCRYPTION_KEYS` secrets;
- its own deploy command and migration application.

Do not copy production keys into development. Do not point a development frontend at a production Worker.

## 8. Updating dependencies

```bash
npm outdated
npm update
npm run check
```

Review MCP SDK and `@simplewebauthn/server` changes carefully. The MCP tool result shape and WebAuthn verification APIs are the two places where a dependency upgrade can change behaviour.

## 9. Resetting local state

To start over locally:

```bash
rm -rf .wrangler/state
npm run dev
```

Keep `.var.dev` if you want to retain the same local keys; remove it to generate new ones.

To remove a deployed account, delete its Durable Object storage through the Cloudflare dashboard or add a deliberate admin operation. There is no self-service account deletion route in the starter because deletion is destructive and needs an explicit product decision.

## 10. Common setup failures

| Symptom | Likely cause |
| --- | --- |
| `WEBAUTHN_CONFIG` | RP ID and origin are missing, mismatched, or not a valid hostname/origin pair. |
| `CEREMONY_CONFIG` | `CEREMONY_KEY` is missing, not 43 characters, or does not decode to 32 bytes. |
| `ENCRYPTION_CONFIG` | `ENCRYPTION_KEYS` is not a JSON object of 43-character keys, or `ENCRYPTION_KEY_VERSION` is not present. |
| `SECRET_CONFIG` | The ceremony key equals an encryption key. Generate independent keys. |
| `RATE_LIMIT_CONFIG` | The rate-limit bindings are missing from `wrangler.jsonc`. Deploy the current configuration. |
| Passkey prompt never appears | The page is not a secure context, the hostname does not match, or the browser has no authenticator. |
| Login works locally but not after deploy | The local and production hostnames differ; passkeys do not transfer. |
| `wrangler secret put` fails | The Worker does not exist yet, or `wrangler.jsonc` is invalid. Run `npx wrangler deploy --dry-run` first. |
