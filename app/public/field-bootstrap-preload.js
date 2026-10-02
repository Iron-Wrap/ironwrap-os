(() => {
  const DATABASE_NAME = "ironwrap-os";
  const DEVICE_SECRET_KEY = "field-device-secret-v1";
  const DEVICE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
  const BOOTSTRAP_PATH = "/api/v1/field/bootstrap";
  const TIMEOUT_MS = 12_000;

  // Replaced at build time with the hashed route chunks; left as the literal
  // placeholders in dev, where Vite serves modules unbundled.
  const TODAY_ROUTE_CHUNK = "__IRONWRAP_TODAY_ROUTE_CHUNK__";
  const FIELD_ROUTE_CHUNK = "__IRONWRAP_FIELD_ROUTE_CHUNK__";

  const pathname = window.location.pathname;

  // A route chunk is otherwise discovered only after the entry bundle has downloaded,
  // parsed and executed, which serialises a second round trip directly in front of the
  // largest paint. This script already runs ahead of the entry, so it can start that
  // fetch in parallel — and only the chunk the current path actually renders.
  const routeChunk = isTodayPath(pathname)
    ? TODAY_ROUTE_CHUNK
    : isFieldRoutePath(pathname)
      ? FIELD_ROUTE_CHUNK
      : undefined;
  if (routeChunk && routeChunk.slice(0, 2) !== "__") {
    const link = document.createElement("link");
    link.rel = "modulepreload";
    link.crossOrigin = "";
    link.href = routeChunk;
    document.head.appendChild(link);
  }

  if (!["/today", "/now"].includes(pathname) || typeof indexedDB.databases !== "function") return;
  // An async head script may arrive after the entry has started its ordinary read.
  // Do not leave a late response for a later refetch to mistake for the initial one.
  if (window.__ironwrapFieldBootstrapPreloadConsumed) return;

  const preload = readStoredDeviceProof().then((deviceProof) => {
    if (!deviceProof) throw new Error("field_device_proof_unavailable");
    return fetchBootstrap(deviceProof);
  });

  // The React entry consumes this promise as its normal, schema-validated bootstrap
  // request. Mark a cold/offline rejection handled until that consumer attaches.
  preload.catch(() => undefined);
  window.__ironwrapFieldBootstrapResponse = preload;

  function isTodayPath(path) {
    return path === "/" || path === "/today";
  }

  function isFieldRoutePath(path) {
    return (
      isTodayPath(path) ||
      path.indexOf("/jobs/") === 0 ||
      path.indexOf("/work-objects/") === 0 ||
      path.indexOf("/check-in") === 0
    );
  }

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
