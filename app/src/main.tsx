import "@fontsource-variable/hubot-sans/index.css";
import "./styles.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";

import { primeFieldBootstrap } from "./auth/field-bootstrap";
import { takeMagicLinkTokenFromWindow } from "./auth/magic-link-fragment";
import { takePairingTokenFromWindow } from "./auth/pairing-fragment";
import { router } from "./router";

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

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("IronWrap OS could not find its application root.");

// The field PWA opens directly at /today. Begin the same device-proofed bootstrap
// request before route construction so verification and UI setup overlap.
if (window.location.pathname === "/today") primeFieldBootstrap();

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

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
