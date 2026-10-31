// The app parses through zod's interpreted path (src/lib/zod-jitless.ts); so do its tests.
import "../lib/zod-jitless";
import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";

import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  cleanup();
});
