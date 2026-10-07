/**
 * Node's built-in SQLite, for the agents that keep their sessions in a database rather than a file
 * each: OpenCode (`extract-opencode.ts`) and Goose (`extract-goose.ts`).
 */

export interface Statement {
  all(...params: unknown[]): Array<Record<string, unknown>>
}
export interface Database {
  prepare(sql: string): Statement
  close(): void
}
interface Sqlite {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => Database
}

let sqlite: Sqlite | null | undefined

/**
 * Node's built-in SQLite, or null where this Node has none (before 22.13).
 *
 * Loaded by a computed name so a Node without it fails here, at the one place that can say so,
 * rather than when the module graph loads. Node marks the module experimental and prints a warning
 * the first time it loads; that is muted for the load, since it says nothing about the data.
 */
async function loadSqlite(): Promise<Sqlite | null> {
  if (sqlite !== undefined) return sqlite
  const emit = process.emitWarning
  process.emitWarning = (() => undefined) as typeof process.emitWarning
  try {
    const name = 'node:sqlite'
    sqlite = (await import(name)) as Sqlite
  } catch {
    sqlite = null
  } finally {
    process.emitWarning = emit
  }
  return sqlite
}

/** Whether this Node can read an agent's database at all, for the notice when it cannot. */
export async function canReadSqlite(): Promise<boolean> {
  return (await loadSqlite()) !== null
}

/** A database opened read-only, or null when it cannot be opened or this Node has no SQLite. */
export async function openReadOnly(path: string): Promise<Database | null> {
  const lib = await loadSqlite()
  if (lib === null) return null
  try {
    return new lib.DatabaseSync(path, { readOnly: true })
  } catch {
    return null
  }
}
