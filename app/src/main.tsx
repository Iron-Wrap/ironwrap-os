import "@fontsource-variable/inter/index.css";
import "./styles.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";

import { primeFieldBootstrap } from "./auth/field-bootstrap";
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
