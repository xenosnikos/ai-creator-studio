import fs from "node:fs";
import path from "node:path";

import { config } from "@/lib/config";
import { openDatabase, type SqliteDatabase } from "@/lib/sqlite";

/**
 * SQLite persistence.
 *
 * Deliberately boring: one file, synchronous driver, JSON columns for the
 * structured value objects (identity block, scene spec, settings). A POC does
 * not need a migration framework, but the schema is versioned so a future
 * product can bolt one on without a rewrite.
 *
 * The driver itself is chosen at runtime — see `sqlite.ts`.
 */

let db: SqliteDatabase | null = null;

export function getDb(): SqliteDatabase {
  if (db) return db;

  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.assetsDir, { recursive: true });

  db = openDatabase(config.dbPath);
  // WAL keeps reads from blocking the job runner's writes; foreign keys are off
  // by default in SQLite and the schema relies on ON DELETE CASCADE.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function addColumnIfMissing(database: SqliteDatabase, table: string, column: string, ddl: string): void {
  try {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  } catch {
    // Already present. SQLite has no `ADD COLUMN IF NOT EXISTS`, and the only
    // failure mode worth distinguishing here is "column exists", which is the
    // success case for a migration that has already run.
  }
}

function migrate(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS creators (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      category     TEXT NOT NULL DEFAULT '',
      persona      TEXT NOT NULL DEFAULT '',
      identity     TEXT NOT NULL,          -- JSON IdentityBlock
      voice        TEXT NOT NULL,          -- JSON VoiceConfig
      prompt_seed  TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'draft',
      -- The operator's own words about how this creator should look. Kept so
      -- the identity block can be regenerated from the brief instead of only
      -- hand-edited; it used to be consumed once and discarded.
      appearance_notes TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS creator_references (
      id          TEXT PRIMARY KEY,
      creator_id  TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,           -- 'seed' | 'sheet'
      angle       TEXT,                    -- IdentityAngle | NULL
      remote_url  TEXT NOT NULL,
      local_path  TEXT,
      is_anchor   INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_refs_creator ON creator_references(creator_id);

    CREATE TABLE IF NOT EXISTS projects (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      creator_id      TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
      settings        TEXT NOT NULL,       -- JSON ProjectSettings
      transcript      TEXT NOT NULL DEFAULT '',
      background_refs TEXT NOT NULL DEFAULT '[]',
      style_refs      TEXT NOT NULL DEFAULT '[]',
      storyboard_approved_at TEXT,
      status          TEXT NOT NULL DEFAULT 'draft',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_projects_creator ON projects(creator_id);

    CREATE TABLE IF NOT EXISTS scenes (
      id               TEXT PRIMARY KEY,
      project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      idx              INTEGER NOT NULL,
      title            TEXT NOT NULL,
      spec             TEXT NOT NULL,      -- JSON SceneSpec (creator-agnostic)
      dialogue         TEXT NOT NULL DEFAULT '',
      duration_seconds REAL NOT NULL DEFAULT 5,
      approved_image_asset_id TEXT,
      created_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scenes_project ON scenes(project_id, idx);

    CREATE TABLE IF NOT EXISTS plates (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,            -- 'location' | 'prop'
      key         TEXT NOT NULL,            -- slug scenes refer to
      label       TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      remote_url  TEXT,
      local_path  TEXT,
      created_at  TEXT NOT NULL,
      -- One plate per key per project: the whole point is that every scene set
      -- in a place gets the same reference image, so a duplicate key would
      -- silently split a location in two.
      UNIQUE (project_id, key)
    );

    CREATE TABLE IF NOT EXISTS assets (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,            -- 'image' | 'video' | 'audio'
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      scene_id   TEXT REFERENCES scenes(id) ON DELETE CASCADE,
      creator_id TEXT REFERENCES creators(id) ON DELETE SET NULL,
      remote_url TEXT,
      local_path TEXT,
      prompt     TEXT,
      meta       TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_assets_scene ON assets(scene_id, kind);
    CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id, kind);

    CREATE TABLE IF NOT EXISTS jobs (
      id         TEXT PRIMARY KEY,
      type       TEXT NOT NULL,
      status     TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      scene_id   TEXT REFERENCES scenes(id) ON DELETE CASCADE,
      creator_id TEXT REFERENCES creators(id) ON DELETE CASCADE,
      input      TEXT NOT NULL DEFAULT '{}',
      result     TEXT,
      error      TEXT,
      progress   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
  `);

  // Columns added after the first release. `CREATE TABLE IF NOT EXISTS` above
  // does nothing to a table that already exists, so new columns need this.
  addColumnIfMissing(database, "creators", "appearance_notes", "TEXT NOT NULL DEFAULT ''");
  // The structured appearance picks, as JSON. One column rather than a dozen:
  // the shape is read and written whole and never queried by field.
  addColumnIfMissing(database, "creators", "look", "TEXT NOT NULL DEFAULT '{}'");
  // Outfit photos for a project: "wear this" rather than "wear something like
  // this". Separate from background_refs because they are attached to the
  // render for a different reason and are ordered differently against the
  // identity anchors.
  addColumnIfMissing(database, "projects", "wardrobe_refs", "TEXT NOT NULL DEFAULT '[]'");
  // Durable production gates. Storing the approved asset id means generating a
  // replacement still automatically makes the previous approval stale.
  addColumnIfMissing(database, "projects", "storyboard_approved_at", "TEXT");
  addColumnIfMissing(database, "scenes", "approved_image_asset_id", "TEXT");
}

// --- helpers ---------------------------------------------------------------

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${random}`;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Resolve a stored relative asset path to an absolute one. */
export function assetAbsolutePath(relative: string): string {
  return path.join(config.assetsDir, relative);
}
