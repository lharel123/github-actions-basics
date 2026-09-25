#!/usr/bin/env bash
# Downloads club crests onto this machine (they are club trademarks, so they are not stored in git).
# Source: https://github.com/luukhopman/football-logos  - mapping in public/data/crests.json.
#
# Usage: ./deploy/fetch_crests.sh [target-dir]    (default: public/crests next to this script)
set -uo pipefail

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-$SRC_DIR/public/crests}"
BASE="https://raw.githubusercontent.com/luukhopman/football-logos/master"
mkdir -p "$TARGET"

ok=0; fail=0
while IFS=$'\t' read -r id url_path; do
  [[ -z "$id" ]] && continue
  out="$TARGET/$id.png"
  [[ -s "$out" ]] && { ok=$((ok+1)); continue; }
  if curl -fsSL --retry 2 -m 30 -o "$out.tmp" "$BASE/$url_path"; then
    mv "$out.tmp" "$out"; ok=$((ok+1))
  else
    rm -f "$out.tmp"; fail=$((fail+1))
  fi
done < <(node -e '
  const m = require(process.argv[1]);
  for (const [id, p] of Object.entries(m)) console.log(id + "\t" + p.split("/").map(encodeURIComponent).join("/"));
' "$SRC_DIR/public/data/crests.json")

echo "Crests: $ok downloaded/present, $fail failed -> $TARGET"
