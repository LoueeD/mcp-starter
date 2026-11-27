import { z } from "zod";
import { AccountCryptoError, decode, encode, type Keyring, versionSchema } from "./keyring";
import { accountIdSchema } from "./model";

export {
  AccountCryptoError,
  decode,
  encode,
  type Keyring,
  keyring,
  versionSchema,
} from "./keyring";

const encoder = new TextEncoder();

export const connectionIdSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/);

export const randomToken = () => encode(crypto.getRandomValues(new Uint8Array(32)));

export const randomAccountId = () =>
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/**
 * A connection token starts with the account id so the Worker can route to the
 * right Durable Object without a global index. The rest is 256 bits of random.
 */
export function routedToken(accountId: string) {
  return `${accountIdSchema.parse(accountId)}.${randomToken()}`;
}

export function credentialAccountId(token: string) {
  if (typeof token !== "string" || token.length !== 108) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [id, random] = parts;
  try {
    return accountIdSchema.safeParse(id).success && decode(random).length === 32 ? id : null;
  } catch {
    return null;
  }
}

export async function tokenHash(
  purpose: "execution" | "session" | "csrf" | "challenge" | "rate",
  value: string,
) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`mcp-starter:${purpose}:${value}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const envelopeSchema = z
  .object({
    format: z.literal(2),
    key_version: versionSchema,
    nonce: z.string().max(24),
    ciphertext: z.string().max(24_000),
  })
  .strict();

const aad = (accountId: string, connectionId: string, version: string) =>
  encoder.encode(
    JSON.stringify([
      "mcp-starter",
      2,
      accountIdSchema.parse(accountId),
      connectionIdSchema.parse(connectionId),
      "app_credential",
      version,
    ]),
  );

export async function encryptAppCredential(
  ring: Keyring,
  accountId: string,
  connectionId: string,
  value: string,
) {
  const plaintext = encoder.encode(value);
  if (!plaintext.length || plaintext.byteLength > 8192)
    throw new AccountCryptoError("INVALID_CREDENTIAL", "Invalid app credential size.", 400);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", ring.keys[ring.active], "AES-GCM", false, [
    "encrypt",
  ]);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: aad(accountId, connectionId, ring.active),
      tagLength: 128,
    },
    key,
    plaintext,
  );
  return JSON.stringify({
    format: 2,
    key_version: ring.active,
    nonce: encode(nonce),
    ciphertext: encode(new Uint8Array(ciphertext)),
  });
}

export async function decryptAppCredential(
  ring: Keyring,
  accountId: string,
  connectionId: string,
  raw: string,
) {
  try {
    if (raw.length > 24_256) throw new Error("Oversized envelope");
    const envelope = envelopeSchema.parse(JSON.parse(raw));
    if (!Object.hasOwn(ring.keys, envelope.key_version)) throw new Error("Unknown key");
    const nonce = decode(envelope.nonce);
    const ciphertext = decode(envelope.ciphertext);
    if (nonce.length !== 12 || ciphertext.length < 17 || ciphertext.length > 8208)
      throw new Error("Invalid envelope size");
    const key = await crypto.subtle.importKey(
      "raw",
      ring.keys[envelope.key_version],
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: aad(accountId, connectionId, envelope.key_version),
        tagLength: 128,
      },
      key,
      ciphertext,
    );
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plaintext);
  } catch {
    throw new AccountCryptoError(
      "CREDENTIAL_UNAVAILABLE",
      "The app credential could not be decrypted.",
    );
  }
}
