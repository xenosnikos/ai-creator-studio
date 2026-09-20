/**
 * AI Creator Studio — local MCP server.
 *
 * Exposes the studio's HTTP API as conversational tools so an agent (Hermes)
 * can drive content generation end-to-end: script + grounded imagery links in,
 * a first-pass storyboard out for review, and media generation only after an
 * explicit human approval step.
 *
 * Stdio MCP, zero dependencies beyond Node 22 (matches the app itself).
 *   node mcp-server.mjs          (STUDIO_URL defaults to http://localhost:3000)
 *
 * Install into Hermes:
 *   hermes mcp add ai-creator-studio --command node --args /path/to/mcp-server.mjs
 */
import { createServer } from "node:net";
import { spawn } from "node:child_process";

const STUDIO_URL = process.env.STUDIO_URL?.replace(/\/+$/, "") || "http://localhost:3000";

/* ---------- minimal JSON-RPC-over-stdio MCP (2025-06-18 spec subset) ---------- */

class LineBuffer {
  #buf = "";
  push(chunk, onLine) {
    this.#buf += chunk;
    let idx;
    while ((idx = this.#buf.indexOf("\n")) !== -1) {
      const line = this.#buf.slice(0, idx).trim();
      this.#buf = this.#buf.slice(idx + 1);
      if (line) onLine(line);
    }
  }
}

const TOOLS = [
  {
    name: "list_creators",
    description: "List virtual creators with their reference-photo counts. A creator needs references before identity can be preserved.",
    inputSchema: { type: "object", properties: {} },
    run: () => studio("GET", "/api/creators"),
  },
  {
    name: "list_projects",
    description: "List projects with their storyboard/approval/render status.",
    inputSchema: { type: "object", properties: {} },
    run: () => studio("GET", "/api/projects"),
  },
  {
    name: "get_project",
    description: "Get one project: scenes with dialogue, job state, asset URLs. The storyboard first pass lives here.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
    run: (args) => studio("GET", `/api/projects/${args.projectId}`),
  },
  {
    name: "create_project",
    description: "Create a project from a script and grounded imagery links. autoStoryboard defaults true: the storyboard (scenes, narration, shot types) is drafted WITHOUT generating any media. Reference arrays accept public https URLs. kind: 'video' or 'photo'.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        script: { type: "string", description: "The brief or full script" },
        creatorId: { type: "string" },
        kind: { type: "string", enum: ["video", "photo"], default: "video" },
        locationRefs: { type: "array", items: { type: "string" }, description: "https URLs of the actual places" },
        wardrobeRefs: { type: "array", items: { type: "string" }, description: "https URLs of the clothes to wear" },
        styleRefs: { type: "array", items: { type: "string" }, description: "https URLs for grade/film-stock feel" },
        sceneCount: { type: "integer", minimum: 1, maximum: 30 },
        durationSeconds: { type: "integer", minimum: 3, maximum: 450 },
      },
      required: ["script", "creatorId"],
    },
    run: (args) =>
      studio("POST", "/api/projects", {
        title: args.title || "Untitled project",
        prompt: args.script,
        transcript: args.script,
        creatorId: args.creatorId,
        settings: {
          kind: args.kind || "video",
          photoCount: 4,
          aspectRatio: "9:16",
          targetDurationSeconds: args.durationSeconds ?? 45,
          requestedSceneCount: args.sceneCount,
          videoResolution: "720p",
          globalStyle: "",
          look: "social",
          music: { mood: "cinematic", level: 0.18 },
          roomTone: "light",
        },
        backgroundRefs: args.locationRefs || [],
        wardrobeRefs: args.wardrobeRefs || [],
        styleRefs: args.styleRefs || [],
        autoStoryboard: true,
        autoRender: false,
      }),
  },
  {
    name: "regenerate_storyboard",
    description: "Re-draft the storyboard only (scenes, narration, shot list). No media is generated. Use to revise after feedback — include the feedback in the script.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        script: { type: "string", description: "Revised brief/script. Omit to re-roll the existing brief." },
      },
      required: ["projectId"],
    },
    run: async (args) => {
      if (args.script) {
        await studio("PATCH", `/api/projects/${args.projectId}`, { prompt: args.script, transcript: args.script });
      }
      return studio("POST", `/api/projects/${args.projectId}/storyboard`, {});
    },
  },
  {
    name: "approve_storyboard",
    description: "HUMAN GATE. Approve the storyboard; this is the explicit cost gate before any media generation. Only call when the user has reviewed the scenes and said yes.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
    run: (args) => studio("POST", `/api/projects/${args.projectId}/approve-storyboard`, {}),
  },
  {
    name: "render",
    description: "Generate media for approved storyboards. Stages: 'image' (preview stills), 'voice' (narration), 'video' (clips), 'cut' (final assembly). Render stills first for an identity/quality check before spending video credits.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        stages: { type: "array", items: { type: "string", enum: ["image", "voice", "video", "cut"] } },
        sceneIds: { type: "array", items: { type: "string" } },
      },
      required: ["projectId", "stages"],
    },
    run: (args) => studio("POST", `/api/projects/${args.projectId}/render`, { stages: args.stages, sceneIds: args.sceneIds }),
  },
  {
    name: "job_status",
    description: "Poll job status (queued/running/succeeded/failed + error).",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    run: () => studio("GET", "/api/jobs"),
  },
  {
    name: "list_voices",
    description: "List available voices for narration.",
    inputSchema: { type: "object", properties: {} },
    run: () => studio("GET", "/api/voices"),
  },
];

/* ---------- studio HTTP client ---------- */

async function studio(method, path, body) {
  const response = await fetch(`${STUDIO_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  if (!response.ok) {
    throw new Error(`studio ${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

/* ---------- JSON-RPC dispatch ---------- */

const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const buffer = new LineBuffer();
buffer.push.bind(buffer);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => buffer.push(chunk, handleLine));
process.stdin.on("end", () => process.exit(0));

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // not JSON-RPC; ignore
  }
  const { jsonrpc, id, method, params } = msg;
  if (jsonrpc !== "2.0" || !method) return;

  if (method === "initialize") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "ai-creator-studio", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") {
    write({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
    });
    return;
  }
  if (method === "tools/call") {
    const toolName = params?.name;
    const tool = TOOLS.find((t) => t.name === toolName);
    if (!tool) {
      write({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${toolName}` } });
      return;
    }
    Promise.resolve()
      .then(() => tool.run(params?.arguments ?? {}))
      .then((result) => {
        write({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 1).slice(0, 18000) }],
          },
        });
      })
      .catch((error) => {
        write({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `ERROR: ${error.message}` }],
            isError: true,
          },
        });
      });
    return;
  }
  if (id !== undefined) write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

// Keep the process alive on a dangling socket handle pattern (stdio servers
// sometimes exit early when stdin is a pipe that buffers); no-op.
setInterval(() => {}, 1 << 30);
