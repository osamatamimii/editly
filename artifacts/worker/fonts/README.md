# The caption faces

Twelve files, six per script, every one *built* rather than downloaded — see
`make-caption-faces.py` beside them, which says how and why in full.

The catalogue that names them, with the measured numbers the renderer and the
picker both use, is `lib/api-zod/src/fonts.ts`.

## Why they are here and not in an `apt-get` line

**The arithmetic depends on these exact cuts.** `caption-layout.ts` sizes every
caption by a height and converts it to a nominal ASS size through a per-face
ratio — 0.31 to 0.57 across these twelve. Those ratios are measured from *these
bytes*, by rendering through libass and counting pixels. A packaged font is
whatever version the archive happens to hold on the day the image is built, and
a differently proportioned revision would not break anything: every caption in
that face would simply render the wrong size. The image build checks every
ratio against the catalogue for that reason, and pinning the files means the
check has nothing left to catch.

**And a build should not depend on a package name.** The image installs the
folder; there is no line to go stale and nothing to resolve at build time that
could resolve differently next month.

## What was done to them

Three things, all of them because upstream does not do them:

**Variable fonts are instanced.** Several ship as one file covering every
weight, and libass renders a variable font at its *default* instance — Regular
for all of them. The upstream file would give captions in a light weight with
no error anywhere.

**The isolated Arabic forms are mapped.** FriBidi rewrites Arabic to the legacy
presentation forms (U+FE70..FEFC) and looks those up in the cmap; a modern face
maps the joined forms and not the isolated ones, because the isolated shape is
the base glyph and U+FE8D is a duplicate. Of the seven Arabic faces tried for
this product, five drew empty boxes for every letter standing alone and one drew
boxes for every letter in the sentence. Only Noto Kufi Arabic was complete.

It is not a rare shape: alef, dal, thal, reh, zain and waw never join leftward,
so the letter after any of them is isolated. And on a system that has another
Arabic font, the unmapped codepoint resolves to *that* one instead — so the
letter renders correctly at another face's proportions in the middle of a
caption, which is worse than a box because it is legible.

**The invisible characters get a zero-width glyph.** Most of these faces map
none of U+200B..U+200F, the bidi overrides, U+2066..U+2069 or U+FEFF. Two matter
directly: this renderer wraps every right-to-left line in FSI and PDI, and
FriBidi leaves U+FEFF where it puts the lam-alef ligature. Unmapped, each is a
box in the middle of a caption, put there by us.

Before this product used Cairo it used DejaVu Sans for Arabic, which was never a
choice: it is what Debian ships. Its Arabic is correct, thin and characterless,
and beside a Montserrat Black caption it reads as an apology.

## The previews

The same pass writes a subset of each face to
`artifacts/editly/public/caption-fonts/<id>.woff2` — the sample sentence and the
alphabet, about eight kilobytes each — so the picker draws every option in the
face it names. A picker that previews a different font from the one that gets
burned is worse than a picker with no preview.

## Licences

All twelve are under the SIL Open Font License 1.1, which permits modification
and redistribution. Each `<id>-OFL.txt` is fetched beside its font because the
licence requires it to travel with the font. None of these carries a Reserved
Font Name, so the family names stay as they are; each built file's version
string records what was changed.

## Rebuilding

    pip install fonttools brotli
    python3 artifacts/worker/fonts/make-caption-faces.py

Nothing in CI runs it. CI proves the files that are committed have the
properties the renderer needs, which is a different and better question than
whether a script ran.
