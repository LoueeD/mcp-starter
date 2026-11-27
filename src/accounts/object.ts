import { DurableObject } from "cloudflare:workers";
import { findOperation, isReadKind, OPERATIONS, operationAllowed } from "../app/catalogue";
import { demoRead, demoWrite, seedDemoNotes } from "../app/demo";
import { AppError } from "../app/errors";
import type { AccessPolicy } from "../app/types";
import { accessPolicySchema, defaultPolicy, normalisePolicy } from "./access";
import {
  type ConnectionAccess,
  type ConnectionChange,
  type ConnectionCreate,
  type ConnectionList,
  type ConnectionSummary,
  connectionAccessSchema,
  connectionChangeSchema,
  connectionCreateSchema,
  connectionCursor,
  listConnectionsSchema,
  publicConnection,
  readConnectionCursor,
  type StoredConnection,
} from "./connections";
import {
  credentialAccountId,
  decryptAppCredential,
  encryptAppCredential,
  keyring,
  routedToken,
  tokenHash,
} from "./crypto";
import {
  type AccountRegistration,
  AccountStorageError,
  type AccountSummary,
  type AuthenticationCommit,
  accountIdSchema,
  authenticationCommitSchema,
  credentialIdSchema,
  MAX_ACTIVE_CONNECTIONS,
  MAX_PASSKEYS,
  MAX_REVOKED_CONNECTIONS,
  MAX_SESSIONS,
  MAX_USED_CHALLENGES,
  type PasskeyAddition,
  type PasskeyRemoval,
  passkeyAdditionSchema,
  passkeyRemovalSchema,
  registrationSchema,
  SESSION_MILLISECONDS,
  type SessionAccess,
  type StoredPasskey,
  sessionAccessSchema,
} from "./model";
import schema from "./schema.sql";

type RpcError = {
  code: string;
  message: string;
  status: 400 | 401 | 403 | 404 | 409 | 503;
  details?: Record<string, unknown>;
  mutation_sent?: boolean | "unknown";
};
// A single object shape, not a discriminated union. Cloudflare's RPC type
// mapping adds `& Disposable` to returned objects and cannot represent a union
// reliably across the Durable Object boundary, so callers check `ok` and then
// narrow with `unwrap`/explicit checks.
type RpcResult<T> = { ok: boolean; value?: T; error?: RpcError };
type AppResult = RpcResult<Record<string, unknown>>;

