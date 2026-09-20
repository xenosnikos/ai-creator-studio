"use client";

import { useState } from "react";

import { api } from "@/lib/client";
import type { KeyState, SettingsSnapshot } from "@/lib/settings-snapshot";

interface TestResult {
  ok: boolean;
  message: string;
  detail?: string;
}

const SOURCE_LABEL: Record<KeyState["source"], string> = {
  settings: "saved here",
  env: "from .env.local",
  default: "not set",
};

/**
 * Settings.
 *
 * Keys are write-only from the browser's perspective: you can set one and test
 * one, but the server never sends a usable key back — only a masked hint. The
 * "Test" button hits the real service so a bad paste is caught here rather than
 * halfway through a render job.
 */
export function SettingsForm({ initial }: { initial: SettingsSnapshot }) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>(initial);
  const [anthropicKey, setAnthropicKey] = useState("");
  const [kieKey, setKieKey] = useState("");
  const [elevenLabsKey, setElevenLabsKey] = useState("");
  const [tests, setTests] = useState<Record<string, TestResult | "running">>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function test(target: "anthropic" | "kie" | "elevenlabs", apiKey: string) {
    setTests((current) => ({ ...current, [target]: "running" }));
    try {
      const result = await api<TestResult>("/api/settings/test", {
        method: "POST",
        body: JSON.stringify({ target, apiKey: apiKey.trim() || undefined }),
      });
      setTests((current) => ({ ...current, [target]: result }));
    } catch (cause) {
      setTests((current) => ({
        ...current,
        [target]: {
          ok: false,
          message: cause instanceof Error ? cause.message : String(cause),
        },
      }));
    }
  }

  async function save(patch: Record<string, string>) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api<SettingsSnapshot>("/api/settings", {
        method: "POST",
        body: JSON.stringify(patch),
      });
      setSnapshot(next);
      setAnthropicKey("");
      setKieKey("");
      setElevenLabsKey("");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const typedCount = [anthropicKey, kieKey, elevenLabsKey].filter((k) => k.trim()).length;
  const nothingTyped = typedCount === 0;
  // Keys supplied through the environment need no saving, which is the usual
  // reason the button is inert — worth saying out loud rather than leaving the
  // user clicking a dead control.
  const anyFromEnv = [
    snapshot.keys.anthropic,
    snapshot.keys.kie,
    snapshot.keys.elevenLabs,
  ].some((k) => k.source === "env");

  const liveMode =
    snapshot.providers.llm !== "mock" &&
    snapshot.providers.image !== "mock" &&
    snapshot.keys.anthropic.configured &&
    snapshot.keys.kie.configured;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">
          Add your API keys here to switch from placeholder output to real generation. Keys
          are stored on this machine only and are never sent back to the browser.
        </p>
      </div>

      <div
        className={`panel p-4 text-sm ${
          liveMode ? "border-emerald-400/40 bg-emerald-400/5" : "border-amber-400/40 bg-amber-400/5"
        }`}
      >
        <p className={liveMode ? "text-emerald-200" : "text-amber-200"}>
          {liveMode
            ? "Live — generations run on your API keys."
            : "Placeholder mode — the full workflow runs, but every asset is sample output."}
        </p>
      </div>

      {/*
        Voice fails differently from everything else: without an ElevenLabs key
        the render still completes, just silently, and the missing narration is
        only visible on the scene card afterwards. Say it here instead.
      */}
      {snapshot.providers.voice === "mock" && !snapshot.keys.elevenLabs.configured ? (
        <div className="note note-warn">
          <strong className="font-semibold">No voice yet.</strong> Clips will render without
          narration until an ElevenLabs key is saved below. The KIE key cannot cover this —
          its voice endpoint returns &ldquo;please try again later&rdquo; for every request,
          so voice is deliberately never routed through it.
        </div>
      ) : null}

      {/* --- keys ---------------------------------------------------------- */}
      <section className="panel space-y-5 p-5">
        <h2 className="section-title">API keys</h2>

        <KeyField
          id="anthropic"
          label="Anthropic API key"
          help={
            <>
              Writes storyboards and scripts, and reads reference photos into a locked
              identity description. Get one at{" "}
              <a
                className="text-accent hover:underline"
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noreferrer"
              >
                console.anthropic.com
              </a>
              .
            </>
          }
          placeholder="sk-ant-api03-…"
          value={anthropicKey}
          onChange={setAnthropicKey}
          state={snapshot.keys.anthropic}
          test={tests.anthropic}
          onTest={() => test("anthropic", anthropicKey)}
          onClear={() => save({ anthropicApiKey: "" })}
          busy={busy}
        />

        <KeyField
          id="kie"
          label="KIE AI API key"
          help={
            <>
              Generates images and video. Does <strong>not</strong> cover voice — that runs
              on the ElevenLabs key below. Get one at{" "}
              <a
                className="text-accent hover:underline"
                href="https://kie.ai/api-key"
                target="_blank"
                rel="noreferrer"
              >
                kie.ai/api-key
              </a>
              .
            </>
          }
          placeholder="Your KIE key"
          value={kieKey}
          onChange={setKieKey}
          state={snapshot.keys.kie}
          test={tests.kie}
          onTest={() => test("kie", kieKey)}
          onClear={() => save({ kieApiKey: "" })}
          busy={busy}
        />

        <KeyField
          id="elevenlabs"
          label="ElevenLabs API key (voice)"
          help={
            <>
              Generates the voice-over. A free account is enough — just pick one of the
              <strong> premade</strong> voices, since Voice Library entries are refused on
              free plans. Key from{" "}
              <a
                className="text-accent hover:underline"
                href="https://elevenlabs.io/app/settings/api-keys"
                target="_blank"
                rel="noreferrer"
              >
                elevenlabs.io
              </a>
              .
            </>
          }
          placeholder="sk_…"
          value={elevenLabsKey}
          onChange={setElevenLabsKey}
          state={snapshot.keys.elevenLabs}
          test={tests.elevenlabs}
          onTest={() => test("elevenlabs", elevenLabsKey)}
          onClear={() => save({ elevenLabsApiKey: "" })}
          busy={busy}
        />

        {/*
          A disabled button with no stated reason reads as a broken page — this
          one is switched off whenever every field is blank, which is the normal
          state on arrival, so it has to say why itself.
        */}
        <div className="space-y-2">
          <button
            type="button"
            disabled={busy || nothingTyped}
            title={
              nothingTyped
                ? "Type a key into one of the fields above to enable this"
                : "Save the keys you have typed"
            }
            onClick={() =>
              save({
                ...(anthropicKey.trim() ? { anthropicApiKey: anthropicKey.trim() } : {}),
                ...(kieKey.trim() ? { kieApiKey: kieKey.trim() } : {}),
                ...(elevenLabsKey.trim() ? { elevenLabsApiKey: elevenLabsKey.trim() } : {}),
              })
            }
            className="btn btn-primary btn-lg w-full"
          >
            {busy ? "Saving…" : saved ? "✓ Saved" : `Save ${typedCount || ""} key${typedCount === 1 ? "" : "s"}`.replace("  ", " ")}
          </button>
          {nothingTyped ? (
            <p className="help text-center">
              {anyFromEnv
                ? "Your keys are already loaded from .env.local, so there is nothing to save. Type a key above only if you want to replace one."
                : "Type a key into one of the fields above to enable this button."}
            </p>
          ) : null}
        </div>

        <p className="text-[11px] leading-relaxed text-muted">
          Stored at <span className="font-mono">{snapshot.storagePath}</span> with owner-only
          permissions. Delete that file to remove them. Anything set in{" "}
          <span className="font-mono">.env.local</span> is used as a fallback when nothing is
          saved here.
        </p>
      </section>

      {/*
        Collapsed by default. Pasting three keys is the whole job for almost
        everyone; the per-stage switches exist for offline work and debugging,
        and leaving them open made a simple page look like a control panel.
      */}
      <details className="panel group p-5 [&_summary::-webkit-details-marker]:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
          <span className="section-title">Advanced — per-stage providers</span>
          <span className="text-muted transition group-open:rotate-180">▾</span>
        </summary>
        <div className="mt-4 space-y-4">
        <div>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Set any stage to <span className="font-mono">mock</span> to work offline without
            spending credits. Changes apply to the next generation — no restart needed.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <ProviderSelect
            label="Reasoning (storyboard, script)"
            value={snapshot.providers.llm}
            options={snapshot.available.llm}
            onChange={(value) => save({ llmProvider: value })}
            busy={busy}
          />
          <ProviderSelect
            label="Images"
            value={snapshot.providers.image}
            options={snapshot.available.image}
            onChange={(value) => save({ imageProvider: value })}
            busy={busy}
          />
          <ProviderSelect
            label="Video"
            value={snapshot.providers.video}
            options={snapshot.available.video}
            onChange={(value) => save({ videoProvider: value })}
            busy={busy}
          />
          <ProviderSelect
            label="Voice"
            value={snapshot.providers.voice}
            options={snapshot.available.voice}
            onChange={(value) => save({ voiceProvider: value })}
            busy={busy}
          />
          <ProviderSelect
            label="Lip sync"
            value={snapshot.providers.lipSync}
            options={snapshot.available.lipSync}
            onChange={(value) => save({ lipSyncProvider: value })}
            busy={busy}
          />
        </div>
        <p className="text-xs text-muted">
          Video normally arrives already in sync, so this stage stays idle. It only runs on
          the alternate video path, and if it is unavailable the render still completes — the
          clip and voice are delivered together but not mouth-matched, and the scene says so.
        </p>
        </div>
      </details>

      <div className="panel border-amber-400/30 bg-amber-400/5 p-4 text-xs leading-relaxed text-amber-100/90">
        <p className="font-semibold text-amber-200">If you host this somewhere public</p>
        <p className="mt-1">
          There is no login in this proof of concept. Anyone who can reach the URL can spend
          the credits attached to the keys saved here. Keep it on your own machine, or put it
          behind your host&apos;s password protection first.
        </p>
      </div>

      {error ? (
        <p className="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function KeyField({
  id,
  label,
  help,
  placeholder,
  value,
  onChange,
  state,
  test,
  onTest,
  onClear,
  busy,
}: {
  id: string;
  label: string;
  help: React.ReactNode;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  state: KeyState;
  test: TestResult | "running" | undefined;
  onTest: () => void;
  onClear: () => void;
  busy: boolean;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label className="label mb-0" htmlFor={id}>
          {label}
        </label>
        <span className="text-[11px] text-muted">
          {state.configured ? (
            <>
              <span className="font-mono text-slate-300">{state.hint}</span>
              <span className="ml-1.5">({SOURCE_LABEL[state.source]})</span>
            </>
          ) : (
            <span className="text-amber-300">not configured</span>
          )}
        </span>
      </div>

      <div className="flex gap-2">
        <input
          id={id}
          type="password"
          autoComplete="off"
          className="field font-mono"
          value={value}
          placeholder={state.configured ? "Enter a new key to replace" : placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          disabled={test === "running" || (!value.trim() && !state.configured)}
          onClick={onTest}
          className="btn shrink-0"
        >
          {test === "running" ? "Testing…" : "Test"}
        </button>
        {state.source === "settings" ? (
          <button type="button" disabled={busy} onClick={onClear} className="btn shrink-0">
            Clear
          </button>
        ) : null}
      </div>

      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{help}</p>

      {test && test !== "running" ? (
        <p
          className={`mt-1.5 text-[11px] ${test.ok ? "text-emerald-300" : "text-red-300"}`}
        >
          {test.ok ? "✓" : "✕"} {test.message}
          {test.detail ? <span className="text-muted"> {test.detail}</span> : null}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Display names for provider keys. Anything not listed falls back to the key
 * itself, which is always a vendor name and never a model name.
 */
const PROVIDER_LABELS: Record<string, string> = {
  mock: "mock — offline placeholders",
};

function ProviderSelect({
  label,
  value,
  options,
  onChange,
  busy,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  busy: boolean;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <select
        className="field"
        value={value}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {PROVIDER_LABELS[option] ?? option}
          </option>
        ))}
      </select>
      {/*
        The underlying model id is deliberately not shown. Which models sit
        behind each stage is an implementation detail of this product, and the
        page reads cleaner without a row of opaque slugs under every control.
      */}
      <p className="mt-1 text-[11px] text-faint">
        {value === "mock" ? "Sample output — costs nothing" : "Live"}
      </p>
    </div>
  );
}
