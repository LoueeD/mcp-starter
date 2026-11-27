import { z } from "zod";

export class AccountCryptoError extends Error {
  code: string;
  status: 400 | 401 | 503;
  constructor(code: string, message: string, status: 400 | 401 | 503 = 503) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const versionSchema = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);

export function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoding");
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
    char.charCodeAt(0),
  );
  if (encode(bytes) !== value) throw new Error("Noncanonical encoding");
  return bytes;
}

/** Parse a versioned AES-GCM keyring from a Worker secret. */
export function keyring(raw: string | undefined, active: string | undefined) {
  try {
    if (!raw || raw.length > 8192) throw new Error("Invalid keyring size");
    const values = z.record(versionSchema, z.string().max(64)).parse(JSON.parse(raw));
    const current = versionSchema.parse(active);
    if (!Object.hasOwn(values, current) || Object.keys(values).length > 10)
      throw new Error("Missing active key");
    const keys = Object.fromEntries(
      Object.entries(values).map(([version, value]) => {
        const bytes = decode(value);
        if (bytes.length !== 32) throw new Error("Invalid key size");
        return [version, bytes];
      }),
    );
    return { active: current, keys };
  } catch {
    throw new AccountCryptoError(
      "ENCRYPTION_CONFIG",
      "Configure a valid versioned encryption keyring.",
    );
  }
}
export type Keyring = ReturnType<typeof keyring>;
