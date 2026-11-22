# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
# postinstall runs scripts/copy-vendor.js, so it must exist before npm ci.
COPY scripts/copy-vendor.js ./scripts/copy-vendor.js
RUN npm ci

COPY src ./src
COPY db ./db
COPY public ./public
COPY scripts ./scripts

# The runtime image must not carry ESLint, Prettier or the rest of the toolchain.
RUN npm prune --omit=dev


FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/db ./db
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/scripts ./scripts

# Running as the built-in unprivileged user: nothing in the app needs root.
USER node

EXPOSE 3000

ENTRYPOINT ["sh", "scripts/docker-entrypoint.sh"]
