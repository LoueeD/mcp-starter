import { z } from "zod";
import { RESOURCES } from "../app/catalogue";
import type { AccessPolicy } from "../app/types";

export const grantSchema = z
  .object({
    read: z.boolean(),
    create: z.boolean(),
    update: z.boolean(),
    delete: z.boolean(),
  })
  .strict()
  .refine(
    (value) => value.read || (!value.create && !value.update && !value.delete),
    "Write grants require read.",
  );

export const accessPolicySchema = z
  .object({
    version: z.literal(1),
    resources: z.record(z.string().min(1).max(64), grantSchema),
  })
  .strict();

/** New connections start read-only until the owner explicitly grants writes. */
export function defaultPolicy(): AccessPolicy {
  return {
    version: 1,
    resources: Object.fromEntries(
      RESOURCES.map((resource) => [
        resource.name,
        { read: true, create: false, update: false, delete: false },
      ]),
    ),
  };
}

export function normalisePolicy(policy: AccessPolicy): AccessPolicy {
  const resources = Object.fromEntries(
    Object.entries(policy.resources).map(([name, grant]) => [
      name,
      {
        read: grant.read,
        create: grant.read && grant.create,
        update: grant.read && grant.update,
        delete: grant.read && grant.delete,
      },
    ]),
  );
  return { version: 1, resources };
}
