#!/usr/bin/env python3
"""
How Cairo-Black.ttf in this folder was made, and why it is not the file you
would get by downloading Cairo.

Run:  python3 make-arabic-face.py        (needs fonttools)

## Why a script at all

Two reasons, and the first is boring: Google ships Cairo as a *variable* font,
one file covering every weight from 200 to 1000. libass renders a variable
font at its default instance, which for Cairo is Regular — so shipping the
upstream file would give captions in a light weight and no error anywhere. The
Black instance has to be baked out.

The second reason is the one worth reading.

## The isolated forms

Arabic letters change shape by position: initial, medial, final, isolated. A
modern font expresses that in `GSUB`, and a modern shaper (HarfBuzz) applies
it. There is also a *legacy* path — the Arabic Presentation Forms block,
U+FE70..U+FEFC, where every shape has its own codepoint — and FriBidi still
uses it: given Arabic text it rewrites each letter to the presentation-form
codepoint for the shape that position calls for, and the renderer then looks
that codepoint up in the font's `cmap`.

Cairo maps 89 of those codepoints. It does not map the **isolated** ones,
because in a modern font the isolated shape *is* the base glyph — `uni0627` is
the isolated alef, and `U+FE8D` is a duplicate nobody should need.

The result, measured rather than reasoned about: every Arabic letter that
stands alone renders as an empty box. That is not a rare case. Alef, dal, thal,
reh, zain and waw never join to their left, so the letter *after* any of them
is isolated; alef at the start of a word is isolated; any one-letter word is
isolated. In "لا أحد يخبرك بهذا" — six words — three characters came out as
boxes.

So this maps each unmapped isolated form onto the base glyph it is a
duplicate of, taken from Unicode's own decomposition data rather than from a
table somebody typed. It adds no outlines and changes no shapes: it says, in
the cmap, the thing the font already knew.

## The invisible characters

The same measurement found the other half. Cairo maps none of the formatting
characters — U+200B..U+200F, the bidi overrides, U+2066..U+2069, U+FEFF — and
an unmapped character is a box like any other. Two of those matter to this
product directly: the caption writer wraps every right-to-left line in FSI and
PDI (U+2066/U+2069) so a line beginning with a Latin word cannot flip the
whole line, and FriBidi replaces lam+alef with the FEFB ligature and leaves
U+FEFF behind in the slot it freed. Unmapped, each of those is a box on screen
in the middle of a caption.

They get a real glyph: empty, zero advance. Not the space glyph — a space has
width, and every line would sit off-centre by however many invisible
characters it contains.

## Licence

Cairo is under the SIL Open Font License 1.1 (`Cairo-OFL.txt`), which permits
modification and redistribution. Its copyright line carries no Reserved Font
Name, so the family name may stay as it is; the version string is stamped
below to say the file has been changed and how.

Upstream: https://github.com/Gue3bara/Cairo
"""
import unicodedata
import urllib.request
from pathlib import Path

from fontTools import ttLib
from fontTools.varLib import instancer

HERE = Path(__file__).parent
UPSTREAM = "https://raw.githubusercontent.com/google/fonts/main/ofl/cairo/Cairo%5Bslnt%2Cwght%5D.ttf"
LICENCE = "https://raw.githubusercontent.com/google/fonts/main/ofl/cairo/OFL.txt"
OUTPUT = HERE / "Cairo-Black.ttf"

# 900 rather than 1000. Cairo's axis runs to 1000, and at caption size the
# extra weight closes the counters of ص، ط، ه until they read as blobs on a
# phone. Measured by rendering both, not chosen from a specification.
WEIGHT = 900

# Everything a renderer may be handed that must occupy no space and draw
# nothing. The two this product produces itself are 2066 and 2069.
INVISIBLE = [
    0x061C,
    *range(0x200B, 0x2010),
    *range(0x202A, 0x202F),
    *range(0x2060, 0x2065),
    *range(0x2066, 0x206A),
    0xFEFF,
]


def fetch(url: str, to: Path) -> Path:
    if not to.exists():
        print(f"downloading {to.name}")
        urllib.request.urlretrieve(url, to)
    return to


def main() -> None:
    source = fetch(UPSTREAM, HERE / "Cairo-variable.ttf")
    fetch(LICENCE, HERE / "Cairo-OFL.txt")

    font = instancer.instantiateVariableFont(
        ttLib.TTFont(source), {"wght": WEIGHT, "slnt": 0}, inplace=False, updateFontNames=True
    )

    best = font.getBestCmap()
    unicode_tables = [t for t in font["cmap"].tables if t.isUnicode()]

    # ── The isolated forms, from Unicode's own decompositions ────────────────
    filled = 0
    for codepoint in range(0xFE70, 0xFEFD):
        if codepoint in best:
            continue
        decomposition = unicodedata.decomposition(chr(codepoint))
        if not decomposition:
            continue
        tag, *parts = decomposition.split()
        bases = [int(p, 16) for p in parts]
        # Only one-to-one forms. The rest are a letter plus a diacritic, or a
        # space plus one, and there is no single glyph to point them at.
        if tag != "<isolated>" or len(bases) != 1 or bases[0] not in best:
            continue
        for table in unicode_tables:
            table.cmap.setdefault(codepoint, best[bases[0]])
        filled += 1

    # ── One empty glyph, for everything that must not be seen ───────────────
    blank = "editlyZeroWidth"
    glyph_order = font.getGlyphOrder()
    if blank not in glyph_order:
        from fontTools.ttLib.tables._g_l_y_f import Glyph

        font["glyf"].glyphs[blank] = Glyph()
        font["hmtx"].metrics[blank] = (0, 0)
        font.setGlyphOrder([*glyph_order, blank])
        font["maxp"].numGlyphs = len(font.getGlyphOrder())

    invisible = 0
    for codepoint in INVISIBLE:
        if codepoint in best:
            continue
        for table in unicode_tables:
            table.cmap.setdefault(codepoint, blank)
        invisible += 1

    # Stamped so the file says of itself that it is not upstream's.
    name = font["name"]
    for record in name.names:
        if record.nameID == 5:
            record.string = (
                f"{record.toUnicode()}; wght {WEIGHT} instance; "
                f"+{filled} isolated forms, +{invisible} zero-width"
            )

    font.save(OUTPUT)
    print(f"wrote {OUTPUT.name}: {filled} isolated forms mapped, {invisible} invisible characters mapped")


if __name__ == "__main__":
    main()
