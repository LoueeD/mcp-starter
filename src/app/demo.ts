import { AppError } from "./errors";
import type { OperationDefinition } from "./types";

/**
 * Demo notes implementation.
 *
 * Everything here is deliberately simple and runs against the same SQLite
 * database as the account. For a real app, delete this file and call your API
 * from the AppSource factory in src/index.ts instead. The rest of the starter
 * does not depend on notes.
 */

type NoteRow = {
  id: string;
  title: string;
  body: string;
  status: "open" | "done";
  created_at: number;
  updated_at: number;
};

function encodeCursor(createdAt: number, id: string) {
  return btoa(JSON.stringify([createdAt, id]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeCursor(value: string) {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    const parsed = JSON.parse(atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "=")));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      !Number.isSafeInteger(parsed[0]) ||
      typeof parsed[1] !== "string" ||
      !/^note_[a-f0-9]{16}$/.test(parsed[1])
    )
      throw new Error("Invalid cursor");
    return { createdAt: parsed[0] as number, id: parsed[1] as string };
  } catch {
    throw new AppError("INVALID_CURSOR", "Use a cursor returned by notes:list.", {
      resource: "notes",
    });
  }
}

function noteFromRow(row: NoteRow) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function readNote(sql: SqlStorage, id: string): NoteRow | null {
  return (
    sql
      .exec<NoteRow>(
        "SELECT id,title,body,status,created_at,updated_at FROM demo_notes WHERE id = ?",
        id,
      )
      .toArray()[0] ?? null
  );
}

function requireNote(sql: SqlStorage, id: string) {
  const note = readNote(sql, id);
  if (!note)
    throw new AppError("NOT_FOUND", "No note exists with that id.", {
      resource: "notes",
      id,
    });
  return note;
}

function newNoteId() {
  return `note_${[...crypto.getRandomValues(new Uint8Array(8))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Validate the app credential before storing it encrypted. */
export function validateDemoCredential(value: string) {
  if (!/^demo_[A-Za-z0-9_-]{8,200}$/.test(value))
    throw new AppError(
      "INVALID_CREDENTIAL",
      "This starter accepts demo credentials such as demo_local_development.",
      { hint: "Replace validateDemoCredential with a real upstream check." },
    );
}

/** Seed a few notes so discovery/read/write can be exercised immediately. */
export function seedDemoNotes(sql: SqlStorage) {
  const now = Date.now();
  const seeds: Array<[string, string, string, "open" | "done"]> = [
    [
      "note_0000000000000001",
      "Welcome to the MCP starter",
      "Create a connection, install its URL in an MCP client, then ask the agent to list notes.",
      "open",
    ],
    [
      "note_0000000000000002",
      "Try a write",
      "Grant create/update/delete on the access page before asking the agent to change a note.",
      "open",
    ],
    [
      "note_0000000000000003",
      "Demo data is real to this Worker",
      "These notes live in the account Durable Object. Delete them once you connect your own app.",
      "done",
    ],
  ];
  for (const [id, title, body, status] of seeds)
    sql.exec(
      "INSERT OR IGNORE INTO demo_notes(id,title,body,status,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      id,
      title,
      body,
      status,
      now,
      now,
    );
}

export function demoRead(
  sql: SqlStorage,
  operation: OperationDefinition,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (operation.id === "notes:list") {
    const limit = typeof args.limit === "number" ? args.limit : 20;
    const status = typeof args.status === "string" ? args.status : null;
    const cursor = typeof args.cursor === "string" ? decodeCursor(args.cursor) : null;

    const rows = cursor
      ? sql
          .exec<NoteRow>(
            `SELECT id,title,body,status,created_at,updated_at FROM demo_notes
             WHERE (? IS NULL OR status = ?)
               AND (created_at < ? OR (created_at = ? AND id < ?))
             ORDER BY created_at DESC,id DESC LIMIT ?`,
            status,
            status,
            cursor.createdAt,
            cursor.createdAt,
            cursor.id,
            limit + 1,
          )
          .toArray()
      : sql
          .exec<NoteRow>(
            `SELECT id,title,body,status,created_at,updated_at FROM demo_notes
             WHERE (? IS NULL OR status = ?)
             ORDER BY created_at DESC,id DESC LIMIT ?`,
            status,
            status,
            limit + 1,
          )
          .toArray();

    const notes = rows.slice(0, limit).map(noteFromRow);
    const last = notes.at(-1);
    return {
      notes,
      has_more: rows.length > limit,
      next_cursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
      result_scope:
        "One page ordered newest first. has_more indicates whether another page exists.",
    };
  }

  if (operation.id === "notes:get") {
    const note = requireNote(sql, String(args.id));
    return { note: noteFromRow(note) };
  }

  throw new AppError("WRONG_EXECUTOR", "This operation is not a read.", {
    operation_id: operation.id,
  });
}

export function demoWrite(
  sql: SqlStorage,
  operation: OperationDefinition,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (operation.id === "notes:create") {
    const now = Date.now();
    const id = newNoteId();
    sql.exec(
      "INSERT INTO demo_notes(id,title,body,status,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      id,
      String(args.title),
      typeof args.body === "string" ? args.body : "",
      typeof args.status === "string" ? args.status : "open",
      now,
      now,
    );
    const note = requireNote(sql, id);
    return {
      note: noteFromRow(note),
      created: true,
      mutation_sent: true,
      automatic_retry: false,
      read_back: true,
    };
  }

  if (operation.id === "notes:update") {
    const id = String(args.id);
    const existing = requireNote(sql, id);
    if (
      typeof args.expected_updated_at === "number" &&
      args.expected_updated_at !== existing.updated_at
    )
      throw new AppError(
        "CONFLICT",
        "The note changed since it was read. Read it again before updating.",
        {
          resource: "notes",
          id,
          expected_updated_at: args.expected_updated_at,
          current: noteFromRow(existing),
        },
      );
    const changes = args.changes as Record<string, unknown>;
    const title = Object.hasOwn(changes, "title") ? String(changes.title) : existing.title;
    const body = Object.hasOwn(changes, "body") ? String(changes.body) : existing.body;
    const status = Object.hasOwn(changes, "status")
      ? (changes.status as "open" | "done")
      : existing.status;
    const updatedAt = Math.max(Date.now(), existing.updated_at + 1);
    sql.exec(
      "UPDATE demo_notes SET title = ?,body = ?,status = ?,updated_at = ? WHERE id = ?",
      title,
      body,
      status,
      updatedAt,
      id,
    );
    const note = requireNote(sql, id);
    return {
      note: noteFromRow(note),
      updated: true,
      mutation_sent: true,
      automatic_retry: false,
      read_back: true,
    };
  }

  if (operation.id === "notes:delete") {
    const existing = requireNote(sql, String(args.id));
    sql.exec("DELETE FROM demo_notes WHERE id = ?", existing.id);
    if (readNote(sql, existing.id))
      throw new AppError(
        "WRITE_UNCERTAIN",
        "The delete was sent but the note still exists. Read the note before retrying.",
        { resource: "notes", id: existing.id },
        "unknown",
      );
    return {
      deleted: noteFromRow(existing),
      mutation_sent: true,
      automatic_retry: false,
      read_back: true,
    };
  }

  throw new AppError("WRONG_EXECUTOR", "This operation is not a write.", {
    operation_id: operation.id,
  });
}
