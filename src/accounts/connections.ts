import { z } from "zod";
import { connectionIdSchema, decode, encode } from "./crypto";
import { accountIdSchema, sessionAccessSchema } from "./model";

export const connectionNameSchema = z.string().trim().min(1).max(100);

export const appCredentialSchema = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => new TextEncoder().encode(value).length <= 8192);

export const revisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER - 1);

export const connectionAccessSchema = sessionAccessSchema
  .extend({ id: connectionIdSchema, revision: revisionSchema })
  .strict();
export type ConnectionAccess = z.infer<typeof connectionAccessSchema>;

export const connectionCreateSchema = sessionAccessSchema
  .extend({
    csrf: z.string().regex(/^[a-f0-9]{64}$/),
    name: connectionNameSchema,
    credential: appCredentialSchema,
  })
  .strict();
export type ConnectionCreate = z.infer<typeof connectionCreateSchema>;

export const connectionChangeSchema = connectionAccessSchema
  .extend({
    csrf: z.string().regex(/^[a-f0-9]{64}$/),
    operation: z.enum(["rotate", "revoke", "update", "disable", "enable"]),
    name: connectionNameSchema.optional(),
    credential: appCredentialSchema.optional(),
  })
  .strict()
  .refine((value) =>
    value.operation === "update"
      ? value.name !== undefined || value.credential !== undefined
      : value.name === undefined && value.credential === undefined,
  );
export type ConnectionChange = z.infer<typeof connectionChangeSchema>;

export type ConnectionSummary = {
  id: string;
  name: string;
  status: "active" | "revoked";
  disabled: boolean;
  revision: number;
  access_configured: boolean;
  created_at: number;
  updated_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
};

export type StoredConnection = Omit<ConnectionSummary, "disabled" | "access_configured"> & {
  disabled: number;
  app_credential_ciphertext: string | null;
  execution_token_hash: string | null;
};

export const listConnectionsSchema = sessionAccessSchema
  .extend({
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().max(512).optional(),
  })
  .strict();
export type ConnectionList = z.input<typeof listConnectionsSchema>;

const cursorSchema = z.tuple([
  accountIdSchema,
  z.number().int().nonnegative().safe(),
  connectionIdSchema,
]);

export function readConnectionCursor(value: string, accountId: string) {
  const data = cursorSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(decode(value))),
  );
  if (data[0] !== accountId) throw new Error("Foreign cursor");
  return { createdAt: data[1], id: data[2] };
}

export const connectionCursor = (accountId: string, row: ConnectionSummary) =>
  encode(new TextEncoder().encode(JSON.stringify([accountId, row.created_at, row.id])));

export function publicConnection(row: ConnectionSummary): ConnectionSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    disabled: row.disabled,
    revision: row.revision,
    access_configured: row.access_configured,
    created_at: row.created_at,
    updated_at: row.updated_at,
    rotated_at: row.rotated_at,
    revoked_at: row.revoked_at,
  };
}
