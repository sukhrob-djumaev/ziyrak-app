# ---- Builder stage ----
FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY .puppeteerrc.cjs ./
RUN npm ci

COPY . .

RUN npx prisma generate
# Dummy value only, so `next build` can statically analyze routes that import auth.ts;
# the real secret is supplied at container runtime via .env / env_file, never baked into this image.
ARG JWT_SECRET=build-time-placeholder-unused-at-runtime
RUN npm run build

# L2.2 / F12: the worker no longer runs TypeScript source through tsx at runtime. Our own code is bundled into one
# file (dependencies stay external), so the runtime image needs neither src/ nor the development dependencies.
# CommonJS output: with --packages=external the dependencies are loaded by Node's normal package resolution, which
# (unlike native ESM) accepts extensionless subpaths such as "next/server" that tsx used to paper over.
# The generated Prisma client reads import.meta.url, which CommonJS lacks; define it from the bundle's own path.
RUN npx esbuild src/worker.ts --bundle --platform=node --format=cjs --packages=external \
      --banner:js="const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" \
      --define:import.meta.url=__importMetaUrl \
      --sourcemap --outfile=dist/worker.cjs --log-level=warning \
 && npm prune --omit=dev

# ---- Runner stage ----
FROM node:22-slim AS runner

LABEL org.opencontainers.image.source="https://github.com/sukhrob-djumaev/ziyrak-app"
LABEL org.opencontainers.image.description="AI-powered customer support agent"

# L2.2 / F12: apply pending OS security fixes at build time, and drop npm/npx (nothing at runtime needs them: migrations
# call the Prisma CLI directly). npm's bundled copies of tar, pacote, sigstore etc. were the image's only Node findings.
RUN apt-get update && apt-get -y --no-install-recommends upgrade && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# L2.2 / F12: the browser stack exists only for the dev/demo-only WhatsApp Web channel (off in production). It is
# excluded by default; build with --build-arg WITH_BROWSER=true for a demo image.
ARG WITH_BROWSER=false
RUN if [ "$WITH_BROWSER" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends \
        chromium fonts-liberation libappindicator3-1 libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
        libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 xdg-utils \
      && rm -rf /var/lib/apt/lists/*; \
    fi

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
# Only meaningful in a WITH_BROWSER=true image; without the browser the demo channel fails with a clear missing-binary error.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV PORT=3000
# L2.1 / F11: identity of what is deployed, reported by /api/health. Set with --build-arg APP_BUILD_SHA=<git sha>.
ARG APP_BUILD_SHA=unknown
ENV APP_BUILD_SHA=$APP_BUILD_SHA

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

WORKDIR /app

COPY --chown=nextjs:nodejs --from=builder /app/package*.json ./
COPY --chown=nextjs:nodejs --from=builder /app/.puppeteerrc.cjs ./
COPY --chown=nextjs:nodejs --from=builder /app/node_modules ./node_modules
COPY --chown=nextjs:nodejs --from=builder /app/.next ./.next
COPY --chown=nextjs:nodejs --from=builder /app/public ./public
COPY --chown=nextjs:nodejs --from=builder /app/prisma ./prisma
COPY --chown=nextjs:nodejs --from=builder /app/prisma.config.ts ./
COPY --chown=nextjs:nodejs --from=builder /app/next.config.ts ./
COPY --chown=nextjs:nodejs --from=builder /app/tsconfig.json ./
# PLAN.md §25.3/§46.6 PR2 — the worker is not part of Next.js's own output (`.next/`); since L2.2 it is the bundle
# built in the builder stage (dist/worker.cjs, run with `node dist/worker.cjs`). node_modules is the production-only
# set (`npm prune --omit=dev` above), so the runtime image no longer ships tsx, test runners or linters.
COPY --chown=nextjs:nodejs --from=builder /app/dist ./dist

# Ownership is set at COPY time: a recursive chown afterwards would duplicate the whole application layer.
RUN mkdir -p /app/.wwebjs_auth && chown nextjs:nodejs /app /app/.wwebjs_auth

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health/ready').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

# `exec` + `node` directly (not `npm start`): npm as PID 1 does not forward
# SIGTERM, so a scale-down or rolling deploy would hard-kill the server instead
# of letting it drain (PLAN.md §46.8 — found by the multi-replica load test).
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && exec node node_modules/next/dist/bin/next start"]
