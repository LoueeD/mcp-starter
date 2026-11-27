import { randomBytes } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Local-only test secrets. Each test run gets fresh keys; nothing is printed.
const key = () => randomBytes(32).toString("base64url");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          APP_NAME: "MCP Starter Test",
          ENVIRONMENT: "test",
          WEBAUTHN_RP_ID: "localhost",
          WEBAUTHN_ORIGIN: "http://localhost:8787",
          CEREMONY_KEY: key(),
          ENCRYPTION_KEYS: JSON.stringify({ v1: key() }),
          ENCRYPTION_KEY_VERSION: "v1",
        },
      },
    }),
  ],
  test: { include: ["tests/**/*.test.ts"] },
});
