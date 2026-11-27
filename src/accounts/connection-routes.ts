import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { RESOURCES } from "../app/catalogue";
import { validateDemoCredential } from "../app/demo";
import { AppError } from "../app/errors";
import { accessPolicySchema } from "./access";
import { AccountConfigError, accountConfiguration, sameOrigin } from "./config";
import { appCredentialSchema, connectionNameSchema, revisionSchema } from "./connections";
import { AccountCryptoError, connectionIdSchema, tokenHash } from "./crypto";
import { AccountStorageError } from "./model";
import { accountStore, json, sessionAccess, unwrap } from "./routes";

const createSchema = z
  .object({
    name: connectionNameSchema.default("My connection"),
    credential: appCredentialSchema,
  })
  .strict();

const revisionBody = z.object({ revision: revisionSchema }).strict();

const updateSchema = z
  .object({
    revision: revisionSchema,
    name: connectionNameSchema.optional(),
    credential: appCredentialSchema.optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.credential !== undefined);

const accessBody = z
  .object({
    revision: revisionSchema,
    policy: accessPolicySchema,
  })
  .strict();

/**
 * All connection management requires an account session and CSRF token for
 * mutations. The MCP URL itself is separate from this browser session.
 */
export const accountConnectionRoutes = new Hono<{ Bindings: CloudflareBindings }>().basePath(
  "/api",
);

accountConnectionRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Vary", "Cookie");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  const config = accountConfiguration(c.env);
  if (c.req.method !== "GET") sameOrigin(c.req.raw, config.origin);
  else if (
    (c.req.header("Origin") && c.req.header("Origin") !== config.origin) ||
    (c.req.header("Sec-Fetch-Site") && c.req.header("Sec-Fetch-Site") !== "same-origin")
  )
    throw new AccountConfigError("ORIGIN_FORBIDDEN", "Use the configured application origin.", 403);
  await next();
});

accountConnectionRoutes.use("*", async (c, next) =>
  bodyLimit({
    maxSize: 65_536,
    onError: (c) =>
      c.json({ error: { code: "REQUEST_TOO_LARGE", message: "Request too large." } }, 413),
  })(c, next),
);

accountConnectionRoutes.onError((error, c) => {
  if (
    error instanceof AccountStorageError ||
    error instanceof AccountCryptoError ||
    error instanceof AccountConfigError
  ) {
    if (error.status === 429) c.header("Retry-After", "60");
    return c.json({ error: { code: error.code, message: error.message } }, error.status);
  }
  if (error instanceof AppError)
    return c.json({ error: { code: error.code, message: error.message, ...error.details } }, 400);
  return c.json(
    {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "The connection request could not be completed.",
      },
    },
    503,
  );
});

function connectionId(id: string) {
  const parsed = connectionIdSchema.safeParse(id);
  if (!parsed.success)
    throw new AccountStorageError("CONNECTION_NOT_FOUND", "This connection is unavailable.", 404);
  return parsed.data;
}

accountConnectionRoutes.get("/connections", async (c) => {
  const access = sessionAccess(c);
  const parsed = z
    .object({
      limit: z.coerce.number().int().min(1).max(50).optional(),
      cursor: z.string().max(512).optional(),
    })
    .strict()
    .safeParse(c.req.query());
  if (!parsed.success)
    throw new AccountStorageError(
      "INVALID_ARGUMENTS",
      "Supply bounded connection pagination.",
      400,
    );
  return c.json(
    unwrap(
      await accountStore(c.env, access.accountId).listConnections({
        ...access,
        ...parsed.data,
      }),
    ),
  );
});

