/**
 * Capture screenshots of the running app.
 *
 *   npm run screenshots            # writes to ./screenshots
 *
 * Requires the dev/prod server to already be running on BASE_URL. Used to
 * produce the UI walkthrough without needing a public deployment.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const OUT_DIR = path.resolve(process.cwd(), "screenshots");

async function main(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });

  // Use an explicitly provided Chromium when the environment ships one whose
  // build differs from what this Playwright version would download.
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 2,
  });

  const api = async <T,>(route: string): Promise<T> => {
    const response = await page.request.get(`${BASE_URL}${route}`);
    return (await response.json()) as T;
  };

  const { creators } = await api<{ creators: Array<{ id: string; name: string }> }>(
    "/api/creators",
  );
  const { projects } = await api<{ projects: Array<{ id: string }> }>("/api/projects");
  const mia = creators.find((c) => c.name === "Mia Tanaka") ?? creators[0];
  const projectId = projects[0].id;

  const shots: Array<{ name: string; url: string; full: boolean }> = [
    { name: "01-home", url: "/", full: true },
    { name: "02-creator-library", url: "/creators", full: true },
    { name: "03-creator-identity-sheet", url: `/creators/${mia.id}`, full: true },
    { name: "04-new-creator", url: "/creators/new", full: true },
    { name: "05-new-project", url: "/projects/new", full: true },
    { name: "06-project-workspace", url: `/projects/${projectId}`, full: true },
  ];

  for (const shot of shots) {
    await page.goto(`${BASE_URL}${shot.url}`, { waitUntil: "networkidle" });
    // Let images decode and the job feed settle before capturing.
    await page.waitForTimeout(1200);
    const file = path.join(OUT_DIR, `${shot.name}.png`);
    await page.screenshot({ path: file, fullPage: shot.full });
    console.log(`  ${shot.name.padEnd(30)} ${file}`);
  }

  // The shot editor is behind a disclosure — open the first one and capture it.
  await page.goto(`${BASE_URL}/projects/${projectId}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const editButton = page.getByRole("button", { name: "Edit shot" }).first();
  if (await editButton.count()) {
    await editButton.click();
    await page.waitForTimeout(600);
    const file = path.join(OUT_DIR, "07-shot-editor.png");
    await page.screenshot({ path: file, fullPage: true });
    console.log(`  07-shot-editor${" ".repeat(17)}${file}`);
  }

  await browser.close();
  console.log(`\nWrote ${shots.length + 1} screenshots to ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
