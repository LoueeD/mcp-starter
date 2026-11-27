import { z } from "zod";
import { AccountCryptoError, decode, encode } from "./crypto";
import { accountIdSchema, hashSchema } from "./model";

export const CEREMONY_COOKIE = "__Host-mcp_starter_ceremony";
export const CEREMONY_MILLISECONDS = 300_000;
const encoder = new TextEncoder();

const challengeSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => {
    try {
      return decode(value).length >= 32;
    } catch {
      return false;
    }
  });

const fields = {
  challenge: challengeSchema,
  issuedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().nonnegative().safe(),
  format: z.literal(1),
  origin: z.string().min(1).max(512),
  rpID: z.string().min(1).max(255),
};

const ceremonySchema = z.discriminatedUnion("purpose", [
  z
    .object({
      ...fields,
      purpose: z.literal("register"),
      accountId: accountIdSchema,
      label: z.string().min(1).max(50),
    })
    .strict(),
  z.object({ ...fields, purpose: z.literal("login") }).strict(),
  z
    .object({
      ...fields,
      purpose: z.literal("add_passkey"),
      accountId: accountIdSchema,
      sessionHash: hashSchema,
      label: z.string().min(1).max(50),
    })
    .strict(),
]);

export type Ceremony = z.infer<typeof ceremonySchema>;
export type CeremonyContext = { origin: string; rpID: string };
export type CeremonyInput =
  | { purpose: "register"; challenge: string; accountId: string; label: string }
  | { purpose: "login"; challenge: string }
  | {
      purpose: "add_passkey";
      challenge: string;
      accountId: string;
      sessionHash: string;
      label: string;
    };
export type CeremonyExpectation =
  | { purpose: "register" | "login" }
  | { purpose: "add_passkey"; accountId: string; sessionHash: string };

function failed(): never {
  throw new AccountCryptoError("AUTH_FAILED", "Passkey authentication failed.", 401);
}

async function hmacKey(raw: string | undefined) {
  try {
    const value = raw ?? "";
    if (value.length !== 43) throw new Error("Invalid ceremony key");
    const bytes = decode(value);
    if (bytes.length !== 32) throw new Error("Invalid ceremony key");
    return await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
  } catch {
    throw new AccountCryptoError("CEREMONY_CONFIG", "Configure a valid ceremony signing key.");
  }
}

const cookie = (value: string, seconds: number) =>
  `${CEREMONY_COOKIE}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Strict`;

export const clearCeremonyCookie = () => cookie("", 0);

export function readCeremonyCookie(header: string | undefined | null) {
  if (!header || header.length > 8192) return null;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${CEREMONY_COOKIE}=`));
  return matches.length === 1 ? matches[0].slice(CEREMONY_COOKIE.length + 1) : null;
}

export async function signCeremony(
  rawKey: string | undefined,
  context: CeremonyContext,
  input: CeremonyInput,
  now = Date.now(),
) {
  const key = await hmacKey(rawKey);
  const ceremony = ceremonySchema.parse({
    ...input,
    origin: context.origin,
    rpID: context.rpID,
    format: 1,
    issuedAt: now,
    expiresAt: now + CEREMONY_MILLISECONDS,
  });
  const payload = encode(encoder.encode(JSON.stringify(ceremony)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`mcp-starter:ceremony:1:${payload}`),
  );
  const value = `${payload}.${encode(new Uint8Array(signature))}`;
  if (value.length > 2048)
    throw new AccountCryptoError("INVALID_CEREMONY", "The passkey ceremony is too large.", 400);
  return { ceremony, value, cookie: cookie(value, CEREMONY_MILLISECONDS / 1000) };
}

export async function verifyCeremony(
  rawKey: string | undefined,
  context: CeremonyContext,
  value: string | null | undefined,
  expected: CeremonyExpectation,
  now = Date.now(),
): Promise<Ceremony> {
  const key = await hmacKey(rawKey);
  try {
    if (!value || value.length > 2048) return failed();
    const parts = value.split(".");
    if (parts.length !== 2) return failed();
    const [payload, encodedSignature] = parts;
    const signature = decode(encodedSignature);
    if (
      signature.length !== 32 ||
      !(await crypto.subtle.verify(
        "HMAC",
        key,
        signature,
        encoder.encode(`mcp-starter:ceremony:1:${payload}`),
      ))
    )
      return failed();
    const ceremony = ceremonySchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(decode(payload)),
      ),
    );
    if (
      ceremony.purpose !== expected.purpose ||
      ceremony.origin !== context.origin ||
      ceremony.rpID !== context.rpID ||
      ceremony.issuedAt > now ||
      ceremony.expiresAt <= now ||
      ceremony.expiresAt - ceremony.issuedAt !== CEREMONY_MILLISECONDS
    )
      return failed();
    if (expected.purpose === "add_passkey") {
      if (
        ceremony.purpose !== "add_passkey" ||
        ceremony.accountId !== expected.accountId ||
        !hashSchema.safeParse(expected.sessionHash).success ||
        !crypto.subtle.timingSafeEqual(
          encoder.encode(ceremony.sessionHash),
          encoder.encode(expected.sessionHash),
        )
      )
        return failed();
    }
    return ceremony;
  } catch {
    return failed();
  }
}
