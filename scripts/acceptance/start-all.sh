#!/bin/sh
# Start the acceptance topology against an ISOLATED database. Usage: start-all.sh [web|worker|llm|hosts|all]
# Requires: ACC_DB (postgres URL of a throwaway database with migrations applied) and a production build
# made with NEXT_PUBLIC_APP_URL=http://localhost:3100 (Next inlines it at build time).
#
# Real-model acceptance: set ACC_REAL_AI=1 to run against a real, configured AIProvider instead of
# the local stand-in — no application code changes, only env vars (this script and j01-signup.cjs
# read them). With ACC_REAL_AI=1: the stand-in is not started, OPENAI_BASE_URL is not set (so
# OpenAIProvider's SDK client falls through to the real https://api.openai.com/v1 — AnthropicProvider
# always talks to the real Anthropic API regardless), and j01-signup.cjs types
# ACC_REAL_AI_KEY (required) into the wizard instead of a fake key, with ACC_REAL_AI_PROVIDER
# (openai|anthropic, default openai) and ACC_REAL_AI_MODEL (default gpt-4o-mini /
# claude-3-5-haiku-20241022) selecting the model. Secrets are never echoed by this script.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
work="${ACC_WORK_DIR:-$here/.work}"; mkdir -p "$work"
: "${ACC_DB:?set ACC_DB to the throwaway acceptance database URL}"
cd "$here/../.."
what="${1:-all}"
if [ "$what" = all ] || [ "$what" = llm ]; then
  if [ "${ACC_REAL_AI:-0}" != "1" ]; then (nohup node "$here/llm-standin.cjs" >> "$work/llm.log" 2>&1 &); fi
fi
if [ "$what" = all ] || [ "$what" = hosts ]; then (nohup node "$here/host-sites.cjs" >> "$work/hosts.log" 2>&1 &); fi
if [ "$what" = all ] || [ "$what" = web ]; then
  if [ "${ACC_REAL_AI:-0}" = "1" ]; then
    (NODE_ENV=production DATABASE_URL="$ACC_DB" nohup npx next start -p 3100 >> "$work/web.log" 2>&1 &)
  else
    (NODE_ENV=production DATABASE_URL="$ACC_DB" OPENAI_BASE_URL=http://127.0.0.1:4010/v1 nohup npx next start -p 3100 >> "$work/web.log" 2>&1 &)
  fi
fi
if [ "$what" = all ] || [ "$what" = worker ]; then
  if [ "${ACC_REAL_AI:-0}" = "1" ]; then
    (NODE_ENV=production DATABASE_URL="$ACC_DB" nohup npm run worker >> "$work/worker.log" 2>&1 &)
  else
    (NODE_ENV=production DATABASE_URL="$ACC_DB" OPENAI_BASE_URL=http://127.0.0.1:4010/v1 nohup npm run worker >> "$work/worker.log" 2>&1 &)
  fi
fi
