#!/usr/bin/env python3
"""
How every caption face in this folder was made, and why none of them is the
file you would get by downloading it.

Run:  python3 make-caption-faces.py       (needs fonttools and brotli)

It writes two things per face:

  artifacts/worker/fonts/<Family>.ttf                 what libass burns with
  artifacts/editly/public/caption-fonts/<id>.woff2    what the picker previews

Both from the same source, in one pass, because a picker that previews a
different font from the one that gets burned is worse than a picker with no
preview at all.

The repair itself is not in this file. It is in `facerepair.py`, because the
same repair now runs over fonts a person uploads — see `prepare-user-font.py` —
and a font somebody handed us getting a weaker repair than the ones we chose is
the exact shape of the failure this whole area is about.

## Three things upstream does not do

**Variable fonts.** Several of these ship as one file covering every weight.
libass renders a variable font at its *default* instance, which is Regular for
all of them — so the upstream file would give captions in a light weight, with
no error anywhere. The chosen instance is baked out.

**The isolated Arabic forms.** This is the one that cost a day. Arabic letters
change shape by position, and there are two ways to express that: `GSUB`, which
a modern shaper applies, and the legacy Arabic Presentation Forms block at
U+FE70..FEFC, where every shape has its own codepoint. FriBidi still uses the
second: handed Arabic, it rewrites each letter to the presentation-form
codepoint its position calls for, and the renderer looks *that* up in the cmap.

A modern face maps the joined forms and not the **isolated** ones, because in a
modern font the isolated shape is the base glyph and U+FE8D is a duplicate
nobody should need. Measured: of the seven Arabic faces tried here, five drew
empty boxes for every letter standing alone, and one — Readex Pro — drew boxes
for every letter in the sentence. Only Noto Kufi Arabic was complete.

It is not a rare shape. Alef, dal, thal, reh, zain and waw never join leftward,
so the letter after any of them is isolated; an alef opening a word is
isolated; a one-letter word is isolated. "لا أحد يخبرك بهذا" has three.

Worse than boxes, on a machine that has another Arabic font: the unmapped
codepoint resolves through fontconfig to *that* font instead, so the letter
renders correctly at another face's proportions in the middle of a caption,
and nothing anywhere reports it.

So each unmapped isolated form is mapped onto the glyph it duplicates, taken
from Unicode's own decomposition data rather than a table somebody typed. No
outlines are added and no shapes change: it says in the cmap the thing the font
already knew.

**The invisible characters.** Most of these faces map none of the formatting
characters — U+200B..U+200F, the bidi overrides, U+2066..U+2069, U+FEFF — and
an unmapped character is a box like any other. Two matter here directly: the
caption writer wraps every right-to-left line in FSI and PDI so a line
beginning with a Latin word cannot flip it, and FriBidi replaces lam+alef with
the FEFB ligature and leaves U+FEFF in the slot it freed. Unmapped, each is a
box in the middle of a caption, put there by us.

They get a real glyph: empty, zero advance. Not the space glyph — a space has
width, and every line would sit off-centre by however many invisibles it holds.

## What this script does not do

It does not decide the size ratios. Those are measured by rendering through
libass and counting pixels — see `tools/font-test.mjs`, which reads them out of
the catalogue and checks each one against what is actually drawn. A number in a
table that nobody measured is the same object as a message nobody checked.

## Licences

Every face here is under the SIL Open Font License 1.1, which permits
modification and redistribution. Each one's `OFL.txt` is fetched beside it,
because the licence requires it to travel with the font. Where a face's
copyright line carries a Reserved Font Name the family is renamed; none of
these do, and the version string of each built file records what was changed.
"""
import sys
import urllib.request
from pathlib import Path

from fontTools import ttLib
from fontTools.varLib import instancer
from fontTools.subset import Subsetter, Options

sys.path.insert(0, str(Path(__file__).parent))
from facerepair import rename, repair, stamp  # noqa: E402

HERE = Path(__file__).parent
WEB = HERE.parents[1] / "editly" / "public" / "caption-fonts"
GF = "https://raw.githubusercontent.com/google/fonts/main"

# What the picker draws in each face. Enough of both scripts to judge one by,
# and small enough that twelve subsets are a rounding error on the page.
PREVIEW = (
    "لا أحد يخبرك بهذا لكنه يغير كل شيء ٠١٢٣٤٥٦٧٨٩"
    "NOBODY TELLS YOU THIS nobody tells you this 0123456789.,!?'\"-:;()"
)

