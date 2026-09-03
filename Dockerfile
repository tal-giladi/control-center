# The image carries git because the data store is a git repository the running
# app clones, commits to, and pushes on its own.
FROM node:24.19.0-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24.19.0-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    CONTROL_CENTER_DATA_DIR=/data \
    GIT_ASKPASS=/usr/local/bin/control-center-askpass
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY scripts/docker-askpass.sh /usr/local/bin/control-center-askpass
RUN chmod +x /usr/local/bin/control-center-askpass && mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000
# Binding to every interface inside the container is safe because the compose
# file publishes the port on the host loopback only. The app still rejects any
# request whose Host header is not loopback.
CMD ["npx", "next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