// Private Worker RPC only. The Worker verifies WebAuthn and the signed ceremony
// before registration/authentication/addition. There is deliberately no public
// fetch handler on this Durable Object.
export class AccountStore extends DurableObject<CloudflareBindings> {
  #account(): AccountSummary | null {
    const exists = this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'account'")
      .toArray().length;
    if (!exists) return null;
    const version = this.ctx.storage.sql
      .exec<{ version: number }>("SELECT version FROM schema_version WHERE slot = 1")
      .toArray()[0];
    if (version?.version !== 1) throw new Error("Unsupported account schema");
    return (
      this.ctx.storage.sql
        .exec<AccountSummary>("SELECT id,label,created_at,updated_at FROM account WHERE slot = 1")
        .toArray()[0] ?? null
    );
  }

  #safe<T>(run: () => T): RpcResult<T> {
    try {
      return { ok: true as const, value: run() };
    } catch (error) {
      return {
        ok: false as const,
        error:
          error instanceof AccountStorageError
            ? { code: error.code, message: error.message, status: error.status }
            : {
                code: "STORAGE_UNAVAILABLE",
                message: "Account storage could not complete this request.",
                status: 503 as const,
              },
      };
    }
  }

  getAccount(accountId: string) {
    return this.#safe(() => {
      if (!accountIdSchema.safeParse(accountId).success) return null;
      const account = this.#account();
      return account?.id === accountId ? account : null;
    });
  }

  getPasskey(accountId: string, credentialId: string) {
    return this.#safe((): StoredPasskey | null => {
      if (
        !accountIdSchema.safeParse(accountId).success ||
        !credentialIdSchema.safeParse(credentialId).success
      )
        return null;
      if (this.#account()?.id !== accountId) return null;
      const row = this.ctx.storage.sql
        .exec<{
          credential_id: string;
          public_key: ArrayBuffer;
          counter: number;
          transports: string;
          device_type: "singleDevice" | "multiDevice";
          backed_up: number;
          label: string;
          created_at: number;
          last_used_at: number | null;
        }>("SELECT * FROM passkeys WHERE credential_id = ?", credentialId)
        .toArray()[0];
      return row
        ? {
            id: row.credential_id,
            publicKey: new Uint8Array(row.public_key),
            counter: row.counter,
            transports: JSON.parse(row.transports),
            deviceType: row.device_type,
            backedUp: row.backed_up === 1,
            label: row.label,
            createdAt: row.created_at,
            lastUsedAt: row.last_used_at,
          }
        : null;
    });
  }

  register(input: AccountRegistration) {
    const parsed = registrationSchema.safeParse(input);
    const now = Date.now();
    if (
      !parsed.success ||
      parsed.data.challengeExpiresAt <= now ||
      parsed.data.challengeExpiresAt > now + 300_000
    ) {
      return {
        ok: false as const,
        error: {
          code: "INVALID_ARGUMENTS",
          message: "Invalid account registration.",
          status: 400 as const,
        },
      };
    }
    return this.#safe(() => {
      if (this.#account())
        throw new AccountStorageError("ALREADY_EXISTS", "This account already exists.", 409);
      const { accountId, label, passkey, sessionHash, challengeHash, challengeExpiresAt } =
        parsed.data;
      const expiresAt = now + SESSION_MILLISECONDS;
      // DDL, account, first credential, first session, replay guard and demo
      // seed all commit together.
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(schema);
        this.ctx.storage.sql.exec(
          "INSERT INTO account VALUES (1,?,?,?,?)",
          accountId,
          label,
          now,
          now,
        );
        this.ctx.storage.sql.exec(
          `INSERT INTO passkeys
          (credential_id,public_key,counter,transports,device_type,backed_up,label,created_at,last_used_at)
          VALUES (?,?,?,?,?,?,?,?,?)`,
          passkey.id,
          passkey.publicKey.slice().buffer,
          passkey.counter,
          JSON.stringify(passkey.transports),
          passkey.deviceType,
          passkey.backedUp ? 1 : 0,
          passkey.label,
          now,
          now,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO sessions VALUES (?,?,?)",
          sessionHash,
          now,
          expiresAt,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO used_challenges VALUES (?,?)",
          challengeHash,
          challengeExpiresAt,
        );
        seedDemoNotes(this.ctx.storage.sql);
      });
      return {
        created: true as const,
        account: { id: accountId, label, created_at: now, updated_at: now },
        sessionExpiresAt: expiresAt,
      };
    });
  }

  commitAuthentication(input: AuthenticationCommit) {
    const parsed = authenticationCommitSchema.safeParse(input);
    const now = Date.now();
    if (
      !parsed.success ||
      parsed.data.challengeExpiresAt <= now ||
      parsed.data.challengeExpiresAt > now + 300_000
    ) {
      return {
        ok: false as const,
        error: {
          code: "AUTH_FAILED",
          message: "Passkey authentication failed.",
          status: 401 as const,
        },
      };
    }
    return this.#safe(() =>
      this.ctx.storage.transactionSync(() => {
        const data = parsed.data;
        const account = this.#account();
        if (account?.id !== data.accountId)
          throw new AccountStorageError("AUTH_FAILED", "Passkey authentication failed.", 401);
        const credential = this.ctx.storage.sql
          .exec<{ counter: number; device_type: string }>(
            "SELECT counter,device_type FROM passkeys WHERE credential_id = ?",
            data.credentialId,
          )
          .toArray()[0];
        const used = this.ctx.storage.sql
          .exec(
            "SELECT hash FROM used_challenges WHERE hash = ? AND expires_at > ?",
            data.challengeHash,
            now,
          )
          .toArray().length;
        if (
          !credential ||
          used ||
          credential.counter !== data.previousCounter ||
          credential.device_type !== data.deviceType ||
          ((data.newCounter > 0 || data.previousCounter > 0) &&
            data.newCounter <= data.previousCounter)
        ) {
          throw new AccountStorageError("AUTH_FAILED", "Passkey authentication failed.", 401);
        }
        this.ctx.storage.sql.exec("DELETE FROM used_challenges WHERE expires_at <= ?", now);
        const count = this.ctx.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM used_challenges")
          .one().count;
        if (count >= MAX_USED_CHALLENGES)
          throw new AccountStorageError("AUTH_CAPACITY", "Try signing in again shortly.", 503);
        this.ctx.storage.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", now);
        this.ctx.storage.sql.exec(
          "DELETE FROM sessions WHERE token_hash NOT IN (SELECT token_hash FROM sessions ORDER BY created_at DESC,token_hash DESC LIMIT ?)",
          MAX_SESSIONS - 1,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO used_challenges VALUES (?,?)",
          data.challengeHash,
          data.challengeExpiresAt,
        );
        this.ctx.storage.sql.exec(
          "UPDATE passkeys SET counter = ?,backed_up = ?,last_used_at = ? WHERE credential_id = ?",
          data.newCounter,
          data.backedUp ? 1 : 0,
          now,
          data.credentialId,
        );
        const expiresAt = now + SESSION_MILLISECONDS;
        this.ctx.storage.sql.exec(
          "INSERT INTO sessions VALUES (?,?,?)",
          data.sessionHash,
          now,
          expiresAt,
        );
        return { account, sessionExpiresAt: expiresAt };
      }),
    );
  }

  async #access(input: SessionAccess) {
    const parsed = sessionAccessSchema.safeParse(input);
    if (
      !parsed.success ||
      credentialAccountId(parsed.data.sessionToken) !== parsed.data.accountId
    ) {
      throw new AccountStorageError("AUTH_FAILED", "Passkey authentication failed.", 401);
    }
    const hash = await tokenHash("session", parsed.data.sessionToken);
    if (parsed.data.csrf !== undefined) {
      const csrf = await tokenHash("csrf", parsed.data.sessionToken);
      if (
        !crypto.subtle.timingSafeEqual(
          new TextEncoder().encode(csrf),
          new TextEncoder().encode(parsed.data.csrf),
        )
      ) {
        throw new AccountStorageError("CSRF", "The account CSRF token is invalid.", 403);
      }
    }
    return { accountId: parsed.data.accountId, hash };
  }

  #session(access: { accountId: string; hash: string }) {
    const account = this.#account();
    if (account?.id !== access.accountId)
      throw new AccountStorageError("AUTH_FAILED", "Passkey authentication failed.", 401);
    const session = this.ctx.storage.sql
      .exec<{ expires_at: number }>(
        "SELECT expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?",
        access.hash,
        Date.now(),
      )
      .toArray()[0];
    if (!session)
      throw new AccountStorageError("AUTH_FAILED", "Passkey authentication failed.", 401);
    return { account, expiresAt: session.expires_at };
  }

  #passkeys() {
    return this.ctx.storage.sql
      .exec<{
        id: string;
        label: string;
        device_type: string;
        backed_up: number;
        created_at: number;
        last_used_at: number | null;
      }>(
        "SELECT credential_id AS id,label,device_type,backed_up,created_at,last_used_at FROM passkeys ORDER BY created_at,credential_id",
      )
      .toArray();
  }

  async sessionSummary(input: SessionAccess) {
    try {
      const access = await this.#access(input);
      return this.#safe(() => {
        const value = this.#session(access);
        return { ...value, passkeyCount: this.#passkeys().length };
      });
    } catch (error) {
      return this.#safe(() => {
        throw error;
      });
    }
  }

  async listPasskeys(input: SessionAccess) {
    try {
      const access = await this.#access(input);
      return this.#safe(() => {
        this.#session(access);
        return this.#passkeys();
      });
    } catch (error) {
      return this.#safe(() => {
        throw error;
      });
    }
  }

  async signOut(input: SessionAccess) {
    try {
      if (!input.csrf)
        throw new AccountStorageError("CSRF", "The account CSRF token is invalid.", 403);
      const access = await this.#access(input);
      return this.#safe(() =>
        this.ctx.storage.transactionSync(() => {
          this.#session(access);
          this.ctx.storage.sql.exec("DELETE FROM sessions WHERE token_hash = ?", access.hash);
          return { signedOut: true };
        }),
      );
    } catch (error) {
      return this.#safe(() => {
        throw error;
      });
    }
  }

  async addPasskey(input: PasskeyAddition) {
    try {
      const parsed = passkeyAdditionSchema.safeParse(input);
      if (!parsed.success)
        throw new AccountStorageError("AUTH_FAILED", "Passkey authentication failed.", 401);
      const data = parsed.data;
      const access = await this.#access({
        accountId: data.accountId,
        sessionToken: data.sessionToken,
        csrf: data.csrf,
      });
      return this.#safe(() =>
        this.ctx.storage.transactionSync(() => {
          this.#session(access);
          const now = Date.now();
          if (
            data.challengeExpiresAt <= now ||
            data.challengeExpiresAt > now + 300_000 ||
            this.ctx.storage.sql
              .exec(
                "SELECT hash FROM used_challenges WHERE hash = ? AND expires_at > ?",
                data.challengeHash,
                now,
              )
              .toArray().length
          ) {
            throw new AccountStorageError("AUTH_FAILED", "Passkey authentication failed.", 401);
          }
          if (
            this.ctx.storage.sql
              .exec("SELECT credential_id FROM passkeys WHERE credential_id = ?", data.passkey.id)
              .toArray().length
          ) {
            throw new AccountStorageError(
              "PASSKEY_EXISTS",
              "This passkey is already registered.",
              409,
            );
          }
          if (this.#passkeys().length >= MAX_PASSKEYS)
            throw new AccountStorageError(
              "PASSKEY_LIMIT",
              "This account has reached its passkey limit.",
              409,
            );
          this.ctx.storage.sql.exec("DELETE FROM used_challenges WHERE expires_at <= ?", now);
          if (
            this.ctx.storage.sql
              .exec<{ count: number }>("SELECT COUNT(*) AS count FROM used_challenges")
              .one().count >= MAX_USED_CHALLENGES
          ) {
            throw new AccountStorageError(
              "AUTH_CAPACITY",
              "Try adding a passkey again shortly.",
              503,
            );
          }
          const key = data.passkey;
          this.ctx.storage.sql.exec(
            "INSERT INTO passkeys (credential_id,public_key,counter,transports,device_type,backed_up,label,created_at,last_used_at) VALUES (?,?,?,?,?,?,?,?,?)",
            key.id,
            key.publicKey.slice().buffer,
            key.counter,
            JSON.stringify(key.transports),
            key.deviceType,
            key.backedUp ? 1 : 0,
            key.label,
            now,
            null,
          );
          this.ctx.storage.sql.exec(
            "INSERT INTO used_challenges VALUES (?,?)",
            data.challengeHash,
            data.challengeExpiresAt,
          );
          this.ctx.storage.sql.exec("UPDATE account SET updated_at = ? WHERE slot = 1", now);
          return { added: true, passkeyCount: this.#passkeys().length };
        }),
      );
    } catch (error) {
      return this.#safe(() => {
        throw error;
      });
    }
  }

  async removePasskey(input: PasskeyRemoval) {
    const parsed = passkeyRemovalSchema.safeParse(input);
    if (
      !parsed.success ||
      credentialAccountId(parsed.data.sessionToken) !== parsed.data.accountId
    ) {
      return {
        ok: false as const,
        error: {
          code: "AUTH_FAILED",
          message: "Passkey authentication failed.",
          status: 401 as const,
        },
      };
    }
    const data = parsed.data;
    const [hash, expectedCsrf] = await Promise.all([
      tokenHash("session", data.sessionToken),
      tokenHash("csrf", data.sessionToken),
    ]);
    return this.#safe(() =>
      this.ctx.storage.transactionSync(() => {
        if (
          !crypto.subtle.timingSafeEqual(
            new TextEncoder().encode(expectedCsrf),
            new TextEncoder().encode(data.csrf),
          )
        ) {
          throw new AccountStorageError("CSRF", "The account CSRF token is invalid.", 403);
        }
        if (
          this.#account()?.id !== data.accountId ||
          !this.ctx.storage.sql
            .exec(
              "SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ?",
              hash,
              Date.now(),
            )
            .toArray().length
        ) {
          throw new AccountStorageError("AUTH_FAILED", "Passkey authentication failed.", 401);
        }
        if (
          !this.ctx.storage.sql
            .exec("SELECT credential_id FROM passkeys WHERE credential_id = ?", data.credentialId)
            .toArray().length
        ) {
          throw new AccountStorageError("AUTH_FAILED", "Passkey authentication failed.", 401);
        }
        if (
          this.ctx.storage.sql
            .exec<{ count: number }>("SELECT COUNT(*) AS count FROM passkeys")
            .one().count <= 1
        ) {
          throw new AccountStorageError(
            "LAST_PASSKEY",
            "Add another passkey before removing this one.",
            409,
          );
        }
        this.ctx.storage.sql.exec(
          "DELETE FROM passkeys WHERE credential_id = ?",
          data.credentialId,
        );
        this.ctx.storage.sql.exec("DELETE FROM sessions");
        this.ctx.storage.sql.exec("UPDATE account SET updated_at = ? WHERE slot = 1", Date.now());
        return { removed: true, sessionsInvalidated: true };
      }),
    );
  }

  #connection(id: string) {
    return (
      this.ctx.storage.sql
        .exec<StoredConnection>("SELECT * FROM connections WHERE id = ?", id)
        .toArray()[0] ?? null
    );
  }

  #policy(id: string): AccessPolicy | null {
    const row = this.ctx.storage.sql
      .exec<{ document: string }>(
        "SELECT document FROM connection_policy WHERE connection_id = ?",
        id,
      )
      .toArray()[0];
    return row ? accessPolicySchema.parse(JSON.parse(row.document)) : null;
  }

  #requireConnection(id: string) {
    const row = this.#connection(id);
    if (!row)
      throw new AccountStorageError(
        "STORAGE_UNAVAILABLE",
        "The connection could not be read.",
        503,
      );
    return row;
  }

  #publicConnection(row: StoredConnection): ConnectionSummary {
    return {
      ...publicConnection({
        ...row,
        disabled: row.disabled === 1,
        access_configured: Boolean(this.#policy(row.id)),
      }),
    };
  }

  #currentConnection(input: ConnectionAccess) {
    const row = this.#connection(input.id);
    if (!row)
      throw new AccountStorageError("CONNECTION_NOT_FOUND", "This connection is unavailable.", 404);
    if (row.revision !== input.revision || row.status !== "active")
      throw new AccountStorageError(
        "CONNECTION_CHANGED",
        "Refresh the connection list before making this change.",
        409,
      );
    return row;
  }

  #pruneRevokedConnections() {
    this.ctx.storage.sql.exec(
      "DELETE FROM connection_policy WHERE connection_id IN (SELECT id FROM connections WHERE status = 'revoked')",
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM connections WHERE status = 'revoked' AND id NOT IN (SELECT id FROM connections WHERE status = 'revoked' ORDER BY revoked_at DESC,id DESC LIMIT ?)",
      MAX_REVOKED_CONNECTIONS,
    );
  }

  async listConnections(input: ConnectionList) {
    try {
      const parsed = listConnectionsSchema.safeParse(input);
      if (!parsed.success)
        throw new AccountStorageError(
          "INVALID_ARGUMENTS",
          "Supply bounded connection pagination.",
          400,
        );
      const data = parsed.data;
      let cursor: { createdAt: number; id: string } | null;
      try {
        cursor = data.cursor ? readConnectionCursor(data.cursor, data.accountId) : null;
      } catch {
        throw new AccountStorageError(
          "INVALID_CURSOR",
          "Use a cursor from this account's connection list.",
          400,
        );
      }
      const access = await this.#access({
        accountId: data.accountId,
        sessionToken: data.sessionToken,
        csrf: data.csrf,
      });
      return this.#safe(() => {
        this.#session(access);
        const columns =
          "id,name,status,disabled,app_credential_ciphertext,execution_token_hash,revision,created_at,updated_at,rotated_at,revoked_at";
        const rows = cursor
          ? this.ctx.storage.sql
              .exec<StoredConnection>(
                `SELECT ${columns} FROM connections WHERE created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC,id DESC LIMIT ?`,
                cursor.createdAt,
                cursor.createdAt,
                cursor.id,
                data.limit + 1,
              )
              .toArray()
          : this.ctx.storage.sql
              .exec<StoredConnection>(
                `SELECT ${columns} FROM connections ORDER BY created_at DESC,id DESC LIMIT ?`,
                data.limit + 1,
              )
              .toArray();
        const connections = rows.slice(0, data.limit).map((row) => this.#publicConnection(row));
        const last = connections.at(-1);
        return {
          connections,
          next_cursor:
            rows.length > data.limit && last ? connectionCursor(data.accountId, last) : null,
        };
      });
    } catch (error) {
      return this.#safe(() => {
        throw error;
      });
    }
  }

  async createConnection(input: ConnectionCreate) {
    try {
      const parsed = connectionCreateSchema.safeParse(input);
      if (!parsed.success)
        throw new AccountStorageError(
          "INVALID_ARGUMENTS",
          "Supply a connection name and app credential.",
          400,
        );
      const data = parsed.data;
      const access = await this.#access({
        accountId: data.accountId,
        sessionToken: data.sessionToken,
        csrf: data.csrf,
      });
      this.#session(access);
      const id = crypto.randomUUID();
      const token = routedToken(data.accountId);
      const ring = keyring(this.env.ENCRYPTION_KEYS, this.env.ENCRYPTION_KEY_VERSION);
      const [ciphertext, hash] = await Promise.all([
        encryptAppCredential(ring, data.accountId, id, data.credential),
        tokenHash("execution", token),
      ]);
      return this.#safe(() =>
        this.ctx.storage.transactionSync(() => {
          this.#session(access);
          if (
            this.ctx.storage.sql
              .exec<{ count: number }>(
                "SELECT COUNT(*) AS count FROM connections WHERE status = 'active'",
              )
              .one().count >= MAX_ACTIVE_CONNECTIONS
          ) {
            throw new AccountStorageError(
              "CONNECTION_LIMIT",
              "This account has reached its active connection limit.",
              409,
            );
          }
          const now = Date.now();
          this.ctx.storage.sql.exec(
            "INSERT INTO connections (id,name,status,disabled,app_credential_ciphertext,execution_token_hash,revision,created_at,updated_at,rotated_at,revoked_at) VALUES (?,?,'active',0,?,?,1,?,?,NULL,NULL)",
            id,
            data.name,
            ciphertext,
            hash,
            now,
            now,
          );
          this.ctx.storage.sql.exec(
            "INSERT INTO connection_policy VALUES (?,?)",
            id,
            JSON.stringify(defaultPolicy()),
          );
          this.#pruneRevokedConnections();
          return {
            connection: this.#publicConnection(this.#requireConnection(id)),
            executionToken: token,
          };
        }),
      );
    } catch (error) {
      return this.#safe(() => {
        throw error;
      });
    }
  }

  async getConnection(input: ConnectionAccess) {
    try {
      const data = connectionAccessSchema.parse(input);
      const access = await this.#access({
        accountId: data.accountId,
        sessionToken: data.sessionToken,
        csrf: data.csrf,
      });
      return this.#safe(() => {
        this.#session(access);
        return this.#publicConnection(this.#currentConnection(data));
      });
    } catch (error) {
      return this.#safe(() => {
        throw error;
      });
    }
  }

  async ownerAccess(input: Omit<ConnectionAccess, "revision">) {
    try {
      const data = connectionAccessSchema.omit({ revision: true }).parse(input);
      const access = await this.#access({
        accountId: data.accountId,
        sessionToken: data.sessionToken,
        csrf: data.csrf,
      });
      return this.#safe(() => {
        this.#session(access);
        const row = this.#connection(data.id);
        if (!row)
          throw new AccountStorageError(
            "CONNECTION_NOT_FOUND",
            "This connection is unavailable.",
            404,
          );
        return {
          connection: this.#publicConnection(row),
          // The UI always gets a concrete policy. Execution still fails closed
          // when the stored policy is missing.
          policy: this.#policy(row.id) ?? defaultPolicy(),
        };
      });
    } catch (error) {
      return this.#safe(() => {
        throw error;
      });
    }
  }

  async saveAccessPolicy(input: ConnectionAccess & { policy: AccessPolicy }) {
    try {
      const parsed = connectionAccessSchema
        .extend({ policy: accessPolicySchema })
        .strict()
        .safeParse(input);
      if (!parsed.success)
        throw new AccountStorageError(
          "INVALID_ARGUMENTS",
          "Supply a valid bounded access policy.",
          400,
        );
      const data = parsed.data;
      const access = await this.#access({
        accountId: data.accountId,
        sessionToken: data.sessionToken,
        csrf: data.csrf,
      });
      this.#currentConnection(data);
      return this.#safe(() =>
        this.ctx.storage.transactionSync(() => {
          this.#session(access);
          this.#currentConnection(data);
          this.ctx.storage.sql.exec(
            "INSERT INTO connection_policy VALUES (?,?) ON CONFLICT(connection_id) DO UPDATE SET document = excluded.document",
            data.id,
            JSON.stringify(normalisePolicy(data.policy)),
          );
          this.ctx.storage.sql.exec(
            "UPDATE connections SET revision = revision + 1,updated_at = ? WHERE id = ?",
            Date.now(),
            data.id,
          );
          return this.#publicConnection(this.#requireConnection(data.id));
        }),
      );
    } catch (error) {
      return this.#safe(() => {
        throw error;
      });
    }
  }

  async changeConnection(input: ConnectionChange) {
    try {
      const parsed = connectionChangeSchema.safeParse(input);
      if (!parsed.success)
        throw new AccountStorageError(
          "INVALID_ARGUMENTS",
          "Supply the current revision and requested connection change.",
          400,
        );
      const data = parsed.data;
      const access = await this.#access({
        accountId: data.accountId,
        sessionToken: data.sessionToken,
        csrf: data.csrf,
      });
      this.#session(access);
      this.#currentConnection(data);
      const token = data.operation === "rotate" ? routedToken(data.accountId) : null;
      const hash = token ? await tokenHash("execution", token) : null;
      const ciphertext =
        data.credential === undefined
          ? null
          : await encryptAppCredential(
              keyring(this.env.ENCRYPTION_KEYS, this.env.ENCRYPTION_KEY_VERSION),
              data.accountId,
              data.id,
              data.credential,
            );
      return this.#safe(() =>
        this.ctx.storage.transactionSync(() => {
          this.#session(access);
          const row = this.#currentConnection(data);
          const now = Date.now();
          if (data.operation === "rotate")
            this.ctx.storage.sql.exec(
              "UPDATE connections SET execution_token_hash = ?,revision = revision + 1,updated_at = ?,rotated_at = ? WHERE id = ?",
              hash,
              now,
              now,
              data.id,
            );
          else if (data.operation === "revoke") {
            this.ctx.storage.sql.exec(
              "UPDATE connections SET status = 'revoked',app_credential_ciphertext = NULL,execution_token_hash = NULL,revision = revision + 1,updated_at = ?,revoked_at = ? WHERE id = ?",
              now,
              now,
              data.id,
            );
            this.ctx.storage.sql.exec(
              "DELETE FROM connection_policy WHERE connection_id = ?",
              data.id,
            );
          } else if (data.operation === "disable" || data.operation === "enable")
            this.ctx.storage.sql.exec(
              "UPDATE connections SET disabled = ?,revision = revision + 1,updated_at = ? WHERE id = ?",
              data.operation === "disable" ? 1 : 0,
              now,
              data.id,
            );
          else
            this.ctx.storage.sql.exec(
              "UPDATE connections SET name = ?,app_credential_ciphertext = ?,revision = revision + 1,updated_at = ? WHERE id = ?",
              data.name ?? row.name,
              ciphertext ?? row.app_credential_ciphertext,
              now,
              data.id,
            );
          const connection = this.#publicConnection(this.#requireConnection(data.id));
          if (data.operation === "revoke") this.#pruneRevokedConnections();
          return {
            connection,
            ...(token ? { executionToken: token } : {}),
          };
        }),
      );
    } catch (error) {
      return this.#safe(() => {
        throw error;
      });
    }
  }

  async #execution(token: string, revision: number) {
    const id = credentialAccountId(token);
    const hash = await tokenHash("execution", token);
    if (!id || this.#account()?.id !== id)
      throw new AccountStorageError("CONNECTION_NOT_FOUND", "This connection is unavailable.", 404);
    const row = this.ctx.storage.sql
      .exec<StoredConnection>(
        "SELECT * FROM connections WHERE execution_token_hash = ? AND status = 'active'",
        hash,
      )
      .toArray()[0];
    if (!row || row.disabled === 1)
      throw new AccountStorageError("CONNECTION_NOT_FOUND", "This connection is unavailable.", 404);
    if (row.revision !== revision)
      throw new AccountStorageError(
        "CONNECTION_CHANGED",
        "Rediscover after the connection changed.",
        409,
      );
    return { row, policy: this.#policy(row.id) };
  }

  async resolveExecution(token: string) {
    try {
      const id = credentialAccountId(token);
      if (!id) return { ok: true as const, value: null };
      const hash = await tokenHash("execution", token);
      if (this.#account()?.id !== id) return { ok: true as const, value: null };
      const row = this.ctx.storage.sql
        .exec<StoredConnection>(
          "SELECT * FROM connections WHERE execution_token_hash = ? AND status = 'active'",
          hash,
        )
        .toArray()[0];
      if (!row?.app_credential_ciphertext || row.disabled === 1)
        return { ok: true as const, value: null };
      const credential = await decryptAppCredential(
        keyring(this.env.ENCRYPTION_KEYS, this.env.ENCRYPTION_KEY_VERSION),
        id,
        row.id,
        row.app_credential_ciphertext,
      );
      return this.#safe(() => {
        const current = this.#connection(row.id);
        if (
          current?.status !== "active" ||
          current.disabled === 1 ||
          current.revision !== row.revision ||
          current.execution_token_hash !== hash
        )
          return null;
        return {
          credential,
          connectionId: row.id,
          revision: row.revision,
          policy: this.#policy(row.id),
        };
      });
    } catch (error) {
      return this.#safe(() => {
        throw error;
      });
    }
  }

  async authorizeExecution(token: string, revision: number) {
    try {
      await this.#execution(token, revision);
      return this.#safe(() => ({ authorized: true }));
    } catch (error) {
      return this.#safe(() => {
        throw error;
      });
    }
  }

  #appFailure(error: unknown, write = false): RpcError {
    if (error instanceof AppError)
      return {
        code: error.code,
        message: error.message,
        status: 400,
        details: error.details,
        mutation_sent: error.mutationSent,
      };
    if (error instanceof AccountStorageError)
      return {
        code: error.code,
        message: error.message,
        status: error.status,
        mutation_sent: false,
      };
    // An unexpected failure during a write may have happened after the
    // mutation was sent. Never report that as safely retryable.
    return write
      ? {
          code: "WRITE_UNCERTAIN",
          message: "The write outcome is uncertain. Read the current state before retrying.",
          status: 503,
          mutation_sent: "unknown",
        }
      : {
          code: "APP_UNAVAILABLE",
          message: "The application could not complete this request.",
          status: 503,
          mutation_sent: false,
        };
  }

  async appRead(
    token: string,
    revision: number,
    operationId: string,
    args: unknown,
  ): Promise<AppResult> {
    try {
      const { policy } = await this.#execution(token, revision);
      const operation = findOperation(operationId);
      if (!operation) throw new AppError("UNKNOWN_OPERATION", "Unknown operation id.");
      if (!operationAllowed(policy, operation))
        throw new AppError(
          "ACCESS_DENIED",
          "This connection does not have access to the operation.",
        );
      if (!isReadKind(operation.kind))
        throw new AppError("WRONG_EXECUTOR", "Use execute_write for this operation.");
      const parsed = operation.input.safeParse(args);
      if (!parsed.success)
        throw new AppError(
          "VALIDATION_FAILED",
          "The arguments do not match the operation schema.",
          {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path,
              message: issue.message,
              code: issue.code,
            })),
          },
        );
      return {
        ok: true,
        value: demoRead(this.ctx.storage.sql, operation, parsed.data as Record<string, unknown>),
      };
    } catch (error) {
      return { ok: false, error: this.#appFailure(error) };
    }
  }

  async appWrite(
    token: string,
    revision: number,
    operationId: string,
    args: unknown,
  ): Promise<AppResult> {
    try {
      const { policy } = await this.#execution(token, revision);
      const operation = findOperation(operationId);
      if (!operation) throw new AppError("UNKNOWN_OPERATION", "Unknown operation id.");
      if (!operationAllowed(policy, operation))
        throw new AppError(
          "ACCESS_DENIED",
          "This connection does not have access to the operation.",
        );
      if (isReadKind(operation.kind))
        throw new AppError("WRONG_EXECUTOR", "Use execute_read for this operation.");
      const parsed = operation.input.safeParse(args);
      if (!parsed.success)
        throw new AppError(
          "VALIDATION_FAILED",
          "The arguments do not match the operation schema.",
          {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path,
              message: issue.message,
              code: issue.code,
            })),
          },
        );
      return {
        ok: true,
        value: demoWrite(this.ctx.storage.sql, operation, parsed.data as Record<string, unknown>),
      };
    } catch (error) {
      return { ok: false, error: this.#appFailure(error, true) };
    }
  }
}

export { OPERATIONS };
