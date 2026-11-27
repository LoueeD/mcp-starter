import { createMcpHandler } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { accountConfiguration } from "./accounts/config";
import { accountConnectionRoutes } from "./accounts/connection-routes";
import { credentialAccountId } from "./accounts/crypto";
import { AccountStorageError } from "./accounts/model";
import { accountStore, accountsRoutes, unwrap } from "./accounts/routes";
import { publicCatalogue } from "./app/catalogue";
import { AppError } from "./app/errors";
import type { AppSource } from "./app/types";
import { createMcpServer } from "./mcp/server";

export { AccountStore } from "./accounts/object";

const app = new Hono<{ Bindings: CloudflareBindings }>();

for (const path of ["/", "/login", "/signup", "/how-it-works", "/connections/:id/access"]) {
  app.get(path, async (c) => {
    const assetUrl = new URL(c.req.url);
    assetUrl.pathname = c.req.path === "/how-it-works" ? "/how-it-works" : "/";
    const response = await c.env.ASSETS.fetch(new Request(assetUrl, c.req.raw));
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    headers.set("X-Frame-Options", "DENY");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  });
}

app.get("/health", (c) => {
  try {
    accountConfiguration(c.env);
  } catch {
    return c.json(
      {
        status: "unconfigured",
        app: "mcp-starter",
        backend: "durable-objects",
        message: "Check the Worker secrets and WebAuthn variables.",
      },
      503,
    );
  }
  return c.json({
    status: "ok",
    app: "mcp-starter",
    backend: "durable-objects",
    version: "0.1.0",
  });
});

app.route("/api", accountsRoutes);
for (const path of ["/api/connections", "/api/connections/*"]) {
  app.all(path, (c) => accountConnectionRoutes.fetch(c.req.raw, c.env, c.executionCtx));
}

app.onError((error, c) =>
  c.json(
    {
      error:
        error instanceof AccountStorageError
          ? { code: error.code, message: error.message }
          : { code: "SERVICE_UNAVAILABLE", message: "The request could not be completed." },
    },
    error instanceof AccountStorageError ? error.status : 503,
  ),
);

app.use("/mcp/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});

app.use(
  "/mcp/*",
  bodyLimit({ maxSize: 65_536, onError: (c) => c.json({ error: "Request too large." }, 413) }),
);

/**
 * The URL itself is the bearer credential. The account id prefix lets us route
 * to a Durable Object; only a hash of the full token is stored there.
 */
app.all("/mcp/:token", async (c) => {
  const token = c.req.param("token");
  const accountId = credentialAccountId(token);
  if (!accountId) return c.notFound();

  const object = accountStore(c.env, accountId);
  const resolved = unwrap(await object.resolveExecution(token));
  if (!resolved) return c.notFound();

  const check = async () => {
    const allowed = await object.authorizeExecution(token, resolved.revision);
    if (!allowed.ok) {
      const error = allowed.error;
      if (error?.code === "CONNECTION_CHANGED")
        throw new AppError(
          "SCHEMA_CHANGED",
          "The connection changed. Rediscover before continuing.",
        );
      throw new AppError(
        error?.code ?? "AUTH_FAILED",
        error?.message ?? "This connection is unavailable.",
      );
    }
  };

  const source: AppSource = {
    catalogue: () => publicCatalogue(resolved.policy),
    read: async (operationId, args) => {
      await check();
      const response = await object.appRead(token, resolved.revision, operationId, args);
      if (!response.ok) {
        const error = response.error;
        throw new AppError(
          error?.code ?? "READ_FAILED",
          error?.message ?? "The read could not be completed.",
          error?.details ?? {},
          error?.mutation_sent ?? false,
        );
      }
      return response.value ?? {};
    },
    write: async (operationId, args) => {
      await check();
      const response = await object.appWrite(token, resolved.revision, operationId, args);
      if (!response.ok) {
        const error = response.error;
        throw new AppError(
          error?.code ?? "WRITE_UNCERTAIN",
          error?.message ?? "The write outcome is uncertain. Read the current state.",
          error?.details ?? {},
          error?.mutation_sent ?? "unknown",
        );
      }
      return response.value ?? {};
    },
  };

  const handler = createMcpHandler(() => createMcpServer(source), {
    responseMode: "auto",
    onerror: (error) => {
      // Never log the token, URL or arguments.
      console.error(JSON.stringify({ event: "mcp_handler_error", name: error.name }));
    },
  });
  const response = await handler.fetch(c.req.raw);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
});

export default app;
