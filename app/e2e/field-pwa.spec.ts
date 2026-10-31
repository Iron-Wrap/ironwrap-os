import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expectTouchTarget } from "./touch-target";
import { settleAnimations } from "./settle";

test.describe("Field Companion PWA acceptance", () => {
  test("keeps a job card's facts apart in the crew shell on a desktop and on a phone", async ({
    page,
  }) => {
    await seedPairedFieldDevice(page);
    // The crew shell centres a phone-wide column on a desktop; the card follows that column, so
    // window breakpoints never squeeze three columns and two facts into it (Track C, #55 capture).
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/today");
      const card = page.locator("li article").first();
      const facts = card.locator("dl");
      await expect(facts).toBeVisible();
      // Squeezed, the labels and values spill past their cells ("Your role" ran into "Next step").
      const cells = await facts.locator("dt, dd").all();
      expect(cells.length).toBe(4);
      for (const cell of [card, ...cells])
        expect(
          await cell.evaluate((element) => element.scrollWidth <= element.clientWidth),
          `${await cell.textContent()} spills at ${viewport.width}px`,
        ).toBe(true);
    }
  });

  test("keeps the full crew name, the sun and night switch, and thumb actions usable on narrow phones", async ({
    page,
  }) => {
    const workerUser = "field.acceptance.with.a.long.unbroken.identifier@example.invalid";
    await page.route("**/api/v1/field/bootstrap", async (route) => {
      const response = await route.fetch();
      const model = await response.json();
      if (model.session?.user) model.session.user.display_name = "Sam Kennedy Long Example Name";
      await route.fulfill({ response, json: model });
    });
    await page.route("**/api/v1/jobs/JOB-ACCEPTANCE", async (route) => {
      const response = await route.fetch();
      const model = await response.json();
      model.packet.work_package.acknowledgement.workers[0].worker_user = workerUser;
      await route.fulfill({ response, json: model });
    });
    await seedPairedFieldDevice(page);
    await page.reload();
    // Sun is the default, whatever the phone's own light or dark setting is.
    await expect(page.locator(".crew")).toHaveAttribute("data-mode", "field-sun");
    // The control names the look it switches to.
    await expect(page.getByRole("button", { name: "Use night mode" })).toBeVisible();
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const name = page.locator(".crew-person strong");
      await expect(name).toHaveText("Sam Kennedy Long Example Name");
      await expect(name).toHaveCSS("white-space", "normal");
      expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await expect(page.locator(".crew")).toHaveAttribute("data-mode", "field-sun");
      await expect(page.locator(".crew")).toHaveAttribute("data-density", "touch");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      for (const control of await page.locator(".crew-top > :is(button,a)").all()) {
        const box = (await control.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(48);
        expect(box.width).toBeGreaterThanOrEqual(48);
      }
    }
    await page.reload();
    await expect(page.locator(".crew")).toHaveAttribute("data-mode", "field-sun");
    // Night is the crew's own choice, kept across a reload, and one tap back to sun.
    await page.getByRole("button", { name: "Use night mode" }).click();
    await expect(page.locator(".crew")).toHaveAttribute("data-mode", "field-night");
    await page.reload();
    await expect(page.locator(".crew")).toHaveAttribute("data-mode", "field-night");
    await page.getByRole("button", { name: "Use sun mode" }).click();
    await expect(page.locator(".crew")).toHaveAttribute("data-mode", "field-sun");
    await page.goto("/jobs/JOB-ACCEPTANCE");
    const worker = page.getByText(`${workerUser} · field · required`, { exact: true });
    await expect(worker).toBeVisible();
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await worker.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    }
    const camera = page.getByLabel("Take photo for this job").locator("..");
    await camera.scrollIntoViewIfNeeded();
    const cameraBox = (await camera.boundingBox())!;
    const tabsBox = (await page.locator(".crew-tabs").boundingBox())!;
    expect(cameraBox.height).toBeGreaterThanOrEqual(48);
    expect(cameraBox.width).toBeGreaterThanOrEqual(48);
    expect(cameraBox.y + cameraBox.height).toBeLessThan(tabsBox.y);
    expect(
      await camera.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
        );
      }),
    ).toBe(true);
    await page.goto("/check-in/JOB-ACCEPTANCE");
    await expect(page.getByRole("heading", { name: "Capture what you see" })).toBeFocused();
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const capture = page.getByText("Take photos", { exact: true }).locator("..");
      const captureBox = (await capture.boundingBox())!;
      const actionBox = (await page.locator(".field-action-bar").boundingBox())!;
      const headerBox = (await page.locator(".crew-top").boundingBox())!;
      expect(captureBox.height).toBeGreaterThanOrEqual(64);
      expect(captureBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height);
      expect(captureBox.y + captureBox.height).toBeLessThanOrEqual(actionBox.y);
      expect(actionBox.y + actionBox.height).toBeLessThan(tabsBox.y);
    }
  });

  for (const width of [320, 390]) {
    test(`recovers unsaved updates through a real save and offline reload at ${width}px`, async ({
      context,
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await seedPairedFieldDevice(page);
      await page.evaluate(() => sessionStorage.setItem("acceptance-cache-failure", "on"));
      await page.addInitScript(() => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (this: IDBObjectStore, value, key) {
          if (
            this.name === "field_cache" &&
            sessionStorage.getItem("acceptance-cache-failure") === "on"
          ) {
            throw new DOMException("Synthetic cache quota failure", "QuotaExceededError");
          }
          return key === undefined ? put.call(this, value) : put.call(this, value, key);
        };
      });
      const readiness = page.getByRole("status", { name: "Offline readiness" });
      const saveAgain = page.getByRole("button", { name: "Try saving again" });
      const capture = async (name: string) => {
        await testInfo.attach(`${name}-${width}px.png`, {
          body: await page.screenshot({ path: testInfo.outputPath(`${name}-${width}px.png`) }),
          contentType: "image/png",
        });
      };
      const cachedReads = () =>
        page.evaluate(async () => {
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("ironwrap-os");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          try {
            return await new Promise<
              Array<{ key: string; updatedAt: number; value: { stale_fields: string[] } }>
            >((resolve, reject) => {
              const request = database
                .transaction("field_cache")
                .objectStore("field_cache")
                .getAll();
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
          } finally {
            database.close();
          }
        });
      await page.reload();
      await expect(readiness.getByRole("heading", { name: "Not ready offline" })).toBeVisible();
      await expect(readiness).toContainText("This run sheet is not saved on this phone.");
      await expect(page.getByText("All sent", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Up to date", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Some details may be old", { exact: true })).toHaveCount(0);
      expect(await cachedReads()).toHaveLength(0);
      await saveAgain.click({ trial: true });
      await capture("today-not-saved");

      await page.evaluate(() => sessionStorage.removeItem("acceptance-cache-failure"));
      const todayRead = page.waitForResponse("**/api/v1/today");
      await saveAgain.click();
      expect((await todayRead).status()).toBe(200);
      await expect(
        readiness.getByRole("heading", { name: "Ready offline", exact: true }),
      ).toBeVisible();
      await expect(saveAgain).toHaveCount(0);
      const saved = await cachedReads();
      expect(saved.find((entry) => entry.key.endsWith(":today"))).toBeTruthy();
      const jobBefore = saved.find((entry) => entry.key.endsWith(":job:JOB-ACCEPTANCE"));
      expect(jobBefore).toBeTruthy();
      await capture("today-ready");

      await page.evaluate(() => sessionStorage.setItem("acceptance-cache-failure", "on"));
      await page.goto("/jobs/JOB-ACCEPTANCE");
      await expect(readiness.getByRole("heading", { name: "Not ready offline" })).toBeVisible();
      await expect(readiness).toContainText("This job plan is not saved on this phone.");
      await expect(page.getByText("Up to date", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Some job details may be old", { exact: true })).toHaveCount(0);
      await expect(page.locator(".field-capture-dock")).toHaveCount(0);
      await saveAgain.click({ trial: true });
      await capture("job-not-saved");
      const jobLayout = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        overflowing: [...document.querySelectorAll("body *")]
          .filter((element) => element.getBoundingClientRect().right > innerWidth)
          .slice(0, 12)
          .map((element) => ({
            tag: element.tagName,
            classes: element.getAttribute("class"),
            text: element.textContent?.slice(0, 100),
            width: element.getBoundingClientRect().width,
          })),
      }));
      expect(jobLayout.width, JSON.stringify(jobLayout)).toBeLessThanOrEqual(width);

      await page.evaluate(() => sessionStorage.removeItem("acceptance-cache-failure"));
      const jobRead = page.waitForResponse("**/api/v1/jobs/JOB-ACCEPTANCE");
      await saveAgain.click();
      expect((await jobRead).status()).toBe(200);
      await expect(
        readiness.getByRole("heading", { name: "Ready offline", exact: true }),
      ).toBeVisible();
      const keptJob = (await cachedReads()).find((entry) =>
        entry.key.endsWith(":job:JOB-ACCEPTANCE"),
      );
      expect(keptJob?.updatedAt).toBeGreaterThan(jobBefore!.updatedAt);
      expect(keptJob?.value.stale_fields).not.toContain("offline.not_saved");
      await capture("job-ready");

      await page.evaluate(async () => await navigator.serviceWorker.ready);
      await context.setOffline(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(
        readiness.getByRole("heading", { name: "Ready offline", exact: true }),
      ).toBeVisible();
      await expect(page.getByText("Saved copy", { exact: true })).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "123 Acceptance Avenue, Calgary, AB" }),
      ).toBeVisible();
      await capture("job-offline-reload");
      await page.goto("/today", { waitUntil: "domcontentloaded" });
      await expect(
        readiness.getByRole("heading", { name: "Ready offline", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("heading", { name: "Today's work" })).toBeVisible();
      await expect(page.getByText("Saved copy", { exact: true })).toBeVisible();
      await capture("today-offline-reload");
      await context.setOffline(false);
    });
  }

  for (const width of [320, 412, 576]) {
    test(`keeps the run sheet in place when installation becomes available at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 915 });
      await seedPairedFieldDevice(page);
      await page.addInitScript(() => {
        window.addEventListener(
          "beforeinstallprompt",
          (event) => {
            if (event.isTrusted) event.stopImmediatePropagation();
          },
          true,
        );
        Object.defineProperty(navigator.storage, "persisted", { value: async () => true });
      });
      await page.reload();
      await expect(page.getByRole("heading", { name: "Today's work" })).toBeVisible();
      await expect(page.getByRole("status", { name: "Sync: Nothing to send" })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
      const before = await page.locator("#main-content").boundingBox();

      await page.evaluate(() => {
        const event = new Event("beforeinstallprompt", { cancelable: true });
        Object.assign(event, {
          prompt: async () => {},
          userChoice: Promise.resolve({ outcome: "accepted", platform: "web" }),
        });
        window.dispatchEvent(event);
      });

      await expect(page.getByRole("button", { name: "Install", exact: true })).toBeVisible();
      const after = await page.locator("#main-content").boundingBox();
      expect(after!.y).toBe(before!.y);
      const install = page.getByRole("button", { name: "Install", exact: true });
      const help = page.getByRole("button", { name: "Help", exact: true });
      await expectTouchTarget(install, { name: "Install" });
      await expectTouchTarget(help, { name: "Help" });
      const horizontalLayout = await page.evaluate(() => ({
        contentWidth: document.documentElement.scrollWidth,
        availableWidth: Math.min(
          document.documentElement.clientWidth,
          document.documentElement.getBoundingClientRect().width,
        ),
      }));
      // Stable gutters reduce visible width even when headless Chromium hides scrollbars.
      expect(horizontalLayout.contentWidth).toBeLessThanOrEqual(horizontalLayout.availableWidth);
      await install.focus();
      await expect(install).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(install).toHaveCount(0);
      expect((await page.locator("#main-content").boundingBox())!.y).toBe(before!.y);
      await help.click();
      await expect(page.getByRole("button", { name: "Call for rescue" })).toBeVisible();
    });
  }

  test("renders a mobile-safe blocked-work run sheet with no WCAG A/AA violations", async ({
    page,
  }) => {
    await seedPairedFieldDevice(page);
    await page.route("**/api/v1/operating-intake", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          version: 1,
          operating_authority: "d1",
          tenant_id: "ironwrap",
          generated_at: "2026-08-21T16:00:00.000Z",
          leads: [],
        }),
      }),
    );
    const appRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/v1/")) appRequests.push(url.pathname);
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
    await expect(page.locator("#app-boot-shell")).toHaveCount(0);

    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();

    await expect(page.getByRole("heading", { name: "Today's work" })).toBeVisible();
    await expect(page.getByText("1 check blocks work")).toBeVisible();
    await expect(page.getByText("Delivery confirmation is missing")).toBeVisible();
    await expect(page.getByRole("link", { name: "Check what blocks work" })).toHaveAttribute(
      "href",
      "/jobs/JOB-ACCEPTANCE",
    );
    await expect(page.getByRole("link", { name: "Start work" })).toHaveCount(0);
    expect(appRequests).toContain("/api/v1/field/bootstrap");
    expect(appRequests).not.toContain("/api/v1/session");
    expect(appRequests).not.toContain("/api/v1/today");

    const reviewAction = page.getByRole("link", { name: "Check what blocks work" });
    await expectTouchTarget(reviewAction, { name: "Check what blocks work" });

    // Open the safety rail before auditing. Its controls are the highest-contrast
    // risk on the shell, and a closed <details> would hide them from axe entirely.
    await page.getByRole("button", { name: "Help", exact: true }).click();
    await expect(page.getByRole("button", { name: "Call for rescue" })).toBeVisible();

    await settleAnimations(page);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations).toEqual([]);
  });

  test("registers an installable shell and reloads the cached dispatch offline", async ({
    context,
    page,
  }) => {
    await seedPairedFieldDevice(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();

    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(manifestHref).toBeTruthy();
    const manifest = await page.evaluate(async (href) => {
      return await (await fetch(href)).json();
    }, manifestHref!);
    expect(manifest).toMatchObject({
      id: "/",
      name: "IronWrap OS",
      short_name: "IronWrap",
      start_url: "/today",
      display: "standalone",
    });

    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then(Boolean)))
      .toBe(true);
    await page.evaluate(async () => await navigator.serviceWorker.ready);

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
    await expect(page.getByText(/This is a saved copy for/i)).toBeVisible();
    await expect(page.getByText(/Your saved work is safe/i)).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);
  });

  test("keeps a cached Work Package readable offline without a client-side start or hold release", async ({
    context,
    page,
  }) => {
    await seedPairedFieldDevice(page);
    await page.goto("/jobs/JOB-ACCEPTANCE");
    await expect(page.getByRole("heading", { name: "North slope replacement" })).toBeVisible();
    await expect(page.getByText("v3 · Released")).toBeVisible();
    await expect(page.getByText(/Waiting for Production manager/i)).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then(Boolean)))
      .toBe(true);
    await page.evaluate(async () => await navigator.serviceWorker.ready);

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect(page.getByText(/This is a saved copy from/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "I reviewed this plan" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop Work and save report" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start work" })).toHaveCount(0);
    await expect(page.getByText(/this app cannot clear the stop/i)).toBeVisible();
  });

  test("uses one proof-bound bootstrap read for an already paired field device", async ({
    page,
  }) => {
    const deviceProof = "a".repeat(43);
    await seedPairedFieldDevice(page, deviceProof);

    const bootstrapRequests: Array<{ deviceProof?: string }> = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname !== "/api/v1/field/bootstrap") return;
      bootstrapRequests.push({ deviceProof: request.headers()["x-ironwrap-device-proof"] });
    });

    await page.reload();
    await expect(page.getByRole("heading", { name: "Today's work" })).toBeVisible();
    expect(bootstrapRequests).toEqual([{ deviceProof }]);
  });

  test("opens a paired reload straight on the run sheet, with no sign-in check first", async ({
    page,
  }) => {
    await seedPairedFieldDevice(page);
    const shownText = await watchShownText(page, ["Checking your sign-in", "Today's work"]);
    // The intake panel is office work; a crew phone's run sheet must not wait on its code.
    // (The service worker's precache downloads every chunk later; those requests are its own.)
    const intakeChunkRequests: string[] = [];
    page.on("request", (request) => {
      if (/\/assets\/operating-intake-panel-[^/]+\.js$/.test(new URL(request.url()).pathname))
        intakeChunkRequests.push(request.url());
    });

    await page.reload();
    await expect(page.getByRole("heading", { name: "Today's work" })).toBeVisible();

    expect(await shownText()).toEqual(["Today's work"]);
    expect(intakeChunkRequests).toEqual([]);
  });

  test("shows the not-ready screen after one failed bootstrap read and recovers on retry", async ({
    page,
  }) => {
    await seedPairedFieldDevice(page);
    const shownText = await watchShownText(page, ["IronWrap OS is not ready", "Today's work"]);
    let bootstrapReads = 0;
    await page.route("**/api/v1/field/bootstrap", async (route) => {
      bootstrapReads += 1;
      if (bootstrapReads === 1) {
        await route.fulfill({ status: 500, json: { error: "internal_error" } });
      } else {
        await route.continue();
      }
    });

    await page.reload();
    await expect(page.getByRole("heading", { name: "IronWrap OS is not ready" })).toBeVisible();
    expect(await shownText()).toEqual(["IronWrap OS is not ready"]);
    expect(bootstrapReads).toBe(1);

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("heading", { name: "Today's work" })).toBeVisible();
    expect(await shownText()).toEqual(["IronWrap OS is not ready", "Today's work"]);
    expect(bootstrapReads).toBe(2);
  });

  test("never receives run-sheet data before a paired device supplies its proof", async ({
    page,
  }) => {
    const bootstrapRequests: Array<{ deviceProof?: string }> = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname !== "/api/v1/field/bootstrap") return;
      bootstrapRequests.push({ deviceProof: request.headers()["x-ironwrap-device-proof"] });
    });

    await page.goto("/today");

    await expect(page.getByRole("heading", { name: "Pair this crew phone" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Today's work" })).toHaveCount(0);
    expect(bootstrapRequests).toEqual([{ deviceProof: undefined }]);
  });

  test("keeps the job page's facts and safety cards whole in the crew shell on a desktop", async ({
    page,
  }) => {
    await seedPairedFieldDevice(page);
    // The crew shell is a phone-wide column on a desktop too; the job header, the work plan and
    // the safety cards follow their own width, never the window's.
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/jobs/JOB-ACCEPTANCE");
      await expect(page.getByRole("heading", { name: "Safety and site" })).toBeVisible();
      // The emergency line dials 911 and the office's own number from the company profile.
      await expect(page.getByRole("link", { name: "Call 911" })).toHaveAttribute("href", "tel:911");
      await expect(page.getByRole("link", { name: "Call the office" })).toHaveAttribute(
        "href",
        "tel:7805550142",
      );
      const cells = await page
        .locator(
          "header dl > div > :is(dt, dd), section[aria-labelledby='safety-access-heading'] article",
        )
        .all();
      expect(cells.length).toBe(18);
      for (const cell of cells)
        expect(
          await cell.evaluate((element) => element.scrollWidth <= element.clientWidth),
          `${(await cell.textContent())?.slice(0, 40)} spills at ${viewport.width}px`,
        ).toBe(true);
      // Squeezed three across, the facts only wrapped, so the column counts are what fail.
      const grids = {
        "job facts": page.locator("header dl").first(),
        "work plan dates": page
          .locator("section[aria-labelledby='work-package-heading'] header dl")
          .first(),
        "safety cards": page
          .locator("section[aria-labelledby='safety-access-heading'] > div.grid")
          .first(),
      };
      for (const [name, grid] of Object.entries(grids)) {
        const columns = await grid.evaluate(
          (element) => getComputedStyle(element).gridTemplateColumns.split(" ").length,
        );
        expect(columns, `${name} side by side at ${viewport.width}px`).toBe(1);
      }
    }
  });
});

/**
 * Records, in order of first appearance, which of `phrases` any node the next navigation inserts
 * (or any text it changes) ever carried, watching from before the document's first byte. A state
 * that renders once and is replaced never reaches a final assertion, so the tests read the record.
 */
async function watchShownText(page: import("@playwright/test").Page, phrases: string[]) {
  await page.addInitScript((watched) => {
    const shown: string[] = [];
    Object.assign(window, { __ironwrapShownText: shown });
    const look = (node: Node) => {
      const text = node.textContent ?? "";
      for (const phrase of watched) {
        if (!shown.includes(phrase) && text.includes(phrase)) shown.push(phrase);
      }
    };
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") look(record.target);
        record.addedNodes.forEach(look);
      }
    }).observe(document, { childList: true, characterData: true, subtree: true });
  }, phrases);
  return () =>
    page.evaluate(
      () => (window as unknown as { __ironwrapShownText: string[] }).__ironwrapShownText,
    );
}

async function seedPairedFieldDevice(
  page: import("@playwright/test").Page,
  proof = "a".repeat(43),
) {
  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "Pair this crew phone" })).toBeVisible();
  await page.evaluate(async (deviceProof) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ironwrap-os");
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("meta", "readwrite");
        transaction.objectStore("meta").put({
          key: "field-device-secret-v1",
          value: { value: deviceProof, createdAt: Date.now() },
          updatedAt: Date.now(),
        });
        transaction.addEventListener("complete", () => resolve(), { once: true });
        transaction.addEventListener("error", () => reject(transaction.error), { once: true });
        transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
      });
    } finally {
      database.close();
    }
  }, proof);
}
