#!/usr/bin/env bash
# Build production frontend and restart PM2 apps (ecosystem.config.js).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

mkdir -p logs

echo "==> Frontend build (CI=false avoids warnings-as-errors)"
(cd frontend && CI=false npm run build)

echo "==> PM2 restart"
pm2 restart ecosystem.config.js --update-env

echo "==> Done"
pm2 list
