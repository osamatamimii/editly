# Build the worker into a single bundle, then ship it on a runtime image that
# has ffmpeg. The build stage carries the whole monorepo; the runtime stage
# carries one .mjs file and the codecs.
#
# Build context is the repo root, not this directory — the worker imports
# @workspace/db and @workspace/api-zod from source.
FROM node:22-slim AS build
WORKDIR /repo

RUN corepack enable

# The whole workspace is copied rather than a hand-picked subset: pnpm verifies
# the lockfile against every importer it names, so a partial copy fails
# --frozen-lockfile. .dockerignore already keeps node_modules and builds out.
COPY . .

RUN pnpm install --frozen-lockfile --filter @workspace/worker...
RUN pnpm --filter @workspace/worker run build

FROM node:22-slim AS runtime
WORKDIR /app

# ffmpeg is the entire point of this container. fonts-dejavu-core supplies the
# font that drawtext and the ASS caption style both name; without it the
# watermark and captions render as nothing at all, silently.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# Renders write large intermediates; keep them on the writable layer.
ENV TMPDIR=/tmp

COPY --from=build /repo/artifacts/worker/dist ./dist

USER node
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
