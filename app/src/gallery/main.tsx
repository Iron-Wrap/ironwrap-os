import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../styles.css";
import "./gallery.css";
import { Gallery } from "./gallery";

// The component gallery: gallery.html, served by `npm run dev` only. It is not an input of the
// production build, so nothing here ships.
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <Gallery />
    </StrictMode>,
  );
