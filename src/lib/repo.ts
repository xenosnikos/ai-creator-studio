import type { CreatorLook } from "@/lib/look";
import { getDb, newId, nowIso, parseJson } from "@/lib/db";
import { DEFAULT_PROJECT_SETTINGS } from "@/lib/types";
import type {
  Asset,
  AssetKind,
  Creator,
  CreatorReference,
  CreatorWithRefs,
  IdentityAngle,
  IdentityBlock,
  Job,
  JobStatus,
  JobType,
  Plate,
  Project,
  ProjectSettings,
  ProjectWithScenes,
  Scene,
  SceneSpec,
  VoiceConfig,
} from "@/lib/types";

/** Row -> domain mapping. Kept in one place so the SQL never leaks upward. */

interface CreatorRow {
  id: string;
  name: string;
  category: string;
  persona: string;
  appearance_notes: string;
  look: string;
  identity: string;
  voice: string;
  prompt_seed: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface ReferenceRow {
  id: string;
  creator_id: string;
  kind: string;
  angle: string | null;
  remote_url: string;
  local_path: string | null;
  is_anchor: number;
  created_at: string;
}

interface ProjectRow {
  id: string;
  title: string;
  prompt: string;
  creator_id: string;
  settings: string;
  transcript: string;
  background_refs: string;
  style_refs: string;
  wardrobe_refs: string;
  storyboard_approved_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface SceneRow {
  id: string;
  project_id: string;
  idx: number;
  title: string;
  spec: string;
  dialogue: string;
  duration_seconds: number;
  approved_image_asset_id: string | null;
  created_at: string;
}

interface AssetRow {
  id: string;
  kind: string;
  project_id: string | null;
  scene_id: string | null;
  creator_id: string | null;
  remote_url: string | null;
  local_path: string | null;
  prompt: string | null;
  meta: string;
  created_at: string;
}

interface JobRow {
  id: string;
  type: string;
  status: string;
  project_id: string | null;
  scene_id: string | null;
  creator_id: string | null;
  input: string;
  result: string | null;
  error: string | null;
  progress: number;
  created_at: string;
  updated_at: string;
}

function toCreator(row: CreatorRow): Creator {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    persona: row.persona,
    appearanceNotes: row.appearance_notes ?? "",
    look: parseJson(row.look, {} as CreatorLook),
    identity: parseJson<IdentityBlock>(row.identity, {} as IdentityBlock),
    voice: parseJson<VoiceConfig>(row.voice, {} as VoiceConfig),
    promptSeed: row.prompt_seed,
    status: row.status as Creator["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toReference(row: ReferenceRow): CreatorReference {
  return {
    id: row.id,
    creatorId: row.creator_id,
    kind: row.kind as CreatorReference["kind"],
    angle: (row.angle as IdentityAngle | null) ?? null,
    remoteUrl: row.remote_url,
    localPath: row.local_path,
    isAnchor: row.is_anchor === 1,
    createdAt: row.created_at,
  };
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    creatorId: row.creator_id,
    // Merged over defaults so a project stored before a setting existed still
    // reads back complete — cheaper and safer than a schema migration.
    settings: {
      ...DEFAULT_PROJECT_SETTINGS,
      ...parseJson<Partial<ProjectSettings>>(row.settings, {}),
      // Projects created while the form offered a 1080p that the video model
      // has never supported have it stored. Pinned on read so those projects
      // stop advertising a resolution they were never going to render at.
      videoResolution: "720p",
    },
    transcript: row.transcript,
    backgroundRefs: parseJson<string[]>(row.background_refs, []),
    styleRefs: parseJson<string[]>(row.style_refs, []),
    // Added after the first projects were saved, so an older row has no column
    // value to read and falls back to empty rather than throwing.
    wardrobeRefs: parseJson<string[]>(row.wardrobe_refs, []),
    storyboardApprovedAt: row.storyboard_approved_at ?? null,
    status: row.status as Project["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toScene(row: SceneRow): Scene {
  return {
    id: row.id,
    projectId: row.project_id,
    index: row.idx,
    title: row.title,
    spec: parseJson<SceneSpec>(row.spec, {} as SceneSpec),
    dialogue: row.dialogue,
    durationSeconds: row.duration_seconds,
    approvedImageAssetId: row.approved_image_asset_id ?? null,
    createdAt: row.created_at,
  };
}

function toAsset(row: AssetRow): Asset {
  return {
    id: row.id,
    kind: row.kind as AssetKind,
    projectId: row.project_id,
    sceneId: row.scene_id,
    creatorId: row.creator_id,
    remoteUrl: row.remote_url,
    localPath: row.local_path,
    prompt: row.prompt,
    meta: parseJson<Record<string, unknown>>(row.meta, {}),
    createdAt: row.created_at,
  };
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    type: row.type as JobType,
    status: row.status as JobStatus,
    projectId: row.project_id,
    sceneId: row.scene_id,
    creatorId: row.creator_id,
    input: parseJson<Record<string, unknown>>(row.input, {}),
    result: row.result ? parseJson<Record<string, unknown>>(row.result, {}) : null,
    error: row.error,
    progress: row.progress,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Creators
// ---------------------------------------------------------------------------

export const creators = {
  list(): CreatorWithRefs[] {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM creators ORDER BY created_at DESC")
      .all<CreatorRow>();
    return rows.map((row) => ({
      ...toCreator(row),
      references: creators.references(row.id),
    }));
  },

  get(id: string): CreatorWithRefs | null {
    const db = getDb();
    const row = db.prepare("SELECT * FROM creators WHERE id = ?").get<CreatorRow>(id);
    if (!row) return null;
    return { ...toCreator(row), references: creators.references(id) };
  },

  references(creatorId: string): CreatorReference[] {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM creator_references WHERE creator_id = ? ORDER BY created_at ASC")
      .all<ReferenceRow>(creatorId);
    return rows.map(toReference);
  },

  create(input: {
    name: string;
    category: string;
    persona: string;
    identity: IdentityBlock;
    voice: VoiceConfig;
    status?: Creator["status"];
    /** The operator's own words about the look, kept so it can be re-run. */
    appearanceNotes?: string;
    look?: CreatorLook;
  }): Creator {
    const db = getDb();
    const id = newId("crt");
    const ts = nowIso();
    db.prepare(
      `INSERT INTO creators (id, name, category, persona, identity, voice, prompt_seed, status, appearance_notes, look, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      input.category,
      input.persona,
      JSON.stringify(input.identity),
      JSON.stringify(input.voice),
      // Folded into every prompt so repeat renders of the same scene stay stable.
      id.slice(-8),
      input.status ?? "draft",
      input.appearanceNotes ?? "",
      JSON.stringify(input.look ?? {}),
      ts,
      ts,
    );
    return creators.get(id)!;
  },

  update(
    id: string,
    patch: Partial<
      Pick<
        Creator,
        | "name"
        | "category"
        | "persona"
        | "identity"
        | "voice"
        | "status"
        | "appearanceNotes"
        | "look"
      >
    >,
  ): Creator | null {
    const db = getDb();
    const current = creators.get(id);
    if (!current) return null;
    db.prepare(
      `UPDATE creators SET name = ?, category = ?, persona = ?, identity = ?, voice = ?, status = ?, appearance_notes = ?, look = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      patch.name ?? current.name,
      patch.category ?? current.category,
      patch.persona ?? current.persona,
      JSON.stringify(patch.identity ?? current.identity),
      JSON.stringify(patch.voice ?? current.voice),
      patch.status ?? current.status,
      patch.appearanceNotes ?? current.appearanceNotes,
      JSON.stringify(patch.look ?? current.look ?? {}),
      nowIso(),
      id,
    );
    return creators.get(id);
  },

  remove(id: string): void {
    getDb().prepare("DELETE FROM creators WHERE id = ?").run(id);
  },

  addReference(input: {
    creatorId: string;
    kind: CreatorReference["kind"];
    angle: IdentityAngle | null;
    remoteUrl: string;
    localPath: string | null;
    isAnchor: boolean;
  }): CreatorReference {
    const db = getDb();
    const id = newId("ref");
    db.prepare(
      `INSERT INTO creator_references (id, creator_id, kind, angle, remote_url, local_path, is_anchor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.creatorId,
      input.kind,
      input.angle,
      input.remoteUrl,
      input.localPath,
      input.isAnchor ? 1 : 0,
      nowIso(),
    );
    const row = db
      .prepare("SELECT * FROM creator_references WHERE id = ?")
      .get<ReferenceRow>(id)!;
    return toReference(row);
  },

  setAnchor(referenceId: string, isAnchor: boolean): void {
    getDb()
      .prepare("UPDATE creator_references SET is_anchor = ? WHERE id = ?")
      .run(isAnchor ? 1 : 0, referenceId);
  },

  /**
   * Replace an expiring/provider-facing URL after re-uploading the durable
   * local reference. The local path remains the source of truth.
   */
  updateReferenceRemoteUrl(referenceId: string, remoteUrl: string): CreatorReference | null {
    const db = getDb();
    db.prepare("UPDATE creator_references SET remote_url = ? WHERE id = ?").run(
      remoteUrl,
      referenceId,
    );
    const row = db
      .prepare("SELECT * FROM creator_references WHERE id = ?")
      .get<ReferenceRow>(referenceId);
    return row ? toReference(row) : null;
  },

  removeReference(referenceId: string): void {
    getDb().prepare("DELETE FROM creator_references WHERE id = ?").run(referenceId);
  },

  /** Drop previously generated sheet shots for an angle before regenerating. */
  clearSheet(creatorId: string): void {
    getDb()
      .prepare("DELETE FROM creator_references WHERE creator_id = ? AND kind = 'sheet'")
      .run(creatorId);
  },
};

// ---------------------------------------------------------------------------
// Projects & scenes
// ---------------------------------------------------------------------------

export const projects = {
  list(): Project[] {
    const rows = getDb()
      .prepare("SELECT * FROM projects ORDER BY updated_at DESC")
      .all<ProjectRow>();
    return rows.map(toProject);
  },

  get(id: string): ProjectWithScenes | null {
    const row = getDb().prepare("SELECT * FROM projects WHERE id = ?").get<ProjectRow>(id);
    if (!row) return null;
    return { ...toProject(row), scenes: projects.scenes(id) };
  },

  scenes(projectId: string): Scene[] {
    const rows = getDb()
      .prepare("SELECT * FROM scenes WHERE project_id = ? ORDER BY idx ASC")
      .all<SceneRow>(projectId);
    return rows.map(toScene);
  },

  create(input: {
    title: string;
    prompt: string;
    creatorId: string;
    settings: ProjectSettings;
    transcript?: string;
    backgroundRefs?: string[];
    styleRefs?: string[];
    wardrobeRefs?: string[];
  }): Project {
    const db = getDb();
    const id = newId("prj");
    const ts = nowIso();
    db.prepare(
      `INSERT INTO projects (id, title, prompt, creator_id, settings, transcript, background_refs, style_refs, wardrobe_refs, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    ).run(
      id,
      input.title,
      input.prompt,
      input.creatorId,
      JSON.stringify(input.settings),
      input.transcript ?? "",
      JSON.stringify(input.backgroundRefs ?? []),
      JSON.stringify(input.styleRefs ?? []),
      JSON.stringify(input.wardrobeRefs ?? []),
      ts,
      ts,
    );
    return projects.get(id)!;
  },

  update(
    id: string,
    patch: Partial<
      Pick<
        Project,
        | "title"
        | "prompt"
        | "creatorId"
        | "settings"
        | "transcript"
        | "status"
        | "backgroundRefs"
        | "styleRefs"
        | "wardrobeRefs"
      >
    >,
  ): Project | null {
    const current = projects.get(id);
    if (!current) return null;
    getDb()
      .prepare(
        `UPDATE projects SET title = ?, prompt = ?, creator_id = ?, settings = ?, transcript = ?,
          background_refs = ?, style_refs = ?, wardrobe_refs = ?, status = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.title ?? current.title,
        patch.prompt ?? current.prompt,
        patch.creatorId ?? current.creatorId,
        JSON.stringify(patch.settings ?? current.settings),
        patch.transcript ?? current.transcript,
        JSON.stringify(patch.backgroundRefs ?? current.backgroundRefs),
        JSON.stringify(patch.styleRefs ?? current.styleRefs),
        JSON.stringify(patch.wardrobeRefs ?? current.wardrobeRefs),
        patch.status ?? current.status,
        nowIso(),
        id,
      );
    return projects.get(id);
  },

  /** Confirm that the current script and shot list are ready for preview stills. */
  approveStoryboard(id: string): Project | null {
    const current = projects.get(id);
    if (!current) return null;
    getDb()
      .prepare("UPDATE projects SET storyboard_approved_at = ?, updated_at = ? WHERE id = ?")
      .run(nowIso(), nowIso(), id);
    return projects.get(id);
  },

  /** Any content edit requires the script/shot approval to be given again. */
  clearStoryboardApproval(id: string): void {
    getDb()
      .prepare("UPDATE projects SET storyboard_approved_at = NULL, updated_at = ? WHERE id = ?")
      .run(nowIso(), id);
  },

  remove(id: string): void {
    getDb().prepare("DELETE FROM projects WHERE id = ?").run(id);
  },

  /** Replace the whole storyboard atomically. */
  replaceScenes(
    projectId: string,
    scenes: Array<{ title: string; spec: SceneSpec; dialogue: string; durationSeconds: number }>,
  ): Scene[] {
    const db = getDb();
    const write = db.transaction(() => {
      db.prepare("DELETE FROM scenes WHERE project_id = ?").run(projectId);
      db.prepare(
        "UPDATE projects SET storyboard_approved_at = NULL, updated_at = ? WHERE id = ?",
      ).run(nowIso(), projectId);
      const insert = db.prepare(
        `INSERT INTO scenes (id, project_id, idx, title, spec, dialogue, duration_seconds, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      scenes.forEach((scene, index) => {
        insert.run(
          newId("scn"),
          projectId,
          index,
          scene.title,
          JSON.stringify(scene.spec),
          scene.dialogue,
          scene.durationSeconds,
          nowIso(),
        );
      });
    });
    write();
    return projects.scenes(projectId);
  },
};

export const scenes = {
  get(id: string): Scene | null {
    const row = getDb().prepare("SELECT * FROM scenes WHERE id = ?").get<SceneRow>(id);
    return row ? toScene(row) : null;
  },

  update(
    id: string,
    patch: Partial<Pick<Scene, "title" | "spec" | "dialogue" | "durationSeconds">>,
  ): Scene | null {
    const current = scenes.get(id);
    if (!current) return null;
    const db = getDb();
    const write = db.transaction(() => {
      db.prepare(
        `UPDATE scenes SET title = ?, spec = ?, dialogue = ?, duration_seconds = ?,
          approved_image_asset_id = NULL WHERE id = ?`,
      ).run(
        patch.title ?? current.title,
        JSON.stringify(patch.spec ?? current.spec),
        patch.dialogue ?? current.dialogue,
        patch.durationSeconds ?? current.durationSeconds,
        id,
      );
      // The script shown in exports and the project view must stay aligned with
      // the editable per-scene words.
      const transcript = scenes
        .forProject(current.projectId)
        .map((scene) => scene.dialogue.trim())
        .filter(Boolean)
        .join(" ");
      db.prepare(
        `UPDATE projects SET transcript = ?, storyboard_approved_at = NULL,
          updated_at = ? WHERE id = ?`,
      ).run(transcript, nowIso(), current.projectId);
    });
    write();
    return scenes.get(id);
  },

  forProject(projectId: string): Scene[] {
    return projects.scenes(projectId);
  },

  approveImage(id: string, assetId: string): Scene | null {
    const current = scenes.get(id);
    if (!current) return null;
    getDb()
      .prepare("UPDATE scenes SET approved_image_asset_id = ? WHERE id = ?")
      .run(assetId, id);
    return scenes.get(id);
  },

  clearImageApproval(id: string): void {
    getDb().prepare("UPDATE scenes SET approved_image_asset_id = NULL WHERE id = ?").run(id);
  },
};

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/**
 * Location and prop plates — the "same world" half of consistency.
 *
 * Keyed by (project, key) so every scene naming a location resolves to exactly
 * one reference image. `ensure` is the whole API the render path needs: give it
 * a key and a description and it either returns the plate that already exists
 * or reserves the row, so two scenes rendering in parallel cannot both start
 * generating the same room.
 */
export const plates = {
  ensure(input: {
    projectId: string;
    kind: Plate["kind"];
    key: string;
    label?: string;
    description: string;
  }): { plate: Plate; created: boolean } {
    const db = getDb();
    const existing = plates.byKey(input.projectId, input.key);
    if (existing) return { plate: existing, created: false };

    const id = newId("plt");
    const createdAt = nowIso();
    try {
      db.prepare(
        `INSERT INTO plates (id, project_id, kind, key, label, description, remote_url, local_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      ).run(
        id,
        input.projectId,
        input.kind,
        input.key,
        input.label ?? input.key,
        input.description,
        createdAt,
      );
    } catch {
      // Lost the race against a sibling job; its row is the winner.
      const winner = plates.byKey(input.projectId, input.key);
      if (winner) return { plate: winner, created: false };
      throw new Error(`Could not reserve a plate for "${input.key}"`);
    }
    return { plate: plates.byKey(input.projectId, input.key)!, created: true };
  },

  byKey(projectId: string, key: string): Plate | null {
    const row = getDb()
      .prepare("SELECT * FROM plates WHERE project_id = ? AND key = ?")
      .get<PlateRow>(projectId, key);
    return row ? rowToPlate(row) : null;
  },

  list(projectId: string): Plate[] {
    return getDb()
      .prepare("SELECT * FROM plates WHERE project_id = ? ORDER BY created_at")
      .all<PlateRow>(projectId)
      .map(rowToPlate);
  },

  attachImage(id: string, remoteUrl: string, localPath: string | null): void {
    getDb()
      .prepare("UPDATE plates SET remote_url = ?, local_path = ? WHERE id = ?")
      .run(remoteUrl, localPath, id);
  },

  remove(id: string): void {
    getDb().prepare("DELETE FROM plates WHERE id = ?").run(id);
  },
};

interface PlateRow {
  id: string;
  project_id: string;
  kind: string;
  key: string;
  label: string;
  description: string;
  remote_url: string | null;
  local_path: string | null;
  created_at: string;
}

function rowToPlate(row: PlateRow): Plate {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind === "prop" ? "prop" : "location",
    key: row.key,
    label: row.label,
    description: row.description,
    remoteUrl: row.remote_url,
    localPath: row.local_path,
    createdAt: row.created_at,
  };
}

/**
 * Cancellation.
 *
 * A queued job can be cancelled outright — nothing has started. A running one
 * is marked cancelled too, but the work already in flight at the provider keeps
 * going; there is no way to recall a submitted render. The runner notices on
 * its next poll and stops rather than writing the result, so the credits are
 * spent either way — cancelling saves you the *wait*, not the money. Saying so
 * plainly matters more than pretending otherwise.
 */
export const cancellation = {
  cancel(id: string): Job | null {
    const db = getDb();
    db.prepare(
      `UPDATE jobs SET status = 'cancelled', error = ?, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'running')`,
    ).run("Cancelled.", nowIso(), id);
    return jobs.get(id);
  },

  /** Cancel everything still pending for a project — the "stop it all" button. */
  cancelPending(input: { projectId?: string; creatorId?: string }): number {
    const db = getDb();
    const where = input.projectId ? "project_id = ?" : "creator_id = ?";
    const value = input.projectId ?? input.creatorId;
    if (!value) return 0;
    const result = db
      .prepare(
        `UPDATE jobs SET status = 'cancelled', error = ?, updated_at = ?
         WHERE ${where} AND status IN ('queued', 'running')`,
      )
      .run("Cancelled.", nowIso(), value);
    return result.changes;
  },

  /** Has this job been cancelled out from under a running handler? */
  isCancelled(id: string): boolean {
    const row = getDb()
      .prepare("SELECT status FROM jobs WHERE id = ?")
      .get<{ status: string }>(id);
    return row?.status === "cancelled";
  },
};

export const assets = {
  create(input: {
    kind: AssetKind;
    projectId?: string | null;
    sceneId?: string | null;
    creatorId?: string | null;
    remoteUrl?: string | null;
    localPath?: string | null;
    prompt?: string | null;
    meta?: Record<string, unknown>;
  }): Asset {
    const db = getDb();
    const id = newId("ast");
    db.prepare(
      `INSERT INTO assets (id, kind, project_id, scene_id, creator_id, remote_url, local_path, prompt, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.kind,
      input.projectId ?? null,
      input.sceneId ?? null,
      input.creatorId ?? null,
      input.remoteUrl ?? null,
      input.localPath ?? null,
      input.prompt ?? null,
      JSON.stringify(input.meta ?? {}),
      nowIso(),
    );
    return assets.get(id)!;
  },

  get(id: string): Asset | null {
    const row = getDb().prepare("SELECT * FROM assets WHERE id = ?").get<AssetRow>(id);
    return row ? toAsset(row) : null;
  },

  forProject(projectId: string): Asset[] {
    const rows = getDb()
      .prepare("SELECT * FROM assets WHERE project_id = ? ORDER BY created_at ASC")
      .all<AssetRow>(projectId);
    return rows.map(toAsset);
  },

  /**
   * Latest asset of a kind for a scene, optionally scoped to a creator.
   * Scoping by creator is what lets the swap view show both versions.
   */
  latestForScene(sceneId: string, kind: AssetKind, creatorId?: string): Asset | null {
    const sql = creatorId
      ? "SELECT * FROM assets WHERE scene_id = ? AND kind = ? AND creator_id = ? ORDER BY created_at DESC LIMIT 1"
      : "SELECT * FROM assets WHERE scene_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1";
    const params = creatorId ? [sceneId, kind, creatorId] : [sceneId, kind];
    const row = getDb().prepare(sql).get<AssetRow>(...params);
    return row ? toAsset(row) : null;
  },

  remove(id: string): void {
    getDb().prepare("DELETE FROM assets WHERE id = ?").run(id);
  },
};

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const jobs = {
  create(input: {
    type: JobType;
    projectId?: string | null;
    sceneId?: string | null;
    creatorId?: string | null;
    payload?: Record<string, unknown>;
  }): Job {
    const db = getDb();
    const id = newId("job");
    const ts = nowIso();
    db.prepare(
      `INSERT INTO jobs (id, type, status, project_id, scene_id, creator_id, input, progress, created_at, updated_at)
       VALUES (?, ?, 'queued', ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      id,
      input.type,
      input.projectId ?? null,
      input.sceneId ?? null,
      input.creatorId ?? null,
      JSON.stringify(input.payload ?? {}),
      ts,
      ts,
    );
    return jobs.get(id)!;
  },

  get(id: string): Job | null {
    const row = getDb().prepare("SELECT * FROM jobs WHERE id = ?").get<JobRow>(id);
    return row ? toJob(row) : null;
  },

  /**
   * Is a job of this type still in flight for this scene?
   *
   * Used by the video stage to wait for the scene's voice-over instead of
   * racing it: both are queued together, and with concurrency > 1 the video job
   * can be claimed while the last voice jobs are still running.
   */
  /** Is a project-wide job of this type already queued or running? */
  isPendingForProject(projectId: string, type: JobType): boolean {
    const row = getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE project_id = ? AND type = ? AND status IN ('queued','running')",
      )
      .get<{ n: number }>(projectId, type);
    return (row?.n ?? 0) > 0;
  },

  /** Is anything at all still in flight for this project, of any type? */
  anyPendingForProject(projectId: string): boolean {
    const row = getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE project_id = ? AND status IN ('queued','running')",
      )
      .get<{ n: number }>(projectId);
    return (row?.n ?? 0) > 0;
  },

  isPendingForScene(sceneId: string, type: JobType, creatorId?: string): boolean {
    const sql = creatorId
      ? "SELECT COUNT(*) AS n FROM jobs WHERE scene_id = ? AND type = ? AND creator_id = ? AND status IN ('queued','running')"
      : "SELECT COUNT(*) AS n FROM jobs WHERE scene_id = ? AND type = ? AND status IN ('queued','running')";
    const params = creatorId ? [sceneId, type, creatorId] : [sceneId, type];
    const row = getDb().prepare(sql).get<{ n: number }>(...params);
    return (row?.n ?? 0) > 0;
  },

  /**
   * Is a job of this type still in flight for this creator?
   *
   * The identity sheet needs it: creating a creator with no photos queues a
   * bootstrap render and the sheet together, and with concurrency > 1 the sheet
   * is claimed while the bootstrap is still running — so it would look for seed
   * references that do not exist yet.
   */
  isPendingForCreator(creatorId: string, type: JobType): boolean {
    const row = getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE creator_id = ? AND type = ? AND status IN ('queued','running')",
      )
      .get<{ n: number }>(creatorId, type);
    return (row?.n ?? 0) > 0;
  },

  /** Claim the oldest queued job, marking it running in the same statement. */
  /**
   * Take the next queued job, if the whole process has room for it.
   *
   * The capacity check belongs in here, inside the same transaction as the
   * claim, and not in the runner's local counter — because there is more than
   * one runner. Next.js compiles server components and route handlers into
   * separate module graphs, so `runner.ts` is instantiated twice in one
   * process, each copy holding its own `running` count and each willing to run
   * a full three jobs.
   *
   * Measured, not inferred. A production build logging a per-instance id
   * printed two of them at boot, and a burst of six creators with this check
   * removed peaked at six concurrent jobs, split evenly between the two
   * instances; with the check it peaks at three. On a provider with rate
   * limits, double the intended concurrency is how a batch starts failing for
   * reasons nothing in the code appears to explain.
   *
   * Note this does not reproduce under `next dev`, which instantiates the
   * module once — so the bug is invisible in development and only appears in
   * the build that gets deployed.
   *
   * The `jobs` table is the one thing both copies share, so it is the only
   * place the limit can actually be enforced.
   */
  claimNext(limit: number): Job | null {
    const db = getDb();
    const claim = db.transaction((): Job | null => {
      const busy = db
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'")
        .get<{ n: number }>();
      if ((busy?.n ?? 0) >= limit) return null;

      const row = db
        .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
        .get<JobRow>();
      if (!row) return null;
      db.prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?").run(
        nowIso(),
        row.id,
      );
      return toJob({ ...row, status: "running" });
    });
    return claim();
  },

  setProgress(id: string, progress: number): void {
    getDb()
      .prepare("UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?")
      .run(Math.max(0, Math.min(100, Math.round(progress))), nowIso(), id);
  },

  succeed(id: string, result: Record<string, unknown>): void {
    getDb()
      .prepare(
        "UPDATE jobs SET status = 'succeeded', progress = 100, result = ?, error = NULL, updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(result), nowIso(), id);
  },

  fail(id: string, error: string): void {
    getDb()
      .prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(error.slice(0, 2000), nowIso(), id);
  },

  forProject(projectId: string): Job[] {
    const rows = getDb()
      .prepare("SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 200")
      .all<JobRow>(projectId);
    return rows.map(toJob);
  },

  forCreator(creatorId: string): Job[] {
    const rows = getDb()
      .prepare("SELECT * FROM jobs WHERE creator_id = ? ORDER BY created_at DESC LIMIT 100")
      .all<JobRow>(creatorId);
    return rows.map(toJob);
  },

  active(): Job[] {
    const rows = getDb()
      .prepare("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at ASC")
      .all<JobRow>();
    return rows.map(toJob);
  },

  /** Re-queue jobs orphaned by a server restart. */
  requeueStale(): number {
    const info = getDb()
      .prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'")
      .run(nowIso());
    return info.changes;
  },
};
