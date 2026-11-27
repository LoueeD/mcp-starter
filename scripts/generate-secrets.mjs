import { randomBytes } from "node:crypto";
import { chmod, copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Generate local-only secrets without printing them. Existing values are never
// rotated by this script; remove a value by hand if you deliberately want a new
// one. Run once after copying .var.dev.example to .var.dev.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(root, process.env.ENV_FILE || ".var.dev");
const exampleFile = resolve(root, ".var.dev.example");

function parse(contents) {
  return Object.fromEntries(
    contents
      .split(/\r?\n/)
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => {
        const index = line.indexOf("=");
        return [
          line.slice(0, index),
          line
            .slice(index + 1)
            .trim()
            .replace(/^(['"])(.*)\1$/, "$2"),
        ];
      }),
  );
}

function render(values) {
  const order = [
    "APP_NAME",
    "ENVIRONMENT",
    "ENCRYPTION_KEY_VERSION",
    "ENCRYPTION_KEYS",
    "CEREMONY_KEY",
    "WEBAUTHN_RP_ID",
    "WEBAUTHN_ORIGIN",
    "MCP_URL",
  ];
  const remaining = Object.keys(values).filter((key) => !order.includes(key));
  return `${[...order, ...remaining]
    .filter((key) => values[key] !== undefined)
    .map((key) => `${key}=${values[key]}`)
    .join("\n")}\n`;
}

let contents;
try {
  contents = await readFile(envFile, "utf8");
} catch {
  await copyFile(exampleFile, envFile);
  contents = await readFile(envFile, "utf8");
  await chmod(envFile, 0o600);
}

const values = { ...parse(await readFile(exampleFile, "utf8")), ...parse(contents) };
const version = /^[A-Za-z0-9_-]{1,32}$/.test(values.ENCRYPTION_KEY_VERSION || "")
  ? values.ENCRYPTION_KEY_VERSION
  : "v1";
values.ENCRYPTION_KEY_VERSION = version;

if (values.CEREMONY_KEY?.length !== 43) {
  values.CEREMONY_KEY = randomBytes(32).toString("base64url");
}

let ring = {};
try {
  ring = JSON.parse(values.ENCRYPTION_KEYS || "{}");
} catch {
  ring = {};
}
if (!ring || typeof ring !== "object" || Array.isArray(ring)) ring = {};
if (typeof ring[version] !== "string" || ring[version].length !== 43) {
  // Generating a new active key is safe: any existing encrypted credential
  // becomes unreadable, and this script only runs for local development.
  ring[version] = randomBytes(32).toString("base64url");
}
values.ENCRYPTION_KEYS = JSON.stringify(ring);

await writeFile(envFile, render(values), { mode: 0o600 });
await chmod(envFile, 0o600);

console.log(`Wrote ${envFile.replace(`${root}/`, "")} with local secrets.`);
console.log("Values were generated or preserved; nothing secret was printed.");
if (!process.env.CI) {
  console.log(
    "For production, set CEREMONY_KEY and ENCRYPTION_KEYS with `wrangler secret put` (see docs/SETUP.md).",
  );
}
