import "./styles.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode, startTransition, useEffect } from "react";
import { createRoot } from "react-dom/client";

import { primeFieldBootstrap, settlePrimedFieldBootstrap } from "./auth/field-bootstrap";
import { takeMagicLinkTokenFromWindow } from "./auth/magic-link-fragment";
import { takePairingTokenFromWindow } from "./auth/pairing-fragment";
import { sessionQueryKey } from "./auth/session-query";
import { applyThemePreference, readThemePreference } from "./lib/theme";
import { router } from "./router";
import { primeStorageDurability } from "./storage/durability";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});

// A pinned appearance applies before the first paint, so a dark-mode viewer never sees a light
// flash while the bundle mounts.
applyThemePreference(readThemePreference());

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("IronWrap OS could not find its application root.");

// The field PWA opens directly at /today. Begin the same device-proofed bootstrap
// request before route construction so verification and UI setup overlap.
if (window.location.pathname === "/today") {
  primeFieldBootstrap();
  void primeStorageDurability();
}

// Scrub fragment credentials before React renders or any lazy route module loads. The helpers
// retain the token only in module memory for the route that will consume it.
if (["/auth/verify", "/portal", "/contract-accept"].includes(window.location.pathname)) {
  void takeMagicLinkTokenFromWindow();
}
if (window.location.pathname === "/auth/pair") void takePairingTokenFromWindow();

function App() {
  useEffect(() => {
    document.getElementById("app-boot-shell")?.remove();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

const root = createRoot(rootElement);
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

if (window.location.pathname === "/today") {
  // A paired phone's bootstrap usually lands while the bundle is still downloading. Rendering
  // before reading it put two renders of the checking state on the phone's main thread ahead of
  // the run sheet; rendering once it is read puts the verified screen first, and the boot shell
  // covers the wait either way. A failed read is left for the session query and its retry
  // policy. The verified screen is the whole shell, so it mounts as a transition and React
  // yields between components instead of holding the main thread for the entire mount.
  //
  // The router resolves `/today` before that mount for the same reason: left to the router's
  // mount effect, its first load lands inside the commit and re-renders the whole shell
  // synchronously. A load that fails here is simply repeated by that effect.
  void Promise.all([settlePrimedFieldBootstrap(), router.load().catch(() => undefined)]).then(
    ([bootstrap]) => {
      if (bootstrap) queryClient.setQueryData(sessionQueryKey, bootstrap);
      startTransition(() => root.render(app));
    },
  );
} else {
  root.render(app);
}
