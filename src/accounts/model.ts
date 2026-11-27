import { z } from "zod";

export const accountIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const credentialIdSchema = z
  .string()
  .min(1)
  .max(1366)
  .regex(/^[A-Za-z0-9_-]+$/);

export const SESSION_MILLISECONDS = 1_800_000;
export const MAX_SESSIONS = 20;
export const MAX_ACTIVE_CONNECTIONS = 20;
export const MAX_REVOKED_CONNECTIONS = 100;
export const MAX_USED_CHALLENGES = 256;
export const MAX_PASSKEYS = 20;

export class AccountStorageError extends Error {
  code: string;
  status: 400 | 401 | 403 | 404 | 409 | 503;
  constructor(code: string, message: string, status: 400 | 401 | 403 | 404 | 409 | 503) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const registrationSchema = z
  .object({
    accountId: accountIdSchema,
    label: z.string().trim().min(1).max(50),
    passkey: z
      .object({
        id: credentialIdSchema,
        publicKey: z
          .instanceof(Uint8Array)
          .refine((value) => value.byteLength > 0 && value.byteLength <= 4096),
        counter: z.number().int().min(0).max(0xffffffff),
        transports: z.array(z.string().min(1).max(32)).max(16).default([]),
        deviceType: z.enum(["singleDevice", "multiDevice"]),
        backedUp: z.boolean(),
        label: z.string().trim().min(1).max(50).default("Passkey"),
      })
      .strict()
      .refine((value) => !value.backedUp || value.deviceType === "multiDevice"),
    sessionHash: hashSchema,
    challengeHash: hashSchema,
    challengeExpiresAt: z.number().int().nonnegative().safe(),
  })
  .strict();
export type AccountRegistration = z.input<typeof registrationSchema>;

export const authenticationCommitSchema = z
  .object({
    accountId: accountIdSchema,
    credentialId: credentialIdSchema,
    previousCounter: z.number().int().min(0).max(0xffffffff),
    newCounter: z.number().int().min(0).max(0xffffffff),
    deviceType: z.enum(["singleDevice", "multiDevice"]),
    backedUp: z.boolean(),
    challengeHash: hashSchema,
    challengeExpiresAt: z.number().int().nonnegative().safe(),
    sessionHash: hashSchema,
  })
  .strict()
  .refine((value) => !value.backedUp || value.deviceType === "multiDevice");
export type AuthenticationCommit = z.infer<typeof authenticationCommitSchema>;

export const passkeyRemovalSchema = z
  .object({
    accountId: accountIdSchema,
    credentialId: credentialIdSchema,
    sessionToken: z.string().length(108),
    csrf: hashSchema,
  })
  .strict();
export type PasskeyRemoval = z.infer<typeof passkeyRemovalSchema>;

export type AccountSummary = { id: string; label: string; created_at: number; updated_at: number };

export type StoredPasskey = {
  id: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
};

export const sessionAccessSchema = z
  .object({
    accountId: accountIdSchema,
    sessionToken: z.string().length(108),
    csrf: hashSchema.optional(),
  })
  .strict();
export type SessionAccess = z.infer<typeof sessionAccessSchema>;

export const passkeyAdditionSchema = z
  .object({
    accountId: accountIdSchema,
    sessionToken: z.string().length(108),
    csrf: hashSchema,
    passkey: registrationSchema.shape.passkey,
    challengeHash: hashSchema,
    challengeExpiresAt: z.number().int().nonnegative().safe(),
  })
  .strict();
export type PasskeyAddition = z.input<typeof passkeyAdditionSchema>;
