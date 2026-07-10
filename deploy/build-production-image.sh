#!/usr/bin/env bash
# Reproducible Frappe-only image build. All configuration is read from the
# runtime lock or environment; secret contents are accepted only via files.
set -euo pipefail
set +x

if (( $# != 0 )); then
  echo "error: this command accepts no arguments; use environment variables and secret files" >&2
  exit 64
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$ROOT/deploy/runtime-lock.json"
: "${FRAPPE_DOCKER_DIR:?FRAPPE_DOCKER_DIR must name the pinned frappe_docker checkout}"
: "${APPS_JSON_FILE:?APPS_JSON_FILE must name a credential-free apps JSON secret file}"
: "${IRONWRAP_APP_COMMIT:?IRONWRAP_APP_COMMIT must be the deployed app git commit}"
: "${IRONWRAP_IMAGE_REF:?IRONWRAP_IMAGE_REF must be an explicit release image tag}"

for command_name in docker git node; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "error: required command is unavailable: $command_name" >&2
    exit 1
  fi
done

if [[ ! "$IRONWRAP_APP_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "error: IRONWRAP_APP_COMMIT must be a lowercase 40-character git commit" >&2
  exit 1
fi
image_tag="${IRONWRAP_IMAGE_REF##*:}"
if [[ ! "$IRONWRAP_IMAGE_REF" =~ ^[a-z0-9][a-z0-9.-]*(:[0-9]+)?/[a-z0-9._/-]+:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || \
   [[ "$IRONWRAP_IMAGE_REF" == *@* || "$IRONWRAP_IMAGE_REF" == *//* || "$IRONWRAP_IMAGE_REF" == *"/:"* || "$IRONWRAP_IMAGE_REF" == *..* || \
      "$image_tag" =~ ^(latest|main|master|develop|stable|prod|production)$ ]]; then
  echo "error: IRONWRAP_IMAGE_REF must be a registry-qualified, explicit release tag" >&2
  exit 1
fi
if [[ ! -f "$APPS_JSON_FILE" || -L "$APPS_JSON_FILE" || ! -r "$APPS_JSON_FILE" || ! -d "$FRAPPE_DOCKER_DIR/.git" ]]; then
  echo "error: a required source or secret file is unavailable" >&2
  exit 1
fi
if [[ -n "${GIT_CREDENTIALS_FILE:-}" && ( ! -f "$GIT_CREDENTIALS_FILE" || -L "$GIT_CREDENTIALS_FILE" || ! -r "$GIT_CREDENTIALS_FILE" ) ]]; then
  echo "error: GIT_CREDENTIALS_FILE is not readable" >&2
  exit 1
fi

if ! LOCK_OUTPUT="$(node - "$LOCK" <<'NODE'
const fs = require("node:fs");
function fail() { process.exit(1); }
let lock;
try { lock = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); } catch { fail(); }
if (lock.schema_version !== 1 || lock.policy?.architecture !== "frappe-only" || lock.policy?.erpnext !== "forbidden" || lock.policy?.floating_references !== "forbidden") fail();
if (JSON.stringify(Object.keys(lock.components ?? {}).sort()) !== JSON.stringify(["frappe", "frappe_docker", "hermes"])) fail();
if (JSON.stringify(Object.keys(lock.container_bases ?? {}).sort()) !== JSON.stringify(["frappe_base", "frappe_build"])) fail();
const expectedSources = {
  frappe: "https://github.com/frappe/frappe.git",
  frappe_docker: "https://github.com/frappe/frappe_docker.git",
  hermes: "https://github.com/NousResearch/hermes-agent.git",
};
for (const [name, source] of Object.entries(expectedSources)) {
  const component = lock.components[name];
  if (component?.source !== source || !/^v\d+(?:\.\d+){2,3}$/.test(component?.version ?? "") || !/^[0-9a-f]{40}$/.test(component?.git_commit ?? "")) fail();
}
if (!/^v15\./.test(lock.components.frappe.version)) fail();
if (!/^docker\.io\/frappe\/build:version-15@sha256:[0-9a-f]{64}$/.test(lock.container_bases.frappe_build)) fail();
if (!/^docker\.io\/frappe\/base:version-15@sha256:[0-9a-f]{64}$/.test(lock.container_bases.frappe_base)) fail();
for (const value of [
  lock.components.frappe.version,
  lock.components.frappe.git_commit,
  lock.components.frappe_docker.git_commit,
  lock.container_bases.frappe_build,
  lock.container_bases.frappe_base,
]) console.log(value);
NODE
  )"; then
  echo "error: deploy/runtime-lock.json is invalid or not Frappe-only" >&2
  exit 1
fi
readarray -t LOCK_VALUES <<< "$LOCK_OUTPUT"
if (( ${#LOCK_VALUES[@]} != 5 )); then
  echo "error: deploy/runtime-lock.json did not yield the complete build lock" >&2
  exit 1
fi
FRAPPE_REF="${LOCK_VALUES[0]}"
FRAPPE_COMMIT="${LOCK_VALUES[1]}"
FRAPPE_DOCKER_COMMIT="${LOCK_VALUES[2]}"
FRAPPE_BUILD_IMAGE="${LOCK_VALUES[3]}"
FRAPPE_BASE_IMAGE="${LOCK_VALUES[4]}"

CONTAINERFILE="$ROOT/deploy/Containerfile.frappe"
if [[ ! -r "$CONTAINERFILE" ]]; then
  echo "error: deploy/Containerfile.frappe is unavailable" >&2
  exit 1
fi
containerfile_text="$(<"$CONTAINERFILE")"
if [[ "$containerfile_text" != *"FROM $FRAPPE_BUILD_IMAGE AS builder"* || \
      "$containerfile_text" != *"FROM $FRAPPE_BASE_IMAGE AS backend"* || \
      "$containerfile_text" != *"--frappe-branch=$FRAPPE_REF"* || \
      "$containerfile_text" != *"= \"$FRAPPE_COMMIT\""* || \
      "$containerfile_text" == *"ARG FRAPPE_"* ]]; then
  echo "error: Containerfile does not consume the exact non-overridable runtime lock" >&2
  exit 1
fi

if [[ "$(git -C "$FRAPPE_DOCKER_DIR" rev-parse --show-toplevel)" != "$(cd "$FRAPPE_DOCKER_DIR" && pwd -P)" ]] || \
   [[ "$(git -C "$FRAPPE_DOCKER_DIR" rev-parse HEAD)" != "$FRAPPE_DOCKER_COMMIT" ]]; then
  echo "error: frappe_docker checkout does not match deploy/runtime-lock.json" >&2
  exit 1
fi
if [[ -n "$(git -C "$FRAPPE_DOCKER_DIR" status --porcelain=v1 --untracked-files=all --ignore-submodules=none)" ]]; then
  echo "error: frappe_docker checkout has tracked or untracked modifications" >&2
  exit 1
fi

if ! node - "$APPS_JSON_FILE" <<'NODE'
const fs = require("node:fs");
let apps;
try { apps = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); } catch { process.exit(1); }
if (!Array.isArray(apps) || apps.length !== 1) process.exit(1);
const app = apps[0] || {};
if (JSON.stringify(Object.keys(app).sort()) !== JSON.stringify(["branch", "url"])) process.exit(1);
let url;
try { url = new URL(app.url); } catch { process.exit(1); }
if (url.protocol !== "https:" || url.username || url.password) process.exit(1);
if (url.href !== "https://github.com/ironwrap/ironwrap_roofing.git") process.exit(1);
if (typeof app.branch !== "string" || !/^v?\d+(?:\.\d+){2,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(app.branch)) process.exit(1);
if (/erpnext/i.test(JSON.stringify(apps))) process.exit(1);
NODE
then
  echo "error: APPS_JSON_FILE is invalid, floating, credential-bearing, or not Frappe-only" >&2
  exit 1
fi

build_args=(
  build
  --pull
  --file "$CONTAINERFILE"
  --secret "id=apps_json,src=$APPS_JSON_FILE"
  --build-arg "IRONWRAP_APP_COMMIT=$IRONWRAP_APP_COMMIT"
  --label "org.opencontainers.image.revision=$IRONWRAP_APP_COMMIT"
  --tag "$IRONWRAP_IMAGE_REF"
)
if [[ -n "${GIT_CREDENTIALS_FILE:-}" ]]; then
  build_args+=(--secret "id=git_credentials,src=$GIT_CREDENTIALS_FILE")
fi
build_args+=("$FRAPPE_DOCKER_DIR")

DOCKER_BUILDKIT=1 docker "${build_args[@]}"
echo "ok: built the locked Frappe-only production image"
