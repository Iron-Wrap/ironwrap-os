// Every test:pwa* script used to start with `npm run build`, so a CI job that ran
// several of them rebuilt the same bundle each time (~8s x 12 = ~100s/run, IRO-267).
// The e2e matrix now builds once and sets PW_SKIP_BUILD=1 for every suite in that
// job; a bare `npm run test:pwa*` (no matrix, e.g. locally or in `make e2e`) still
// builds by default.
import { execFileSync } from "node:child_process";

if (process.env.PW_SKIP_BUILD !== "1") {
  execFileSync("npm", ["run", "build"], { stdio: "inherit" });
}
