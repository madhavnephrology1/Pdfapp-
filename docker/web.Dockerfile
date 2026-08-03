# syntax=docker/dockerfile:1

FROM node:22-slim AS deps
WORKDIR /repo
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/test-fixtures/package.json packages/test-fixtures/
RUN npm ci


FROM node:22-slim AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
# The API base is compiled into the bundle, so it must be known at build time.
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
ARG NEXT_PUBLIC_MAX_UPLOAD_MB=100
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL \
    NEXT_PUBLIC_MAX_UPLOAD_MB=$NEXT_PUBLIC_MAX_UPLOAD_MB
RUN npm run build --workspace @pdfreader/web


FROM node:22-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/web ./apps/web

RUN useradd --create-home --uid 10001 reader && chown -R reader:reader /repo
USER reader

WORKDIR /repo/apps/web
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "next", "start", "-p", "3000"]
