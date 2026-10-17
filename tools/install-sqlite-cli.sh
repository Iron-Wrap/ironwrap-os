#!/usr/bin/env bash
set -euo pipefail

# The complete D1 schema needs the dynamically growing parser stack introduced in
# SQLite 3.46. This is a verification CLI, not a change to the D1/Worker engine.
# Official amalgamation. sqlite.org publishes SHA3-256; the SHA-256 below was computed
# from the archive after that published checksum matched:
# https://www.sqlite.org/download.html
install_dir="${1:?supply an isolated SQLite CLI installation directory}"
for tool in curl sha256sum unzip cc; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool is required to build the SQLite CLI" >&2; exit 1; }
done
mkdir -p "$install_dir"
archive="$install_dir/sqlite-source.zip"
curl --fail --silent --show-error --location --max-time 60 \
  https://www.sqlite.org/2026/sqlite-amalgamation-3540100.zip --output "$archive"
printf '%s  %s\n' \
  0a9c8e34352dad46006aa82836d5383bff9dc6bc9ce5a60553c05aa30e6ad1f9 "$archive" \
  | sha256sum --check --strict
unzip -q -o "$archive" -d "$install_dir"
cc -O2 "$install_dir/sqlite-amalgamation-3540100/shell.c" \
  "$install_dir/sqlite-amalgamation-3540100/sqlite3.c" \
  -ldl -lpthread -lm -o "$install_dir/sqlite3"
"$install_dir/sqlite3" --version
