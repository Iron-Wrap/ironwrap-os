(() => {
  const DATABASE_NAME = "ironwrap-os";
  const DEVICE_SECRET_KEY = "field-device-secret-v1";
  const DEVICE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
  const BOOTSTRAP_PATH = "/api/v1/field/bootstrap";
  const TIMEOUT_MS = 12_000;

  if (window.location.pathname !== "/today" || typeof indexedDB.databases !== "function") return;

  const preload = readStoredDeviceProof().then((deviceProof) => {
    if (!deviceProof) throw new Error("field_device_proof_unavailable");
    return fetchBootstrap(deviceProof);
  });

  // The React entry consumes this promise as its normal, schema-validated bootstrap
  // request. Mark a cold/offline rejection handled until that consumer attaches.
  preload.catch(() => undefined);
  window.__ironwrapFieldBootstrapResponse = preload;

  async function readStoredDeviceProof() {
    const databases = await indexedDB.databases();
    if (!databases.some((database) => database.name === DATABASE_NAME)) return undefined;

    const database = await openExistingDatabase();
    try {
      if (!database.objectStoreNames.contains("meta")) return undefined;
      const transaction = database.transaction("meta", "readonly");
      const record = await requestResult(transaction.objectStore("meta").get(DEVICE_SECRET_KEY));
      const value = typeof record?.value === "string" ? record.value : record?.value?.value;
      return typeof value === "string" && DEVICE_SECRET_PATTERN.test(value) ? value : undefined;
    } finally {
      database.close();
    }
  }

  function openExistingDatabase() {
    return requestResult(indexedDB.open(DATABASE_NAME));
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
  }

  async function fetchBootstrap(deviceProof) {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort("field_bootstrap_timeout"),
      TIMEOUT_MS,
    );
    try {
      return await fetch(BOOTSTRAP_PATH, {
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "X-IronWrap-Device-Proof": deviceProof,
        },
        signal: controller.signal,
      });
    } finally {
      window.clearTimeout(timeout);
    }
  }
})();
