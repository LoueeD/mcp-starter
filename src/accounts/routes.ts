import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  type CeremonyContext,
  clearCeremonyCookie,
  readCeremonyCookie,
  signCeremony,
  verifyCeremony,
} from "./ceremony";
import {
  AccountConfigError,
  accountConfiguration,
  limitAuthentication,
  sameOrigin,
} from "./config";
import {
  AccountCryptoError,
  credentialAccountId,
  decode,
  randomAccountId,
  routedToken,
  tokenHash,
} from "./crypto";
import {
  AccountStorageError,
  accountIdSchema,
  credentialIdSchema,
  hashSchema,
  MAX_PASSKEYS,
} from "./model";
import type { AccountStore } from "./object";
import { clearSessionCookie, readSessionCookie, sessionCookie } from "./session";

type App = { Bindings: CloudflareBindings };
type Ctx = Context<App>;

const fail = (): never => {
  throw new AccountStorageError("AUTH_FAILED", "Passkey authentication failed.", 401);
};

export function unwrap<T>(result: {
  ok: boolean;
  value?: T;
  error?: {
    code: string;
    message: string;
    status: 400 | 401 | 403 | 404 | 409 | 503;
    details?: Record<string, unknown>;
  };
}) {
  if (!result.ok) {
    const error = result.error;
    throw new AccountStorageError(
      error?.code ?? "STORAGE_UNAVAILABLE",
      error?.message ?? "Account storage could not complete this request.",
      error?.status ?? 503,
    );
  }
  return result.value as T;
}

const labelSchema = z.object({ label: z.string().trim().max(50).optional() }).strict();

export async function json(c: Ctx) {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("Content-Type") ?? "")) {
    throw new AccountStorageError("INVALID_ARGUMENTS", "Use a JSON request body.", 400);
  }
  return c.req.json().catch(() => null);
}

async function label(c: Ctx, fallback: string) {
  const result = labelSchema.safeParse(await json(c));
  if (!result.success)
    throw new AccountStorageError(
      "INVALID_ARGUMENTS",
      "Supply an optional label of up to 50 characters.",
      400,
    );
  return result.data.label || fallback;
}

// Bound and select the WebAuthn response before the library verifies its full
// structure. No client key is trusted.
function responseShape(
  value: unknown,
): value is RegistrationResponseJSON | AuthenticationResponseJSON {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (
    !credentialIdSchema.safeParse(v.id).success ||
    v.id !== v.rawId ||
    v.type !== "public-key" ||
    !v.response ||
    typeof v.response !== "object" ||
    !v.clientExtensionResults ||
    typeof v.clientExtensionResults !== "object"
  )
    return false;
  const response = v.response as Record<string, unknown>;
  return typeof response.clientDataJSON === "string" && response.clientDataJSON.length <= 8192;
}

const registrationBody = z
  .object({
    response: z.custom<RegistrationResponseJSON>(
      (value) =>
        responseShape(value) &&
        "attestationObject" in value.response &&
        typeof value.response.attestationObject === "string",
    ),
  })
  .strict();

const loginBody = z
  .object({
    response: z.custom<AuthenticationResponseJSON>(
      (value) =>
        responseShape(value) &&
        "signature" in value.response &&
        typeof value.response.signature === "string",
    ),
  })
  .strict();

function sameFrame(response: RegistrationResponseJSON | AuthenticationResponseJSON) {
  try {
    const client = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        decode(response.response.clientDataJSON),
      ),
    );
    if (
      !client ||
      typeof client !== "object" ||
      (client.crossOrigin !== undefined && client.crossOrigin !== false) ||
      client.topOrigin !== undefined
    )
      return fail();
  } catch {
    return fail();
  }
}

async function verifiedRegistration(
  response: RegistrationResponseJSON,
  challenge: string,
  context: CeremonyContext,
  keyLabel: string,
) {
  try {
    sameFrame(response);
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: context.origin,
      expectedRPID: context.rpID,
      requireUserVerification: true,
      requireUserPresence: true,
      supportedAlgorithmIDs: [-7, -257],
    });
    if (!result.verified) return fail();
    const info = result.registrationInfo;
    return {
      id: info.credential.id,
      publicKey: info.credential.publicKey,
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      label: keyLabel,
    };
  } catch {
    return fail();
  }
}

