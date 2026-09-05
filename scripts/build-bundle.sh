#!/usr/bin/env bash
# Build a Claude Desktop extension bundle (.mcpb) that non-developers can install
# by opening the file in Claude Desktop (Settings → Extensions). Claude Desktop
# ships its own Node runtime, so recipients only need Google Chrome.
#
#   npm run bundle            → build/leclerc-drive-<version>.mcpb
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
OUT_DIR="build"
STAGE="$OUT_DIR/stage"
OUT="$OUT_DIR/leclerc-drive-$VERSION.mcpb"

npm run build
mkdir -p "$OUT_DIR"
[ -d "$STAGE" ] && trash "$STAGE" 2>/dev/null || true
mkdir -p "$STAGE"
cp -R dist package.json package-lock.json manifest.json README.md LICENSE "$STAGE/"
# Production dependencies only (the bundle must be self-contained).
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent)
node -e "const m=require('./manifest.json'); if (m.version !== '$VERSION') { console.error('manifest.json version ≠ package.json'); process.exit(1); }"
npx -y @anthropic-ai/mcpb@2.1.2 validate "$STAGE/manifest.json"
npx -y @anthropic-ai/mcpb@2.1.2 pack "$STAGE" "$OUT"
npx -y @anthropic-ai/mcpb@2.1.2 info "$OUT"
echo
echo "→ $OUT"
