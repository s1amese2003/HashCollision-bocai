#!/usr/bin/env bash
# Pull, build and restart. Run on the server as root from anywhere.
set -euo pipefail
cd /opt/HashCollision-bocai
export PATH=/opt/node22/bin:$PATH
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
systemctl restart predict
sleep 2
curl -fsS http://127.0.0.1:8090/api/health && echo " deployed"