export function sessionAccess(
  c: Ctx,
  mutation: true,
): { accountId: string; sessionToken: string; csrf: string };
export function sessionAccess(
  c: Ctx,
  mutation?: false,
): { accountId: string; sessionToken: string; csrf?: undefined };
export function sessionAccess(c: Ctx, mutation = false) {
  const sessionToken = readSessionCookie(c.req.header("Cookie"));
  const accountId = sessionToken && credentialAccountId(sessionToken);
  if (!sessionToken || !accountId) return fail();
  if (mutation) {
    const csrf = c.req.header("X-CSRF-Token");
    if (!csrf || !hashSchema.safeParse(csrf).success)
      throw new AccountStorageError("CSRF", "The account CSRF token is invalid.", 403);
    return { accountId, sessionToken, csrf };
  }
  return { accountId, sessionToken };
}

/**
 * Durable Object stubs erase generic return types and add `& Disposable` to
 * objects. Casting to the class type restores the real method signatures for
 * the Worker's own call sites.
 */
export function accountStore(env: CloudflareBindings, accountId: string) {
  return env.ACCOUNTS.getByName(accountId) as unknown as AccountStore;
}

const store = (c: Ctx, accountId: string) => accountStore(c.env, accountId);

async function registrationOptions(
  accountId: string,
  accountLabel: string,
  context: CeremonyContext,
  rpName: string,
  excluded: { id: string }[] = [],
) {
  return generateRegistrationOptions({
    rpName,
    rpID: context.rpID,
    userName: accountId,
    userDisplayName: accountLabel,
    userID: Uint8Array.from(
      (accountId.match(/../g) ?? []).map((byte) => Number.parseInt(byte, 16)),
    ),
    attestationType: "none",
    supportedAlgorithmIDs: [-7, -257],
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    excludeCredentials: excluded,
    timeout: 300_000,
  });
}

async function authGuard(c: Ctx) {
  const config = accountConfiguration(c.env);
  sameOrigin(c.req.raw, config.origin);
  await limitAuthentication(c.req.raw, config, c.env.AUTH_LIMITER);
  return config;
}

export const accountsRoutes = new Hono<App>();

const headers = async (c: Ctx, next: () => Promise<void>) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Vary", "Cookie");
  await next();
};

for (const path of ["/auth/*", "/passkeys", "/passkeys/*"]) {
  accountsRoutes.use(path, headers);
  accountsRoutes.use(
    path,
    bodyLimit({
      maxSize: 16_384,
      onError: (c) =>
        c.json({ error: { code: "REQUEST_TOO_LARGE", message: "Request too large." } }, 413),
    }),
  );
  accountsRoutes.use(path, async (c, next) => {
    const config = accountConfiguration(c.env);
    if (c.req.method !== "GET") sameOrigin(c.req.raw, config.origin);
    else if (
      (c.req.header("Origin") && c.req.header("Origin") !== config.origin) ||
      (c.req.header("Sec-Fetch-Site") && c.req.header("Sec-Fetch-Site") !== "same-origin")
    ) {
      throw new AccountConfigError(
        "ORIGIN_FORBIDDEN",
        "Use the configured application origin.",
        403,
      );
    }
    await next();
  });
}

accountsRoutes.onError((error, c) => {
  if (
    error instanceof AccountConfigError ||
    error instanceof AccountCryptoError ||
    error instanceof AccountStorageError
  ) {
    if (error.status === 429) c.header("Retry-After", "60");
    return c.json({ error: { code: error.code, message: error.message } }, error.status);
  }
  return c.json(
    {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "The account request could not be completed.",
      },
    },
    503,
  );
});

