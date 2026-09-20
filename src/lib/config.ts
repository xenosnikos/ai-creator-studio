import path from "node:path";

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const dataDir = path.resolve(process.cwd(), env("DATA_DIR", "./data"));

export const config = {
  dataDir,
  dbPath: path.join(dataDir, "studio.db"),
  assetsDir: path.join(dataDir, "assets"),

  anthropic: {
    apiKey: optional("ANTHROPIC_API_KEY"),
    // Sonnet by default for cost. Storyboards and identity descriptions are the
    // quality-sensitive calls, so ANTHROPIC_MODEL=claude-opus-5 (or the model
    // box in Settings) is the upgrade path if output quality matters more.
    model: env("ANTHROPIC_MODEL", "claude-sonnet-5"),
  },

  kie: {
    apiKey: optional("KIE_API_KEY"),
    baseUrl: env("KIE_BASE_URL", "https://api.kie.ai").replace(/\/+$/, ""),
    // File upload lives on a different host from the job API. Verified against
    // a live account: api.kie.ai returns 404 for the upload path.
    uploadBaseUrl: env("KIE_UPLOAD_BASE_URL", "https://kieai.redpandaai.co").replace(/\/+$/, ""),
    /**
     * Whether the image provider's own NSFW post-filter stays on.
     *
     * A documented, vendor-exposed toggle rather than anything clever: the same
     * switch sits in their playground UI. It is turned off here because the
     * filter's false positives are the problem this pipeline kept hitting —
     * ordinary retail clothing refused or silently replaced with something
     * tamer — and the operator, who owns the account and is billed for it, has
     * made that call for their own commercial fashion work.
     *
     * Left as an env var so it stays a deliberate, visible setting. The
     * provider's own warning applies: with it off, nothing is filtered, and
     * what the model returns is the operator's responsibility.
     */
    nsfwChecker: env("KIE_NSFW_CHECKER", "false") === "true",
    models: {
      /**
       * Every image the pipeline makes: creator portraits, identity sheets,
       * scene keyframes and empty location plates. Passing reference images is
       * what selects image-to-image, so one id covers both directions.
       */
      image: env("KIE_IMAGE_MODEL", "nano-banana-pro"),
      /**
       * A second image model, tried when the first refuses a render on content
       * grounds.
       *
       * Not a quality choice — the first model is the better one and stays the
       * default. This exists because image models are moderated by their
       * vendors, and the vendors do not agree on where ordinary fashion stops.
       * A perfectly normal wardrobe reference — an evening dress with a high
       * slit — is refused by one and rendered by another, which leaves an
       * operator staring at a policy error for a garment a client actually
       * asked for.
       *
       * This is a routing decision between vendors, not an attempt to get
       * anything past a filter: the same prompt and the same references are
       * sent, unaltered. If both refuse, the render fails and says so.
       */
      imageFallback: env("KIE_IMAGE_FALLBACK_MODEL", "seedream/5-pro-image-to-image"),
      /**
       * Takes the voice track as a reference and generates speech-synchronised
       * motion in one pass, so no lip-sync repair pass is needed. This is the
       * only video model: the image-to-video route it replaced produced clips
       * whose mouths never moved, which is not usable output for this app.
       */
      videoSpeech: env("KIE_VIDEO_MODEL_SPEECH", "bytedance/seedance-2-fast"),
      voiceTTS: env("KIE_VOICE_MODEL_TTS", "elevenlabs/text-to-speech-multilingual-v2"),
      // Verified against a live KIE account: this id exists and its schema is
      // the one the adapter sends.
      lipSync: env("KIE_LIPSYNC_MODEL", "volcengine/video-to-video-lip-sync"),
      /**
       * Lip-sync quality tier. `basic` adds scene detection and speaker
       * identification, which is what keeps the mouth on the right face when a
       * shot cuts or holds more than one person; `lite` is cheaper and does
       * neither. Talking-head reels are exactly the case `basic` is for.
       */
      lipSyncMode: env("KIE_LIPSYNC_MODE", "basic"),
    },
  },

  /**
   * ElevenLabs, called directly. Exists because the same models reached through
   * KIE return a 500 for every request; going direct is the only route to a
   * stable, addressable voice id, which is what creator consistency needs.
   */
  elevenLabs: {
    apiKey: optional("ELEVENLABS_API_KEY"),
    /**
     * v3 is markedly more natural than multilingual_v2 and is what fixes
     * "sounds like a robot". It also understands inline delivery tags
     * (`[warmly]`), which are interpreted rather than read aloud — verified by
     * transcribing the output and confirming the tags do not appear.
     */
    model: env("ELEVENLABS_MODEL", "eleven_v3"),
    outputFormat: env("ELEVENLABS_OUTPUT_FORMAT", "mp3_44100_128"),
  },

  providers: {
    image: env("IMAGE_PROVIDER", "kie"),
    video: env("VIDEO_PROVIDER", "kie"),
    // Never `kie`: its ElevenLabs passthrough is a dead route (see
    // lib/settings.ts). The live selection is made in lib/settings.ts, which
    // is credential-aware; this default only matters to anything reading the
    // raw config, and pointing it at a route that cannot work is a trap.
    voice: env("VOICE_PROVIDER", "elevenlabs"),
    lipSync: env("LIPSYNC_PROVIDER", "kie"),
    llm: env("LLM_PROVIDER", "anthropic"),
  },

  /**
   * Stock-photo sources for automatic location references.
   *
   * Both optional and both free. Without either, the app falls back to
   * Openverse, which needs no key — so this works on a fresh install and simply
   * looks better once a key is added.
   */
  photos: {
    unsplashAccessKey: env("UNSPLASH_ACCESS_KEY", ""),
    pexelsApiKey: env("PEXELS_API_KEY", ""),
  },
  video: {
    /**
     * Extra seconds appended to the measured narration length when
     * commissioning a clip. Ending a shot on the exact final syllable reads as
     * a hard cut; a short tail lets the motion settle.
     */
    tailPaddingSeconds: Number(env("VIDEO_TAIL_PADDING_SECONDS", "0.6")),
  },

  jobs: {
    pollIntervalMs: int("JOB_POLL_INTERVAL_MS", 4000),
    /**
     * Generous, because the ceiling has to clear the slowest provider on a bad
     * day rather than a typical one. A clip usually lands in 5-8 minutes; under
     * load the provider has taken longer than 15, and a client-side deadline
     * that fires first turns a retryable provider timeout into a dead job.
     */
    timeoutMs: int("JOB_TIMEOUT_MS", 30 * 60 * 1000),
  },
} as const;