FACES = [
    # id, family, source path under google/fonts, licence dir, instance
    ("montserrat-black", "Montserrat Black", "ofl/montserrat/Montserrat%5Bwght%5D.ttf", "ofl/montserrat", {"wght": 900}),
    ("anton", "Anton", "ofl/anton/Anton-Regular.ttf", "ofl/anton", None),
    ("bebas-neue", "Bebas Neue", "ofl/bebasneue/BebasNeue-Regular.ttf", "ofl/bebasneue", None),
    ("archivo-black", "Archivo Black", "ofl/archivoblack/ArchivoBlack-Regular.ttf", "ofl/archivoblack", None),
    ("poppins-extrabold", "Poppins ExtraBold", "ofl/poppins/Poppins-ExtraBold.ttf", "ofl/poppins", None),
    ("oswald-bold", "Oswald Bold", "ofl/oswald/Oswald%5Bwght%5D.ttf", "ofl/oswald", {"wght": 700}),

    ("cairo-black", "Cairo Black", "ofl/cairo/Cairo%5Bslnt%2Cwght%5D.ttf", "ofl/cairo", {"wght": 900, "slnt": 0}),
    ("tajawal-black", "Tajawal Black", "ofl/tajawal/Tajawal-Black.ttf", "ofl/tajawal", None),
    ("almarai-extrabold", "Almarai ExtraBold", "ofl/almarai/Almarai-ExtraBold.ttf", "ofl/almarai", None),
    ("changa-extrabold", "Changa ExtraBold", "ofl/changa/Changa%5Bwght%5D.ttf", "ofl/changa", {"wght": 800}),
    ("noto-kufi-black", "Noto Kufi Arabic Black", "ofl/notokufiarabic/NotoKufiArabic%5Bwght%5D.ttf", "ofl/notokufiarabic", {"wght": 900}),
    ("alexandria-extrabold", "Alexandria ExtraBold", "ofl/alexandria/Alexandria%5Bwght%5D.ttf", "ofl/alexandria", {"wght": 800}),

    # Latin only, and the reason written here was wrong: Rubik does have the
    # lam-alef ligature, for plain alef, in both its forms. What it did not have
    # was a codepoint pointing at it, because `facerepair.py` looked the
    # ligature up under the base glyph names and no font keys it that way. That
    # is fixed; the file committed under `fonts/` is the old repair's output and
    # still lacks those eight codepoints, so it stays Latin here until it is
    # rebuilt and a second row is measured for it. See the note in `fonts.ts`.
    ("rubik-black", "Rubik Black", "ofl/rubik/Rubik%5Bwght%5D.ttf", "ofl/rubik", {"wght": 900}),
]


def fetch(url: str, to: Path, text: bool = False) -> Path:
    """
    Download once, and land the same bytes every time.

    `text` normalises CRLF. The licences upstream serves have Windows line
    endings; committed as they arrive, `git am` rewrites them to LF on the way
    in, so the tree produced by applying a patch is not the tree the patch was
    made from — which turns "the patch applied cleanly" into a claim that is
    not quite true.
    """
    if not to.exists():
        print(f"  downloading {to.name}")
        urllib.request.urlretrieve(url, to)
        if text:
            to.write_bytes(to.read_bytes().replace(b"\r\n", b"\n"))
    return to


def main() -> None:
    WEB.mkdir(parents=True, exist_ok=True)
    cache = HERE / ".sources"
    cache.mkdir(exist_ok=True)

    for face_id, family, source, licence_dir, location in FACES:
        print(f"{family}")
        raw = fetch(f"{GF}/{source}", cache / f"{face_id}.ttf")
        fetch(f"{GF}/{licence_dir}/OFL.txt", HERE / f"{face_id}-OFL.txt", text=True)

        font = ttLib.TTFont(raw)
        if location is not None:
            axes = {a.axisTag: (a.minValue, a.maxValue) for a in font["fvar"].axes}
            pinned = {}
            for tag, (low, high) in axes.items():
                want = location.get(tag, 0 if low <= 0 <= high else low)
                pinned[tag] = min(max(want, low), high)
            font = instancer.instantiateVariableFont(font, pinned, inplace=False, updateFontNames=False)

        rename(font, family)
        filled, invisible = repair(font)
        stamp(font)

        out = HERE / f"{family.replace(' ', '-')}.ttf"
        font.save(out)
        print(f"  {out.name}: +{filled} presentation forms, +{invisible} zero-width")

        # And the preview, from the same object rather than a second download.
        web = ttLib.TTFont(out)
        options = Options()
        options.flavor = "woff2"
        options.desubroutinize = True
        options.layout_features = ["*"]
        subsetter = Subsetter(options=options)
        subsetter.populate(text=PREVIEW)
        subsetter.subset(web)
        stamp(web)
        web.flavor = "woff2"
        web.save(WEB / f"{face_id}.woff2")
        print(f"  {face_id}.woff2: {(WEB / f'{face_id}.woff2').stat().st_size // 1024}KB")




if __name__ == "__main__":
    main()
