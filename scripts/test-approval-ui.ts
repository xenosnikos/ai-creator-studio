import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const screenshotDir = path.resolve(process.env.UI_SCREENSHOT_DIR ?? "./screenshots/approval");

async function main() {
  await fs.mkdir(screenshotDir, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  async function waitUntilEnabled(locator: ReturnType<typeof page.getByRole>) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await locator.isEnabled()) return;
      await page.waitForTimeout(250);
    }
    assert.fail("button did not become enabled");
  }

  try {
    const creatorResponse = await page.request.get(`${baseUrl}/api/creators`);
    assert.equal(creatorResponse.ok(), true);
    const { creators } = (await creatorResponse.json()) as {
      creators: Array<{ id: string; references: unknown[] }>;
    };
    const creator = creators[0];
    assert.ok(creator, "mock UI test needs one creator");
    if (creator.references.length === 0) {
      const referenceResponse = await page.request.post(
        `${baseUrl}/api/creators/${creator.id}/references`,
        {
          data: {
            images: [
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4wAAAABJRU5ErkJggg==",
            ],
            angle: "front",
            isAnchor: true,
          },
        },
      );
      assert.equal(referenceResponse.status(), 201);
    }

    await page.goto(`${baseUrl}/projects/new`, { waitUntil: "networkidle" });
    await page.getByLabel("Brief").fill(
      "Explain one simple productivity rule directly to camera in one continuous shot.",
    );
    await page.getByRole("button", { name: "1", exact: true }).click();
    assert.equal(await page.getByLabel("Custom duration in seconds").inputValue(), "15");
    await page.screenshot({
      path: path.join(screenshotDir, "01-one-scene-review-mode.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: "Create storyboard for review" }).click();
    await page.waitForURL(/\/projects\/[^/]+$/, { timeout: 15000 });
    await page.getByText("Approval workflow", { exact: true }).waitFor({ timeout: 30000 });
    assert.equal(await page.getByText("Scene 1 · 15s", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Scene 2", { exact: false }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Generate missing stills" }).isEnabled(), false);

    await page.getByRole("button", { name: "Edit words & shot" }).click();
    const correctedWords = "Use one list, pick one priority, and finish it before adding another.";
    await page.getByLabel("Dialogue").fill(correctedWords);
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText("Saved", { exact: true }).waitFor({ timeout: 30000 });
    const scriptCard = page
      .getByText("Complete script", { exact: true })
      .locator("..")
      .locator("..");
    const correctedSummary = scriptCard.getByRole("paragraph").filter({ hasText: correctedWords });
    assert.equal(await correctedSummary.count(), 1);
    await correctedSummary.waitFor({ timeout: 30000 });
    await page.screenshot({
      path: path.join(screenshotDir, "02-editable-script-before-cost.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: "Approve plan" }).click();
    await page.getByText("script approved", { exact: true }).waitFor({ timeout: 10000 });
    const generateStills = page.getByRole("button", { name: "Generate missing stills" });
    await waitUntilEnabled(generateStills);
    await generateStills.click();
    await page.getByRole("button", { name: "Approve still" }).waitFor({ timeout: 30000 });
    assert.equal(await page.getByRole("button", { name: "Generate approved videos" }).isEnabled(), false);
    await page.screenshot({
      path: path.join(screenshotDir, "03-still-review-video-locked.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: "Approve still" }).click();
    await page.getByText("Still approved ✓", { exact: true }).waitFor({ timeout: 10000 });
    const generateVideos = page.getByRole("button", { name: "Generate approved videos" });
    await waitUntilEnabled(generateVideos);
    await page.screenshot({
      path: path.join(screenshotDir, "04-still-approved-video-unlocked.png"),
      fullPage: true,
    });

    // Mock providers only: this proves the last gate and final status without
    // making a network request or spending provider credits.
    await generateVideos.click();
    await page.getByText("Your video", { exact: true }).waitFor({ timeout: 40000 });
    await page.screenshot({
      path: path.join(screenshotDir, "05-mock-video-complete.png"),
      fullPage: true,
    });
  } finally {
    await browser.close();
  }

  console.log(`approval UI checks passed; screenshots: ${screenshotDir}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
