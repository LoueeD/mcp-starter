import { describe, expect, it } from "vitest";
import { accessPolicySchema, defaultPolicy, normalisePolicy } from "../src/accounts/access";
import { CEREMONY_MILLISECONDS, signCeremony, verifyCeremony } from "../src/accounts/ceremony";
import { sameOrigin, webAuthnContext } from "../src/accounts/config";
import {
  credentialAccountId,
  decode,
  decryptAppCredential,
  encode,
  encryptAppCredential,
  keyring,
  randomAccountId,
  randomToken,
  routedToken,
  tokenHash,
} from "../src/accounts/crypto";
import {
  catalogueVersion,
  findOperation,
  operationAllowed,
  visibleOperations,
} from "../src/app/catalogue";

const context = { origin: "http://localhost:8787", rpID: "localhost" };

function expectCode(run: () => unknown, code: string) {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected an error with code ${code}`);
}

describe("credential and token handling", () => {
  it("round-trips an app credential only for its own account, connection and key version", async () => {
    const secret = randomToken();
    const ring = keyring(JSON.stringify({ v1: secret }), "v1");
    const accountId = randomAccountId();
    const connectionId = crypto.randomUUID();
    const encrypted = await encryptAppCredential(ring, accountId, connectionId, "upstream-secret");
    expect(await decryptAppCredential(ring, accountId, connectionId, encrypted)).toBe(
      "upstream-secret",
    );

    await expect(
      decryptAppCredential(ring, randomAccountId(), connectionId, encrypted),
    ).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    await expect(
      decryptAppCredential(ring, accountId, crypto.randomUUID(), encrypted),
    ).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });

    const envelope = JSON.parse(encrypted) as {
      format: number;
      key_version: string;
      nonce: string;
      ciphertext: string;
    };
    await expect(
      decryptAppCredential(
        ring,
        accountId,
        connectionId,
        JSON.stringify({ ...envelope, key_version: "v2" }),
      ),
    ).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });

    const bytes = decode(envelope.ciphertext);
    bytes[bytes.length - 1] ^= 1;
    await expect(
      decryptAppCredential(
        ring,
        accountId,
        connectionId,
        JSON.stringify({ ...envelope, ciphertext: encode(bytes) }),
      ),
    ).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  });

  it("rejects malformed keyrings and duplicate signing/encryption keys", async () => {
    const valid = randomToken();
    expect(keyring(JSON.stringify({ v1: valid }), "v1").active).toBe("v1");
    for (const [raw, active] of [
      ["{}", "v1"],
      ["not-json", "v1"],
      [JSON.stringify({ v1: "short" }), "v1"],
      [JSON.stringify({ v1: valid }), "v2"],
      [JSON.stringify({ "bad version": valid }), "v1"],
    ] as const) {
      expectCode(() => keyring(raw, active), "ENCRYPTION_CONFIG");
    }
  });

  it("routes only well-formed connection tokens and separates hash purposes", async () => {
    const accountId = randomAccountId();
    const token = routedToken(accountId);
    expect(token).toHaveLength(108);
    expect(credentialAccountId(token)).toBe(accountId);
    expect(credentialAccountId(`${accountId}.${"A".repeat(42)}`)).toBeNull();
    expect(credentialAccountId(`${accountId}.${"!".repeat(43)}`)).toBeNull();
    expect(credentialAccountId(`${"z".repeat(64)}.${"A".repeat(43)}`)).toBeNull();
    expect(credentialAccountId("")).toBeNull();

    const execution = await tokenHash("execution", token);
    const session = await tokenHash("session", token);
    expect(execution).toMatch(/^[a-f0-9]{64}$/);
    expect(execution).not.toBe(session);
    expect(execution).toBe(await tokenHash("execution", token));
  });
});

describe("passkey ceremony cookies", () => {
  const key = randomToken();
  const now = 1_000_000;

  it("accepts an untampered ceremony exactly until expiry", async () => {
    const signed = await signCeremony(
      key,
      context,
      { purpose: "login", challenge: randomToken() },
      now,
    );
    await expect(
      verifyCeremony(key, context, signed.value, { purpose: "login" }, now + 1),
    ).resolves.toMatchObject({ purpose: "login" });
    await expect(
      verifyCeremony(
        key,
        context,
        signed.value,
        { purpose: "login" },
        now + CEREMONY_MILLISECONDS - 1,
      ),
    ).resolves.toMatchObject({ purpose: "login" });
  });

  it("rejects tampered, foreign, expired and wrong-purpose ceremonies", async () => {
    const signed = await signCeremony(
      key,
      context,
      { purpose: "login", challenge: randomToken() },
      now,
    );
    const [payload, signature] = signed.value.split(".");
    const modified = JSON.parse(new TextDecoder().decode(decode(payload))) as Record<
      string,
      unknown
    >;
    modified.challenge = randomToken();
    const tampered = `${encode(new TextEncoder().encode(JSON.stringify(modified)))}.${signature}`;

    for (const check of [
      verifyCeremony(key, context, tampered, { purpose: "login" }, now),
      verifyCeremony(key, context, signed.value, { purpose: "register" }, now),
      verifyCeremony(
        key,
        { ...context, origin: "https://foreign.example" },
        signed.value,
        { purpose: "login" },
        now,
      ),
      verifyCeremony(key, context, signed.value, { purpose: "login" }, now + CEREMONY_MILLISECONDS),
      verifyCeremony(key, context, "not-a-cookie", { purpose: "login" }, now),
    ]) {
      await expect(check).rejects.toMatchObject({ code: "AUTH_FAILED", status: 401 });
    }
  });

  it("binds add-passkey ceremonies to the account and session", async () => {
    const accountId = randomAccountId();
    const sessionHash = randomAccountId();
    const signed = await signCeremony(
      key,
      context,
      {
        purpose: "add_passkey",
        accountId,
        sessionHash,
        label: "Backup key",
        challenge: randomToken(),
      },
      now,
    );
    const expected = { purpose: "add_passkey" as const, accountId, sessionHash };
    await expect(verifyCeremony(key, context, signed.value, expected, now)).resolves.toMatchObject({
      accountId,
      sessionHash,
    });
    await expect(
      verifyCeremony(
        key,
        context,
        signed.value,
        { ...expected, accountId: randomAccountId() },
        now,
      ),
    ).rejects.toMatchObject({ code: "AUTH_FAILED", status: 401 });
  });
});

describe("origin and access policy boundaries", () => {
  it("requires the exact configured origin", () => {
    expect(webAuthnContext("localhost", "http://localhost:8787")).toEqual(context);
    for (const [rpID, origin] of [
      ["localhost", "http://127.0.0.1:8787"],
      ["example.com", "https://other.example"],
      ["example.com", "https://example.com/path"],
      ["example.com", "https://user:pass@example.com"],
      ["127.0.0.1", "http://127.0.0.1:8787"],
      ["-bad.example", "https://-bad.example"],
    ] as const) {
      expectCode(() => webAuthnContext(rpID, origin), "WEBAUTHN_CONFIG");
    }

    const ok = new Request("http://localhost:8787/api/connections", {
      headers: { Origin: context.origin, "Sec-Fetch-Site": "same-origin" },
    });
    expect(() => sameOrigin(ok, context.origin)).not.toThrow();
    const hostileHeaders: Array<Record<string, string>> = [
      {},
      { Origin: "https://foreign.example" },
      { Origin: context.origin, "Sec-Fetch-Site": "cross-site" },
    ];
    for (const headers of hostileHeaders) {
      const request = new Request("http://localhost:8787/api/connections", { headers });
      expectCode(() => sameOrigin(request, context.origin), "ORIGIN_FORBIDDEN");
    }
  });

  it("forces writes to depend on read and defaults new connections to read-only", () => {
    const policy = defaultPolicy();
    expect(policy.resources.notes).toEqual({
      read: true,
      create: false,
      update: false,
      delete: false,
    });
    expect(
      accessPolicySchema.safeParse({
        version: 1,
        resources: { notes: { read: false, create: true, update: false, delete: false } },
      }).success,
    ).toBe(false);

    const normalised = normalisePolicy({
      version: 1,
      resources: { notes: { read: false, create: true, update: true, delete: true } },
    });
    expect(normalised.resources.notes).toEqual({
      read: false,
      create: false,
      update: false,
      delete: false,
    });
  });

  it("hides operations outside the policy and keys the catalogue by its contents", async () => {
    const readOnly = defaultPolicy();
    const ids = visibleOperations(readOnly).map((operation) => operation.id);
    expect(ids.sort()).toEqual(["notes:get", "notes:list"]);
    expect(visibleOperations(null)).toEqual([]);
    const create = findOperation("notes:create");
    expect(create && operationAllowed(readOnly, create)).toBe(false);
    expect(create && operationAllowed(null, create)).toBe(false);
    expect(await catalogueVersion()).toBe(await catalogueVersion());
    expect(await catalogueVersion()).toMatch(/^[a-f0-9]{64}$/);
  });
});