accountsRoutes.post("/auth/register/options", async (c) => {
  const config = await authGuard(c);
  const accountLabel = await label(c, "My account");
  const accountId = randomAccountId();
  const options = await registrationOptions(
    accountId,
    accountLabel,
    config,
    c.env.APP_NAME || "MCP Starter",
  );
  const signed = await signCeremony(config.signingKey, config, {
    purpose: "register",
    accountId,
    label: accountLabel,
    challenge: options.challenge,
  });
  c.header("Set-Cookie", signed.cookie, { append: true });
  return c.json(options);
});

accountsRoutes.post("/auth/register/verify", async (c) => {
  const config = await authGuard(c);
  c.header("Set-Cookie", clearCeremonyCookie(), { append: true });
  const ceremony = await verifyCeremony(
    config.signingKey,
    config,
    readCeremonyCookie(c.req.header("Cookie")),
    { purpose: "register" },
  );
  if (ceremony.purpose !== "register") return fail();
  const parsed = registrationBody.safeParse(await json(c));
  if (!parsed.success) return fail();
  const passkey = await verifiedRegistration(
    parsed.data.response,
    ceremony.challenge,
    config,
    "Passkey",
  );
  const token = routedToken(ceremony.accountId);
  const result = unwrap(
    await store(c, ceremony.accountId).register({
      accountId: ceremony.accountId,
      label: ceremony.label,
      passkey,
      sessionHash: await tokenHash("session", token),
      challengeHash: await tokenHash("challenge", ceremony.challenge),
      challengeExpiresAt: ceremony.expiresAt,
    }),
  );
  c.header("Set-Cookie", sessionCookie(token), { append: true });
  return c.json(
    {
      authenticated: true,
      account: result.account,
      expires_at: result.sessionExpiresAt,
      passkey_count: 1,
      csrf_token: await tokenHash("csrf", token),
    },
    201,
  );
});

accountsRoutes.post("/auth/login/options", async (c) => {
  const config = await authGuard(c);
  const body = z
    .object({})
    .strict()
    .safeParse(await json(c));
  if (!body.success)
    throw new AccountStorageError("INVALID_ARGUMENTS", "Use an empty JSON object.", 400);
  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    userVerification: "required",
    allowCredentials: [],
    timeout: 300_000,
  });
  const signed = await signCeremony(config.signingKey, config, {
    purpose: "login",
    challenge: options.challenge,
  });
  c.header("Set-Cookie", signed.cookie, { append: true });
  return c.json(options);
});

accountsRoutes.post("/auth/login/verify", async (c) => {
  const config = await authGuard(c);
  c.header("Set-Cookie", clearCeremonyCookie(), { append: true });
  const ceremony = await verifyCeremony(
    config.signingKey,
    config,
    readCeremonyCookie(c.req.header("Cookie")),
    { purpose: "login" },
  );
  const parsed = loginBody.safeParse(await json(c));
  if (!parsed.success) return fail();
  const response = parsed.data.response;
  let accountId: string;
  try {
    const bytes = decode(response.response.userHandle ?? "");
    if (bytes.length !== 32) return fail();
    accountId = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    accountIdSchema.parse(accountId);
  } catch {
    return fail();
  }
  const object = store(c, accountId);
  const credential = unwrap(await object.getPasskey(accountId, response.id));
  if (!credential) return fail();
  let info: Awaited<ReturnType<typeof verifyAuthenticationResponse>>["authenticationInfo"];
  try {
    sameFrame(response);
    const verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      credential: {
        id: credential.id,
        publicKey: new Uint8Array(credential.publicKey),
        counter: credential.counter,
      },
      requireUserVerification: true,
    });
    if (!verified.verified) return fail();
    info = verified.authenticationInfo;
  } catch {
    return fail();
  }
  const token = routedToken(accountId);
  const result = unwrap(
    await object.commitAuthentication({
      accountId,
      credentialId: credential.id,
      previousCounter: credential.counter,
      newCounter: info.newCounter,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      challengeHash: await tokenHash("challenge", ceremony.challenge),
      challengeExpiresAt: ceremony.expiresAt,
      sessionHash: await tokenHash("session", token),
    }),
  );
  c.header("Set-Cookie", sessionCookie(token), { append: true });
  return c.json({
    authenticated: true,
    account: result.account,
    expires_at: result.sessionExpiresAt,
    csrf_token: await tokenHash("csrf", token),
  });
});

