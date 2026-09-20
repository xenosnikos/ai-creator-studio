/**
 * SQLite backend selection.
 *
 * Node 22.5+ ships SQLite in core as `node:sqlite`, which needs no compilation
 * on any platform. That matters more than it sounds: the previous hard
 * dependency on `better-sqlite3` made `npm install` fail outright on Windows
 * with a recent Node, because no prebuilt binary matched and compiling from
 * source needs a full C++ toolchain most people do not have.
 *
 * `better-sqlite3` is deliberately NOT a dependency and is not loaded here. It
 * was the previous backend and is what broke installs; keeping a require() for
 * it as a "fallback" only meant every bundler compile logged a module-not-found
 * warning for a package nobody has, which reads like a real error. Node 22.5 is
 * a clearer requirement than a fallback that is never exercised.
 *
 * The surface below is the small slice of the API this app actually uses.
 */

export interface SqliteStatement {
  run(...params: SqliteValue[]): { changes: number };
  get<T = unknown>(...params: SqliteValue[]): T | undefined;
  all<T = unknown>(...params: SqliteValue[]): T[];
}

export type SqliteValue = string | number | bigint | null | Uint8Array;

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  /** Wrap `fn` so it runs inside a transaction. */
  transaction<T>(fn: () => T): () => T;
  readonly backend: "node:sqlite";
}

export function openDatabase(filePath: string): SqliteDatabase {
  const core = tryCoreSqlite(filePath);
  if (core) return core;
  throw new Error(
    "This app needs Node 22.5 or newer, which ships SQLite in core. " +
      `You are on ${process.version}. Update at https://nodejs.org and run \`npm run dev\` again.`,
  );
}

// ---------------------------------------------------------------------------
// node:sqlite (preferred)
// ---------------------------------------------------------------------------

interface CoreStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface CoreDatabase {
  exec(sql: string): void;
  prepare(sql: string): CoreStatement;
  close(): void;
}

function tryCoreSqlite(filePath: string): SqliteDatabase | null {
  // `process.getBuiltinModule` exists precisely for this: loading a core module
  // synchronously without knowing whether the surrounding code ended up as ESM
  // or CJS. A bare `require` here silently fails inside Next's bundled server
  // (no `require` in scope), which made the fallback look like "no SQLite at
  // all" rather than "core SQLite unavailable".
  const sqlite = process.getBuiltinModule?.("node:sqlite") as
    | { DatabaseSync: new (path: string) => CoreDatabase }
    | undefined;
  const DatabaseSync = sqlite?.DatabaseSync;
  if (!DatabaseSync) return null;

  const db = new DatabaseSync(filePath);

  // Nesting depth, so a transaction inside a transaction does not issue a
  // second BEGIN (which SQLite rejects).
  let depth = 0;

  return {
    backend: "node:sqlite",
    exec(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        run: (...params) => {
          const result = statement.run(...normalise(params));
          return { changes: Number(result.changes ?? 0) };
        },
        get: <T,>(...params: SqliteValue[]) =>
          statement.get(...normalise(params)) as T | undefined,
        all: <T,>(...params: SqliteValue[]) => statement.all(...normalise(params)) as T[],
      };
    },
    transaction<T>(fn: () => T): () => T {
      return () => {
        if (depth > 0) return fn();
        depth += 1;
        db.exec("BEGIN");
        try {
          const result = fn();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Rolling back a already-aborted transaction is not itself fatal.
          }
          throw error;
        } finally {
          depth -= 1;
        }
      };
    },
  };
}

/**
 * `node:sqlite` binds a narrow set of types and throws on anything else, where
 * better-sqlite3 was lenient. Coerce the two cases this app can produce.
 */
function normalise(params: SqliteValue[]): SqliteValue[] {
  return params.map((value) => {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    return value;
  });
}
