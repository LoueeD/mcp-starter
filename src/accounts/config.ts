import { AccountCryptoError, decode, encode, keyring, tokenHash } from "./crypto";

export class AccountConfigError extends Error {
  code: string;
  status: 403 | 429 | 503;
  constructor(code: string, message: string, status: 403 | 429 | 503 = 503) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function webAuthnContext(rpID: string | undefined, rawOrigin: string | undefined) {
  try {
    if (!rpID || !rawOrigin || rpID.length > 253 || rawOrigin.length > 512)
      throw new Error("Missing context");
    if (
      rpID !== "localhost" &&
      (!rpID.includes(".") ||
        !rpID.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
    )
      throw new Error("Invalid hostname");
    const origin = new URL(rawOrigin);
    if (
      origin.origin !== rawOrigin ||
      origin.hostname !== rpID ||
      origin.username ||
      origin.password ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" && rpID === "localhost")) ||
      /^\d+(?:\.\d+){3}$/.test(rpID)
    )
      throw new Error("Invalid origin");
    return { rpID, origin: rawOrigin };
  } catch {
    throw new AccountConfigError(
      "WEBAUTHN_CONFIG",
      "Configure the exact WebAuthn hostname and origin.",
    );
  }
}

export function ceremonyKey(raw: string | undefined) {
  try {
    const value = raw ?? "";
    if (value.length !== 43 || decode(value).length !== 32) throw new Error("Invalid signing key");
    return value;
  } catch {
    throw new AccountCryptoError("CEREMONY_CONFIG", "Configure a valid ceremony signing key.");
  }
}

export function accountConfiguration(
  env: Pick<
    CloudflareBindings,
    | "WEBAUTHN_RP_ID"
    | "WEBAUTHN_ORIGIN"
    | "CEREMONY_KEY"
    | "ENCRYPTION_KEYS"
    | "ENCRYPTION_KEY_VERSION"
    | "AUTH_LIMITER"
    | "PROVISIONING_LIMITER"
  >,
) {
  const context = webAuthnContext(env.WEBAUTHN_RP_ID, env.WEBAUTHN_ORIGIN);
  const signingKey = ceremonyKey(env.CEREMONY_KEY);
  const ring = keyring(env.ENCRYPTION_KEYS, env.ENCRYPTION_KEY_VERSION);
  if (Object.values(ring.keys).some((bytes) => encode(bytes) === signingKey))
    throw new AccountConfigError("SECRET_CONFIG", "Use independent signing and encryption keys.");
  if (
    typeof env.AUTH_LIMITER?.limit !== "function" ||
    typeof env.PROVISIONING_LIMITER?.limit !== "function"
  ) {
    throw new AccountConfigError("RATE_LIMIT_CONFIG", "Configure account rate-limit bindings.");
  }
  return { ...context, signingKey, ring };
}

export function sameOrigin(request: Request, origin: string) {
  const site = request.headers.get("Sec-Fetch-Site");
  if (request.headers.get("Origin") !== origin || (site !== null && site !== "same-origin")) {
    throw new AccountConfigError("ORIGIN_FORBIDDEN", "Use the configured application origin.", 403);
  }
}

export async function limitAuthentication(
  request: Request,
  context: { origin: string; rpID: string },
  limiter: RateLimit | undefined,
) {
  if (typeof limiter?.limit !== "function")
    throw new AccountConfigError("RATE_LIMIT_CONFIG", "Configure authentication rate limiting.");
  // Only Cloudflare's platform header supplies the hosted address.
  let address = request.headers.get("CF-Connecting-IP");
  const localFallback =
    !address && context.rpID === "localhost" && new URL(request.url).hostname === "localhost";
  if (localFallback) address = "local";
  if (!address || address.length > 64 || (!/^[0-9a-fA-F:.]+$/.test(address) && !localFallback)) {
    throw new AccountConfigError(
      "CLIENT_ADDRESS_UNAVAILABLE",
      "The client address is unavailable.",
    );
  }
  try {
    const result = await limiter.limit({
      key: await tokenHash("rate", `auth:${context.origin}:${address}`),
    });
    if (typeof result?.success !== "boolean")
      throw new AccountConfigError(
        "RATE_LIMIT_UNAVAILABLE",
        "Authentication rate limiting is unavailable.",
      );
    if (!result.success)
      throw new AccountConfigError(
        "RATE_LIMITED",
        "Too many passkey requests. Try again shortly.",
        429,
      );
  } catch (error) {
    if (error instanceof AccountConfigError) throw error;
    throw new AccountConfigError(
      "RATE_LIMIT_UNAVAILABLE",
      "Authentication rate limiting is unavailable.",
    );
  }
}
