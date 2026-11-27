import type { z } from "zod";

export type OperationKind = "list" | "get" | "create" | "update" | "delete";

export type AccessGrant = {
  read: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
};

/**
 * Explicit per-connection scope. `read` gates list/get. Create/update/delete
 * also require `read` because every write is read back before it is reported
 * as successful.
 */
export type AccessPolicy = {
  version: 1;
  resources: Record<string, AccessGrant>;
};

export type OperationDefinition = {
  id: string;
  resource: string;
  kind: OperationKind;
  summary: string;
  description: string;
  /** Runtime validator. Kept server-side; never serialised to an MCP client. */
  input: z.ZodType;
  /** JSON Schema advertised by discover. */
  inputSchema: Record<string, unknown>;
  examples: Array<{ arguments: Record<string, unknown>; note?: string }>;
};

/** Safe to send to an MCP client. `input` is intentionally omitted. */
export type PublicOperation = Omit<OperationDefinition, "input">;

export type ResourceDefinition = {
  name: string;
  label: string;
  description: string;
};

export type Catalogue = {
  version: string;
  resources: ResourceDefinition[];
  operations: PublicOperation[];
};

/**
 * The only app-specific seam used by the MCP layer. Swap the demo source for
 * calls to your real API in src/index.ts, or replace src/app/demo.ts while
 * keeping these methods.
 */
export type AppSource = {
  catalogue(): Promise<Catalogue>;
  read(operationId: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  write(operationId: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
};
