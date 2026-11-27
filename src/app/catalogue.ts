import { z } from "zod";
import type {
  AccessPolicy,
  Catalogue,
  OperationDefinition,
  OperationKind,
  PublicOperation,
  ResourceDefinition,
} from "./types";

/**
 * Demo application surface.
 *
 * This starter ships with a tiny notes API implemented inside the account
 * Durable Object so the whole flow works without a second service. Replace
 * these definitions with the operations from YOUR app. Keep the shape: a
 * stable id, a resource, a read/write kind, an input schema, examples and a
 * short description that tells an agent when to use it.
 */

const noteId = z.string().regex(/^note_[a-f0-9]{16}$/);
const noteStatus = z.enum(["open", "done"]);
const noteFields = {
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20_000),
  status: noteStatus,
};

export const RESOURCES: ResourceDefinition[] = [
  {
    name: "notes",
    label: "Notes",
    description: "Small text notes with an open/done status. Demo data belongs to this account.",
  },
];

export const OPERATIONS: OperationDefinition[] = [
  {
    id: "notes:list",
    resource: "notes",
    kind: "list",
    summary: "List notes",
    description:
      "Return notes newest first. Use status to filter, and pass next_cursor back unchanged to fetch the next page. Results include has_more so callers never assume a partial page is complete.",
    input: z
      .object({
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().max(512).optional(),
        status: noteStatus.optional(),
      })
      .strict(),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 20,
          description: "Page size. Defaults to 20.",
        },
        cursor: {
          type: "string",
          maxLength: 512,
          description: "Opaque cursor from a previous notes:list response. Pass it alone.",
        },
        status: {
          type: "string",
          enum: ["open", "done"],
          description: "Optional exact-status filter.",
        },
      },
    },
    examples: [
      { arguments: { limit: 10 }, note: "Newest ten notes." },
      {
        arguments: { status: "done", limit: 20 },
        note: "Completed notes only; read next_cursor before claiming the list is complete.",
      },
    ],
  },
  {
    id: "notes:get",
    resource: "notes",
    kind: "get",
    summary: "Get one note",
    description:
      "Return one note by its exact id. Use this before updating or deleting when the current values matter.",
    input: z.object({ id: noteId }).strict(),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: {
          type: "string",
          pattern: "^note_[a-f0-9]{16}$",
          description: "Exact note id returned by notes:list or notes:create.",
        },
      },
    },
    examples: [{ arguments: { id: "note_0123456789abcdef" } }],
  },
  {
    id: "notes:create",
    resource: "notes",
    kind: "create",
    summary: "Create a note",
    description:
      "Create one note. The server generates the id and timestamps and returns the stored note. Do not retry automatically if the response is uncertain: list recent notes first.",
    input: z
      .object({
        title: noteFields.title,
        body: noteFields.body.optional(),
        status: noteStatus.optional(),
      })
      .strict(),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        body: { type: "string", maxLength: 20000 },
        status: { type: "string", enum: ["open", "done"], default: "open" },
      },
    },
    examples: [
      {
        arguments: { title: "Call the supplier", body: "Ask about the delivery window." },
        note: "Create an open note.",
      },
    ],
  },
  {
    id: "notes:update",
    resource: "notes",
    kind: "update",
    summary: "Update a note",
    description:
      "Update only the supplied fields. Unspecified fields are preserved. Pass expected_updated_at from a recent read to reject a stale overwrite with a CONFLICT error.",
    input: z
      .object({
        id: noteId,
        changes: z
          .object({
            title: noteFields.title.optional(),
            body: noteFields.body.optional(),
            status: noteStatus.optional(),
          })
          .strict()
          .refine((value) => Object.keys(value).length > 0, "Supply at least one change."),
        expected_updated_at: z.number().int().nonnegative().optional(),
      })
      .strict(),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id", "changes"],
      properties: {
        id: { type: "string", pattern: "^note_[a-f0-9]{16}$" },
        changes: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            title: { type: "string", minLength: 1, maxLength: 200 },
            body: { type: "string", maxLength: 20000 },
            status: { type: "string", enum: ["open", "done"] },
          },
        },
        expected_updated_at: {
          type: "integer",
          minimum: 0,
          description: "Optional optimistic-concurrency check from the latest note.updated_at.",
        },
      },
    },
    examples: [
      {
        arguments: {
          id: "note_0123456789abcdef",
          changes: { status: "done" },
          expected_updated_at: 1760000000000,
        },
        note: "Mark a note done only if it has not changed since the read.",
      },
    ],
  },
  {
    id: "notes:delete",
    resource: "notes",
    kind: "delete",
    summary: "Delete a note",
    description:
      "Delete one note by exact id and return what was deleted. This is permanent. Confirm intent before calling and never retry automatically after an uncertain response.",
    input: z.object({ id: noteId }).strict(),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string", pattern: "^note_[a-f0-9]{16}$" } },
    },
    examples: [{ arguments: { id: "note_0123456789abcdef" } }],
  },
];

const READ_KINDS = new Set<OperationKind>(["list", "get"]);
export const isReadKind = (kind: OperationKind) => READ_KINDS.has(kind);

function grantFor(policy: AccessPolicy | null, resource: string) {
  // Fail closed. A missing policy means the connection has no granted access,
  // not unrestricted access. New connections receive an explicit read-only
  // policy at creation, so this only affects corrupt or legacy rows.
  if (!policy) return { read: false, create: false, update: false, delete: false };
  return policy.resources[resource] ?? { read: false, create: false, update: false, delete: false };
}

export function operationAllowed(policy: AccessPolicy | null, operation: OperationDefinition) {
  const grant = grantFor(policy, operation.resource);
  if (operation.kind === "list" || operation.kind === "get") return grant.read;
  return grant.read && grant[operation.kind];
}

export function visibleOperations(policy: AccessPolicy | null): PublicOperation[] {
  return OPERATIONS.filter((operation) => operationAllowed(policy, operation)).map(
    ({ input: _input, ...operation }) => operation,
  );
}

export async function catalogueVersion() {
  const payload = JSON.stringify(OPERATIONS.map(({ input: _input, ...operation }) => operation));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function publicCatalogue(policy: AccessPolicy | null): Promise<Catalogue> {
  const operations = visibleOperations(policy);
  const resources = RESOURCES.filter((resource) =>
    operations.some((operation) => operation.resource === resource.name),
  );
  return { version: await catalogueVersion(), resources, operations };
}

export function findOperation(id: string) {
  return OPERATIONS.find((operation) => operation.id === id);
}
