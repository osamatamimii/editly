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

# Chromium is here for designed motion: titles are described in HTML and CSS
# and rendered frame-by-frame with time driven by hand, because a spring —
# overshoot then settle — is a curve no ffmpeg easing can draw. Debian's
# packaged build is used rather than a Playwright download so the image has one
# browser rather than two, and so the version is whatever the distribution has
# patched rather than whatever a lockfile pinned last spring.
#
# ffmpeg is the entire point of this container. fonts-dejavu-core supplies the
# font that drawtext and the ASS caption style both name; without it the
# watermark and captions render as nothing at all, silently.
#
# Python and OpenCV are here for the subject tracker, which decides where the
# 9:16 window goes. opencv-python-headless rather than the full package because
# nothing in this container has a display, and headless drops the GTK and GUI
# dependencies — about 200 MB of an image that has no screen to draw on.
#
# The face cascades ship *inside* opencv, so nothing is downloaded at build time
# and nothing is fetched at run time: the image does not depend on a model host
# still being reachable in a year, which is the failure mode that takes a
# working deployment down without a single line of code changing.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg fonts-dejavu-core ca-certificates python3 python3-numpy python3-pip \
      chromium \
 && pip3 install --no-cache-dir --break-system-packages "opencv-python-headless==4.13.0.*" \
 && rm -rf /var/lib/apt/lists/*

# Proven at build time rather than discovered on the first render that needed
# it. Tracking degrades silently by design — that is the right behaviour at run
# time and exactly the wrong thing to find out about in production.
RUN python3 -c "import cv2, os; \
    p = os.path.join(cv2.data.haarcascades, 'haarcascade_frontalface_default.xml'); \
    assert os.path.exists(p), 'face cascade missing from opencv'; \
    assert not cv2.CascadeClassifier(p).empty(), 'face cascade will not load'; \
    print('subject tracking ready:', cv2.__version__)"

# Proven at build time rather than discovered on the first render that wanted a
# title. A browser that will not start is a build problem; finding out about it
# in production is a support ticket.
RUN chromium --headless --no-sandbox --dump-dom about:blank > /dev/null \
 && echo "motion renderer ready: $(chromium --version)"

# playwright-core only — the driver, not the browsers. It is a few megabytes
# and it is deliberately NOT bundled: see build.mjs.
RUN npm install --no-save --omit=dev playwright-core@1.62.1

ENV CHROMIUM_PATH=/usr/bin/chromium
ENV NODE_ENV=production
# Renders write large intermediates; keep them on the writable layer.
ENV TMPDIR=/tmp

# Carries the bundle and the tracker script beside it.
COPY --from=build /repo/artifacts/worker/dist ./dist

USER node
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
