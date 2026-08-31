# The caption faces

Two files, one per script, both in the repository rather than installed from
the distribution.

| script | family | file | ratio |
|---|---|---|---|
| Latin | Montserrat Black | `Montserrat-Black.otf` | 0.54 of nominal, cap height |
| Arabic | Cairo Black | `Cairo-Black.ttf` | 0.38 of nominal, alef height |

## Why they are here and not in an `apt-get` line

**The arithmetic depends on these exact cuts.** `caption-layout.ts` sizes every
caption by a height and converts it to a nominal ASS size through a per-face
ratio. Those ratios are measured from *these bytes*, by rendering through
libass and counting pixels. A packaged font is whatever version the archive
happens to hold on the day the image is built, and a differently proportioned
revision would not break anything: every caption in the product would simply
render the wrong size. The Dockerfile checks both ratios for that reason, and
pinning the files means the check has nothing left to catch.

**And a build should not depend on a package name.** The image installs the
files; there is no line to go stale and nothing to resolve at build time that
could resolve differently next month.

## The Latin face

Montserrat Black. Nothing was done to it; it is the upstream file.

Licensed under the SIL Open Font License 1.1 — `Montserrat-OFL.txt` here, which
the licence requires to travel with the font. Redistribution is explicitly
permitted; selling the font on its own is not, and we do not.

Upstream: https://github.com/JulietaUla/Montserrat

## The Arabic face

Cairo Black, and it is **not** the file you would get by downloading Cairo.
`make-arabic-face.py` beside it builds it from upstream and says why in full;
the short version is two things upstream does not do:

- Google ships Cairo as one variable file covering weight 200 to 1000. libass
  renders a variable font at its default instance, which for Cairo is Regular,
  so the upstream file would give captions in a light weight with no error
  anywhere. The Black instance is baked out.
- Cairo maps none of the **isolated** Arabic presentation forms (U+FE8D and its
  35 siblings), because in a modern font the isolated shape is the base glyph
  and those codepoints are duplicates. FriBidi still asks for them. Every
  letter that stands alone — and after alef, dal, thal, reh, zain or waw, every
  letter stands alone — then came from whatever other font on the system had
  the codepoint, at that font's proportions, or from none at all and drew as a
  box. The script maps each one onto the glyph it duplicates, taken from
  Unicode's own decomposition data. It adds no outlines and changes no shapes.
  It also gives the invisible formatting characters a real zero-width glyph,
  including the FSI and PDI this renderer wraps every right-to-left line in.

Before this product used Cairo it used DejaVu Sans, which was never a choice:
it is what Debian ships. Its Arabic is correct, thin and characterless, and
beside a Montserrat Black caption it reads as an apology.

Licensed under the SIL Open Font License 1.1 — `Cairo-OFL.txt` here. The OFL
permits modification and redistribution, and Cairo's copyright line carries no
Reserved Font Name, so the family name stays as it is; the version string in
the built file records what was changed.

Upstream: https://github.com/Gue3bara/Cairo

## Rebuilding the Arabic face

    pip install fonttools
    python3 artifacts/worker/fonts/make-arabic-face.py

It downloads upstream, bakes the instance, fills the cmap and writes
`Cairo-Black.ttf`. Nothing in CI runs it: CI proves the file that is committed
has the properties the renderer needs, which is a different and better
question than whether a script ran.