accountConnectionRoutes.post("/connections", async (c) => {
  const access = sessionAccess(c, true);
  const object = accountStore(c.env, access.accountId);
  unwrap(await object.sessionSummary(access));
  const input = createSchema.safeParse(await json(c));
  if (!input.success)
    throw new AccountStorageError("INVALID_ARGUMENTS", "Supply a name and app credential.", 400);
  let allowed: RateLimitOutcome;
  try {
    allowed = await c.env.PROVISIONING_LIMITER.limit({
      key: await tokenHash("rate", `provision:${access.accountId}`),
    });
  } catch {
    throw new AccountConfigError(
      "RATE_LIMIT_UNAVAILABLE",
      "Connection creation rate limiting is unavailable.",
    );
  }
  if (typeof allowed?.success !== "boolean")
    throw new AccountConfigError(
      "RATE_LIMIT_UNAVAILABLE",
      "Connection creation rate limiting is unavailable.",
    );
  if (!allowed.success)
    throw new AccountConfigError(
      "RATE_LIMITED",
      "Too many connection creation requests. Try again shortly.",
      429,
    );
  validateDemoCredential(input.data.credential);
  const result = unwrap(
    await object.createConnection({
      ...access,
      name: input.data.name,
      credential: input.data.credential,
    }),
  );
  return c.json(
    {
      connection: result.connection,
      install_url: `${accountConfiguration(c.env).origin}/mcp/${result.executionToken}`,
    },
    201,
  );
});

accountConnectionRoutes.patch("/connections/:id", async (c) => {
  const access = sessionAccess(c, true);
  const id = connectionId(c.req.param("id") ?? "");
  const input = updateSchema.safeParse(await json(c));
  if (!input.success)
    throw new AccountStorageError(
      "INVALID_ARGUMENTS",
      "Supply a revision and a name or app credential.",
      400,
    );
  const object = accountStore(c.env, access.accountId);
  unwrap(await object.getConnection({ ...access, id, revision: input.data.revision }));
  if (input.data.credential !== undefined) validateDemoCredential(input.data.credential);
  const result = unwrap(
    await object.changeConnection({
      ...access,
      id,
      revision: input.data.revision,
      operation: "update",
      name: input.data.name,
      credential: input.data.credential,
    }),
  );
  return c.json({ connection: result.connection });
});

for (const operation of ["rotate", "revoke", "disable", "enable"] as const) {
  const handler = async (c: Parameters<typeof sessionAccess>[0]) => {
    const access = sessionAccess(c, true);
    const id = connectionId(c.req.param("id") ?? "");
    const input = revisionBody.safeParse(await json(c));
    if (!input.success)
      throw new AccountStorageError(
        "INVALID_ARGUMENTS",
        "Supply the current connection revision.",
        400,
      );
    const result = unwrap(
      await accountStore(c.env, access.accountId).changeConnection({
        ...access,
        id,
        revision: input.data.revision,
        operation,
      }),
    );
    return c.json({
      connection: result.connection,
      ...(result.executionToken
        ? { install_url: `${accountConfiguration(c.env).origin}/mcp/${result.executionToken}` }
        : {}),
    });
  };
  if (operation !== "revoke")
    accountConnectionRoutes.post(`/connections/:id/${operation}`, handler);
  else accountConnectionRoutes.delete("/connections/:id", handler);
}

accountConnectionRoutes.get("/connections/:id/access", async (c) => {
  const access = sessionAccess(c);
  const id = connectionId(c.req.param("id") ?? "");
  const owned = unwrap(await accountStore(c.env, access.accountId).ownerAccess({ ...access, id }));
  return c.json({
    connection: owned.connection,
    policy: owned.policy,
    resources: RESOURCES,
  });
});

accountConnectionRoutes.put("/connections/:id/access", async (c) => {
  const access = sessionAccess(c, true);
  const id = connectionId(c.req.param("id") ?? "");
  const input = accessBody.safeParse(await json(c));
  if (!input.success)
    throw new AccountStorageError(
      "INVALID_ARGUMENTS",
      "Supply the current revision and access policy.",
      400,
    );
  const connection = unwrap(
    await accountStore(c.env, access.accountId).saveAccessPolicy({
      ...access,
      id,
      revision: input.data.revision,
      policy: input.data.policy,
    }),
  );
  return c.json({ connection });
});