accountsRoutes.get("/auth/session", async (c) => {
  if (!readSessionCookie(c.req.header("Cookie"))) {
    c.header("Set-Cookie", clearSessionCookie(), { append: true });
    return c.json({ authenticated: false });
  }
  const access = sessionAccess(c);
  const result = await store(c, access.accountId).sessionSummary(access);
  if (!result.ok && result.error?.code === "AUTH_FAILED") {
    c.header("Set-Cookie", clearSessionCookie(), { append: true });
    return c.json({ authenticated: false });
  }
  const value = unwrap(result);
  return c.json({
    authenticated: true,
    account: value.account,
    expires_at: value.expiresAt,
    passkey_count: value.passkeyCount,
    csrf_token: await tokenHash("csrf", access.sessionToken),
  });
});

accountsRoutes.delete("/auth/session", async (c) => {
  const access = sessionAccess(c, true);
  unwrap(await store(c, access.accountId).signOut(access));
  c.header("Set-Cookie", clearSessionCookie(), { append: true });
  c.header("Set-Cookie", clearCeremonyCookie(), { append: true });
  return c.json({ signed_out: true });
});

accountsRoutes.get("/passkeys", async (c) => {
  const access = sessionAccess(c);
  return c.json({ passkeys: unwrap(await store(c, access.accountId).listPasskeys(access)) });
});

accountsRoutes.post("/passkeys/options", async (c) => {
  const config = await authGuard(c);
  const access = sessionAccess(c, true);
  const object = store(c, access.accountId);
  const summary = unwrap(await object.sessionSummary(access));
  const keys = unwrap(await object.listPasskeys(access));
  if (keys.length >= MAX_PASSKEYS)
    throw new AccountStorageError(
      "PASSKEY_LIMIT",
      "This account has reached its passkey limit.",
      409,
    );
  const keyLabel = await label(c, "Passkey");
  const options = await registrationOptions(
    access.accountId,
    summary.account.label,
    config,
    c.env.APP_NAME || "MCP Starter",
    keys.map((key) => ({ id: key.id })),
  );
  const signed = await signCeremony(config.signingKey, config, {
    purpose: "add_passkey",
    accountId: access.accountId,
    sessionHash: await tokenHash("session", access.sessionToken),
    label: keyLabel,
    challenge: options.challenge,
  });
  c.header("Set-Cookie", signed.cookie, { append: true });
  return c.json(options);
});

accountsRoutes.post("/passkeys/verify", async (c) => {
  const config = await authGuard(c);
  const access = sessionAccess(c, true);
  c.header("Set-Cookie", clearCeremonyCookie(), { append: true });
  const ceremony = await verifyCeremony(
    config.signingKey,
    config,
    readCeremonyCookie(c.req.header("Cookie")),
    {
      purpose: "add_passkey",
      accountId: access.accountId,
      sessionHash: await tokenHash("session", access.sessionToken),
    },
  );
  if (ceremony.purpose !== "add_passkey") return fail();
  const parsed = registrationBody.safeParse(await json(c));
  if (!parsed.success) return fail();
  const passkey = await verifiedRegistration(
    parsed.data.response,
    ceremony.challenge,
    config,
    ceremony.label,
  );
  const result = unwrap(
    await store(c, access.accountId).addPasskey({
      ...access,
      passkey,
      challengeHash: await tokenHash("challenge", ceremony.challenge),
      challengeExpiresAt: ceremony.expiresAt,
    }),
  );
  return c.json({ added: result.added, passkey_count: result.passkeyCount }, 201);
});

accountsRoutes.delete("/passkeys/:id", async (c) => {
  const access = sessionAccess(c, true);
  const id = credentialIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return fail();
  unwrap(
    await store(c, access.accountId).removePasskey({
      ...access,
      credentialId: id.data,
    }),
  );
  c.header("Set-Cookie", clearSessionCookie(), { append: true });
  c.header("Set-Cookie", clearCeremonyCookie(), { append: true });
  return c.json({ removed: true, sessions_invalidated: true });
});
