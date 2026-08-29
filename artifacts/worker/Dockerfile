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
# fonts-noto-color-emoji is what makes a sticker a picture. Without it an emoji
# a person typed comes back as an empty box — the same silent shape as a missing
# Arabic font, and for the same reason: nothing fails, the render succeeds, and
# the file is wrong. Emojis go through the browser, not through ffmpeg: neither
# drawtext nor libass draws colour bitmap glyphs.
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
      ffmpeg fonts-dejavu-core fonts-noto-color-emoji ca-certificates python3 python3-numpy python3-pip \
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

# Proven at build time rather than discovered on the first render in a language
# that is not English.
#
# Drawing Arabic needs three things this image does not own: FriBidi to put the
# word in the right order, HarfBuzz to join the letters, and a font that has
# the glyphs. Lose any one of them and the render still succeeds — there are
# captions on the frame, the file plays, the duration is right, and the words
# are unreadable. That is a support ticket nobody can describe, arriving weeks
# after a base image changed under us.
#
# Only the drawing is checked, and that is the lesson this check learned the
# hard way. The first version of it also required ffmpeg to advertise
# --enable-libfribidi and --enable-libharfbuzz, and that failed the build on an
# image whose Arabic is perfectly fine: those flags describe ffmpeg's own
# drawtext filter, while captions go through libass, which links FriBidi and
# HarfBuzz itself (Debian's libass9 depends on both). A flag is a claim about
# how something was built; ink on a frame is a fact about what it does. This
# file already says that about OpenCV and Chromium, and it is worth saying
# twice.
#
# So: the same four letters are drawn as a word and again with a non-joiner
# between them, and the word has to come out with *less* ink. Joined Arabic
# forms are simpler than isolated ones, so that difference exists only if the
# letters are really being shaped — and it is also what catches a missing font,
# because four identical tofu boxes measure the same either way.
#
# libass is still required by name, because that one is about ffmpeg: without
# it the subtitles filter does not exist and no caption is drawn at all.
#
# The letters are written as octal byte escapes because /bin/sh here is dash,
# whose printf does not understand \u: it prints the six characters instead,
# which draws perfectly good Latin ink and proves nothing at all.
#
# Limited-range black is Y=16, so 16 means an empty frame, not a dark one.
RUN set -eu; \
    ffmpeg -hide_banner -version | grep -q -- "--enable-libass" \
      || { echo "ffmpeg in this image has no libass; no caption would be drawn at all"; exit 1; }; \
    beh='\330\250'; zwnj='\342\200\214'; \
    ink() { \
      { echo '[Script Info]'; echo 'ScriptType: v4.00+'; echo 'PlayResX: 640'; echo 'PlayResY: 200'; \
        echo '[V4+ Styles]'; \
        echo 'Format: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BackColour,Bold,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding'; \
        echo 'Style: P,DejaVu Sans,72,&H00FFFFFF,&H00000000,&H00000000,-1,1,0,0,5,10,10,10,1'; \
        echo '[Events]'; \
        echo 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text'; \
        echo "Dialogue: 0,0:00:00.00,0:00:01.00,P,,0,0,0,,$1"; } > /tmp/probe.ass; \
      ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=black:s=640x200:d=1 \
        -vf "subtitles=/tmp/probe.ass" -frames:v 1 -y /tmp/probe.png; \
      ffprobe -v error -f lavfi -i "movie=/tmp/probe.png,signalstats" \
        -show_entries frame_tags=lavfi.signalstats.YAVG -of default=nw=1:nk=1 | head -1; \
    }; \
    joined=$(ink "$(printf "${beh}${beh}${beh}${beh}")"); \
    apart=$(ink "$(printf "${beh}${zwnj}${beh}${zwnj}${beh}${zwnj}${beh}")"); \
    awk -v j="$joined" -v a="$apart" 'BEGIN { \
      if (j <= 16.2) { print "Arabic drew nothing: this image has no font with Arabic glyphs"; exit 1 } \
      if (j >= a)    { print "Arabic letters are not being joined (word " j " vs unjoined " a ") — shaping is missing, or the glyphs are tofu"; exit 1 } \
      print "arabic captions ready: joined " j " against " a " unjoined" }'; \
    rm -f /tmp/probe.ass /tmp/probe.png

# Proven at build time rather than discovered on the first render that wanted a
# title. A browser that will not start is a build problem; finding out about it
# in production is a support ticket.
RUN chromium --headless --no-sandbox --dump-dom about:blank > /dev/null \
 && echo "motion renderer ready: $(chromium --version)"

# And that it can draw an emoji, in colour.
#
# Same argument as the Arabic proof above, one layer along: a missing colour
# font does not fail, it draws an empty box, and the render succeeds with a
# hole in it. So the image draws one and *measures the colour*: saturation is
# the whole difference between a picture and a glyph, and white text on black
# has none of it. The letter is the control — it must come back at zero, which
# is what makes the emoji's number mean something.
# The escapes are in the *format* string, not in an argument: printf expands
# them there and copies them through %s untouched. That is the same trap the
# Arabic proof fell into one round ago wearing different clothes — and the
# measurement is what caught it both times. A proof that reads its own subject
# wrong passes for the wrong reason, or, as here, fails for one.
RUN printf '<body style="margin:0;background:#000"><div style="font-size:140px;color:#fff">\360\237\224\245</div></body>' \
      > /tmp/emoji.html \
 && printf '<body style="margin:0;background:#000"><div style="font-size:140px;color:#fff">W</div></body>' \
      > /tmp/letter.html \
 && chromium --headless --no-sandbox --disable-gpu --hide-scrollbars \
      --screenshot=/tmp/emoji.png --window-size=240,240 file:///tmp/emoji.html > /dev/null 2>&1 \
 && chromium --headless --no-sandbox --disable-gpu --hide-scrollbars \
      --screenshot=/tmp/letter.png --window-size=240,240 file:///tmp/letter.html > /dev/null 2>&1 \
 && e="$(ffprobe -v error -f lavfi -i "movie=/tmp/emoji.png,signalstats" \
      -show_entries frame_tags=lavfi.signalstats.SATAVG -of default=nw=1:nk=1 | head -1)" \
 && l="$(ffprobe -v error -f lavfi -i "movie=/tmp/letter.png,signalstats" \
      -show_entries frame_tags=lavfi.signalstats.SATAVG -of default=nw=1:nk=1 | head -1)" \
 && awk -v e="$e" -v l="$l" 'BEGIN { \
      if (e < 3) { print "the emoji drew no colour (" e "): this image has no colour emoji font"; exit 1 } \
      if (l > 0.5) { print "the control letter drew colour (" l "): the measurement is reading something else"; exit 1 } \
      print "colour emoji ready: " e " against " l " for a plain letter" }' \
 && rm -f /tmp/emoji.html /tmp/letter.html /tmp/emoji.png /tmp/letter.png

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
