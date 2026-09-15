#!/bin/sh
# xhostd build step: runs as root with NO env (no DATABASE_URL). Dependencies only.
set -eu
npm ci --omit=dev --no-audit --no-fund
