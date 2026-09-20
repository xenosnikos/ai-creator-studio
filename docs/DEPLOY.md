# Running and hosting it

Three options, in increasing order of effort. Option 1 works in about two minutes and is
what you want for evaluating the POC.

---

## 1. Run it on your own machine (recommended for review)

`localhost` is your own computer — these addresses only work once the app is running there.
They are not public URLs.

### With Docker (nothing else to install)

```bash
cd studio
docker compose up
```

Open **http://localhost:3000**. Your work persists in the `studio-data` volume across
restarts and rebuilds.

> The `Dockerfile` and `docker-compose.yml` could not be executed in the environment where
> this was developed (no Docker daemon available), so the image build itself is unverified.
> What *was* verified is everything the image runs: the standalone Next.js bundle,
> `node server.js`, `DATA_DIR`, first-boot seeding, generation and export. If the build
> trips on something, Option B below is the tested path.

### With Node

Requires **Node 22.5+** ([nodejs.org](https://nodejs.org) — the LTS installer). Nothing
compiles: the database uses Node's built-in SQLite.

```bash
cd studio
npm install
npm run dev
```

Open **http://localhost:3000**.

Nothing to configure first: the app creates its database, seeds three sample creators and an
example project on first boot, and starts in placeholder mode so the whole workflow runs
offline at zero cost.

### Switching to real generation

Open **Settings** in the app, paste your Anthropic and KIE keys, press **Test** on each, then
**Save**. Saving flips the matching stages from placeholder to live automatically; no restart
and no file editing. The badge in the top-right always tells you which mode you are in.

Environment variables (`ANTHROPIC_API_KEY`, `KIE_API_KEY`) still work and are used as a
fallback when nothing is saved in the app — handy for servers and CI.

---

## Sharing it with someone else

Whatever route you pick below, **set a password first**:

```bash
# macOS / Linux
SHARE_PASSWORD='pick-something-long' npm run dev

# Windows (cmd)
set SHARE_PASSWORD=pick-something-long && npm run dev
```

Every page and API route then asks for it. Any username works — only the password
is checked. Without it, anyone who gets the URL can generate content and spend the
credits on your saved API keys.

This is a share gate, not an auth system: one shared secret, no accounts, no
sessions, no lockout after failed attempts. It is the right size for "let my boss
try this", and the wrong size for real users.

### Quickest: one command

```bash
npm run share
```

Builds if needed, generates a password, starts the server with the gate on, opens a
Cloudflare quick tunnel, and prints the link and password together. Ctrl-C stops
both processes. Set `SHARE_PASSWORD` first to choose your own password.

Equivalent by hand, if you prefer two terminals:

```bash
SHARE_PASSWORD='...' npm run dev          # terminal 1
npx untun@latest tunnel http://localhost:3000   # terminal 2
```

Trade-offs, so nobody is surprised:

- Your machine must stay awake with both terminals open. Close either and the link dies.
- The URL is temporary and changes every time you restart the tunnel.
- All the generation traffic runs through your machine and your API keys.

> The tunnel itself could not be tested from the environment where this was
> developed — outbound tunnel ports are blocked there. What *was* verified is the
> rest of `npm run share`: password generation, starting the server with the gate
> active, waiting for readiness, 401 without the password and 200 with it, and a
> clear fallback message when the tunnel is unreachable (that failure path is
> exactly what the blocked network exercised). On a normal network the tunnel is a
> standard tool; if it is blocked for you too, host it instead.

### Better for a real demo: host it

A hosted deployment gives a stable URL that works when your laptop is closed. See
the next section — the only hard requirement is a persistent disk.

---

## 2. Host it on a server with a persistent disk

Good for sharing a link with your team. Works on **Railway**, **Render**, **Fly.io**,
**DigitalOcean App Platform**, or any VPS.

The one hard requirement is a **persistent volume**, because the app keeps its database and
every generated file on disk. Without one, a restart loses every creator, project and render.

```dotenv
DATA_DIR=/data          # point this at the mounted volume
```

Build and start:

```bash
npm ci && npm run build     # build
npm start                   # start (listens on $PORT)
```

`npm start` runs the standalone server directly. It is **not** `next start` — that command
refuses to run under this project's `output: "standalone"` config and exits without serving,
which is a deploy that builds green and then never answers a request.

Set `ANTHROPIC_API_KEY` and `KIE_API_KEY` (and `ELEVENLABS_API_KEY` for voice and music) in
the host's dashboard — do not commit them. You can also add them on the Settings page after
deploying; they are written to the mounted volume with `0600` permissions and are never sent
back to the browser.

---

### Railway, step by step

Railway can deploy this two ways. **Use the Dockerfile** — it pins Node 22, sets `DATA_DIR`,
runs unprivileged and has a health check already. The Nixpacks path works too and is noted at
the end.

**1. Get the code into a repo.** Push to GitHub, or run `railway up` from this folder to
upload it directly.

**2. New Project → Deploy from GitHub repo.** Railway finds the `Dockerfile` and uses it. The
build takes a few minutes, mostly `npm ci` and the Next build.

**3. Add the volume before the first real use.**

> Railway → your service → **Data** → **Add Volume**
> Mount path: `/data`

Do this early. Attaching a volume restarts the service, and anything generated before it was
attached lived on the container filesystem and is gone.

Size it for video. A finished 30-second piece is roughly 10–30 MB once you count the
keyframes, the per-scene clips and the final cut, and nothing is deleted unless you delete
the project. 5 GB is a comfortable start for a demo; 1 GB is enough for about thirty pieces.

**4. Set the variables.**

| Variable | Value | Why |
| --- | --- | --- |
| `DATA_DIR` | `/data` | Must match the volume's mount path. |
| `SHARE_PASSWORD` | something long | **Set this.** See below. |
| `ANTHROPIC_API_KEY` | `sk-ant-…` | Storyboards. |
| `KIE_API_KEY` | your key | Images and video. |
| `ELEVENLABS_API_KEY` | `sk_…` | Voice and music. |
| `AUTO_SEED` | `false` | Optional — skips the three sample creators. |

Do **not** set `PORT` or `HOSTNAME`. Railway injects `PORT`, and the Dockerfile already binds
`0.0.0.0`. Overriding either is the usual cause of "deploy succeeded, site unreachable".

**5. Generate a domain.** Settings → Networking → **Generate Domain**. Railway gives you a
`*.up.railway.app` URL and routes to the container's port automatically.

**6. Check it came up.** `https://your-app.up.railway.app/api/health` returns which providers
are live and whether each one's key is present — the fastest way to tell a missing key from a
broken deploy.

---

### Set SHARE_PASSWORD

This app has **no accounts and no login**. Everything it can do — spending your Anthropic,
KIE and ElevenLabs credits — is available to anyone who opens the URL, and a
`*.up.railway.app` address is public the moment it exists.

`SHARE_PASSWORD` turns on HTTP Basic auth across every page and every API route. Any username
works; the password is what is checked. It is one shared secret, not an auth system — enough
to hand a link to your boss, not enough to leave running unattended for a month.

Verified behaviour with it set: `401` on every route without credentials, `401` with the
wrong password, `200` with the right one.

---

### What is already handled for you

- **ffmpeg** ships inside the build. The joining, the room tone and the music mix all need
  it, and `ffmpeg-static` (~80 MB) is bundled into the standalone output — no apt package, no
  buildpack, nothing to install. `/api/health` will tell you if it ever goes missing.
- **sharp** ships its Linux x64 binaries the same way.
- **SQLite** is Node's built-in `node:sqlite`. Nothing compiles at install time.
- **The job queue** runs in-process and starts with the server; a restart re-queues anything
  that was mid-flight.

### Two things to know about the runtime

**One instance only.** The queue and its concurrency limit live in the app's own SQLite file.
Two instances against one volume would both drain the same queue and neither would respect
the other's limit. Leave the replica count at 1.

**Do not let it sleep.** Renders run in the background after the HTTP response has been sent.
If the service is configured to sleep when idle, it will stop mid-render — the request that
started it has already returned, so there is no traffic keeping it awake. Turn off app
sleeping on any plan that offers it.

### If you would rather not use the Dockerfile

Railway's Nixpacks builder works: it detects Node, runs `npm ci && npm run build`, and starts
with `npm start`. Set the same variables plus a volume. The Dockerfile is still the better
choice — it pins the Node version, and Nixpacks picking a different one is a class of failure
you do not need.

There is one thing to get right either way: the start command must be `npm start` (or
`node .next/standalone/server.js`). `next start` does not work here.

---

## 3. Vercel — needs changes first

Vercel is the natural home for Next.js, but **this POC will not work there as written**, and
it is worth being clear about why rather than letting you discover it after deploying:

| What the POC does | Why serverless breaks it | What to swap in |
| --- | --- | --- |
| SQLite file on disk (`node:sqlite`) | No persistent filesystem; each invocation is fresh | Postgres (Neon / Supabase / Vercel Postgres) |
| Writes generated assets to `DATA_DIR/assets` | Same — writes vanish | S3 / R2 / Vercel Blob |
| In-process job runner started at boot | Functions do not stay alive between requests | A queue (Inngest, QStash, Trigger.dev) or a worker service |

None of that is difficult, but it is a real port, not a config change. The layering makes it
tractable: `lib/repo.ts` is the only place that touches SQL, `lib/storage.ts` is the only
place that touches the filesystem, and `lib/jobs/runner.ts` is the only place that schedules
work. Swapping all three is roughly a day of work and touches no UI, no route and no prompt
code.

If you want a hosted demo quickly, **option 2 is the shorter path.**

---

## Regenerating the screenshots

The `screenshots/` folder is produced from the running app:

```bash
npm run build && npm start   # in one terminal
npm run screenshots    # in another
```

Set `CHROMIUM_PATH` if your environment provides its own Chromium build.
