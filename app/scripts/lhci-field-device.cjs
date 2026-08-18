const DEVICE_SECRET = "a".repeat(43);

/**
 * Lighthouse must model a paired field device, not a fresh anonymous browser. The
 * app's early bootstrap reads this ordinary IndexedDB record before the React bundle
 * starts; no app assets, cookies, or service worker are warmed in this setup page.
 */
async function seedPairedFieldDevice(page, origin) {
  await page.goto(`${origin}/healthz`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async (deviceSecret) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ironwrap-os", 3);
      request.addEventListener(
        "upgradeneeded",
        () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("outbox_actions")) {
            const actions = db.createObjectStore("outbox_actions", { keyPath: "deviceActionId" });
            actions.createIndex("by_state", "state");
            actions.createIndex("by_next_attempt", "nextAttemptAt");
            actions.createIndex("by_updated_at", "updatedAt");
            actions.createIndex("by_principal_state", ["tenantId", "userId", "state"]);
          }
          if (!db.objectStoreNames.contains("outbox_blobs")) {
            const blobs = db.createObjectStore("outbox_blobs", { keyPath: "blobKey" });
            blobs.createIndex("by_action", "deviceActionId");
          }
          if (!db.objectStoreNames.contains("meta"))
            db.createObjectStore("meta", { keyPath: "key" });
          if (!db.objectStoreNames.contains("field_cache")) {
            const fieldCache = db.createObjectStore("field_cache", { keyPath: "key" });
            fieldCache.createIndex("by_updated_at", "updatedAt");
          }
        },
        { once: true },
      );
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });

    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction("meta", "readwrite");
        transaction.objectStore("meta").put({
          key: "field-device-secret-v1",
          value: { value: deviceSecret, createdAt: Date.now() },
          updatedAt: Date.now(),
        });
        transaction.addEventListener("complete", resolve, { once: true });
        transaction.addEventListener("error", () => reject(transaction.error), { once: true });
        transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
      });
    } finally {
      database.close();
    }
  }, DEVICE_SECRET);
}

module.exports = { seedPairedFieldDevice };
