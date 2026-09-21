#!/bin/sh
# Start the acceptance topology against an ISOLATED database. Usage: start-all.sh [web|worker|llm|hosts|all]
# Requires: ACC_DB (postgres URL of a throwaway database with migrations applied) and a production build
# made with NEXT_PUBLIC_APP_URL=http://localhost:3100 (Next inlines it at build time).
set -e
here="$(cd "$(dirname "$0")" && pwd)"
work="${ACC_WORK_DIR:-$here/.work}"; mkdir -p "$work"
: "${ACC_DB:?set ACC_DB to the throwaway acceptance database URL}"
cd "$here/../.."
what="${1:-all}"
# The LLM stand-in is used only when no live provider key exists; the app reaches it through OPENAI_BASE_URL.
if [ "$what" = all ] || [ "$what" = llm ]; then (nohup node "$here/llm-standin.cjs" >> "$work/llm.log" 2>&1 &); fi
if [ "$what" = all ] || [ "$what" = hosts ]; then (nohup node "$here/host-sites.cjs" >> "$work/hosts.log" 2>&1 &); fi
if [ "$what" = all ] || [ "$what" = web ]; then (NODE_ENV=production DATABASE_URL="$ACC_DB" OPENAI_BASE_URL=http://127.0.0.1:4010/v1 nohup npx next start -p 3100 >> "$work/web.log" 2>&1 &); fi
if [ "$what" = all ] || [ "$what" = worker ]; then (NODE_ENV=production DATABASE_URL="$ACC_DB" OPENAI_BASE_URL=http://127.0.0.1:4010/v1 nohup npm run worker >> "$work/worker.log" 2>&1 &); fi
