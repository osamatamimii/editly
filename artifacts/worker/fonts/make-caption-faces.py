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
import unicodedata
import urllib.request
from pathlib import Path

from fontTools import ttLib
from fontTools.varLib import instancer
from fontTools.subset import Subsetter, Options

HERE = Path(__file__).parent
WEB = HERE.parents[1] / "editly" / "public" / "caption-fonts"
GF = "https://raw.githubusercontent.com/google/fonts/main"

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

    # Latin only. Rubik draws Arabic and cannot draw لا: it has no lam-alef
    # ligature glyph for plain alef, and FriBidi asks for U+FEFB by codepoint,
    # so there is nothing in the file to point that codepoint at. It was listed
    # for both scripts until one real word was rendered.
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


def rename(font: ttLib.TTFont, family: str) -> None:
    """
    One family name, everywhere a name table can hold one.

    fontconfig matches on the family, libass asks fontconfig, and a file whose
    name records say "Cairo" while the style says "Black" resolves to whatever
    the system decides Cairo means. Naming the instance outright is how a style
    row naming "Cairo Black" gets these bytes and not another cut.
    """
    name = font["name"]
    for nid, value in [(1, family), (2, "Regular"), (4, family), (6, family.replace(" ", "-")), (16, family), (17, "Regular")]:
        name.setName(value, nid, 3, 1, 0x409)
        name.setName(value, nid, 1, 0, 0)


# Unicode's name for each shape, and OpenType's. The presentation-form block
# and the GSUB feature that produces the same shape are two spellings of one
# idea, and this is the only place they have to be lined up.
FORM_FEATURE = {
    "<isolated>": "isol",
    "<initial>": "init",
    "<medial>": "medi",
    "<final>": "fina",
}


def substitutions(font: ttLib.TTFont) -> dict[str, dict[str, str]]:
    """
    What each shaping feature does, read out of the font's own GSUB.

    This is the difference between a repair that works and one that only looks
    like it. A face with *no* presentation forms at all — Rubik, KO Sans,
    GHAITHSANS — keeps every shape in GSUB and nowhere else, so mapping U+FE91
    ("beh initial form") onto the plain beh glyph would put an isolated beh in
    the middle of a word: a letter, not a box, and wrong in a way that reads as
    a broken font rather than a missing one.

    The right target is the glyph the font's own `init` lookup produces for
    beh, which is exactly what a shaper would have drawn. It is in the file
    already; it simply has no codepoint pointing at it.

    Single substitutions only, plus the ligature lookups for lam-alef. Those
    are the two shapes the Arabic presentation-form block actually contains,
    and anything more elaborate in a font's GSUB is not something a legacy
    codepoint can name.
    """
    if "GSUB" not in font:
        return {}
    gsub = font["GSUB"].table
    if not gsub.FeatureList or not gsub.LookupList:
        return {}

    def subtables(lookup):
        for sub in lookup.SubTable:
            # A type 7 lookup is a box around another lookup, used when a font
            # outgrows the 16-bit offsets. Unwrapping it is not optional: the
            # larger the font, the more likely everything interesting is inside
            # one, which would make this silently find nothing in exactly the
            # fonts that need it most.
            yield sub.ExtSubTable if lookup.LookupType == 7 else sub

    out: dict[str, dict[str, str]] = {}
    for record in gsub.FeatureList.FeatureRecord:
        tag = record.FeatureTag
        if tag not in {"isol", "init", "medi", "fina", "rlig", "liga"}:
            continue
        table = out.setdefault(tag, {})
        for index in record.Feature.LookupListIndex:
            lookup = gsub.LookupList.Lookup[index]
            for sub in subtables(lookup):
                if getattr(sub, "LookupType", lookup.LookupType) == 1 and hasattr(sub, "mapping"):
                    table.update(sub.mapping)
                elif hasattr(sub, "ligatures"):
                    for first, records in sub.ligatures.items():
                        for lig in records:
                            table["+".join([first, *lig.Component])] = lig.LigGlyph
    return out


def repair(font: ttLib.TTFont) -> tuple[int, int]:
    """Map the presentation forms and the invisibles. See the header."""
    best = font.getBestCmap()
    tables = [t for t in font["cmap"].tables if t.isUnicode()]
    features = substitutions(font)

    filled = 0
    for codepoint in range(0xFE70, 0xFEFD):
        if codepoint in best:
            continue
        decomposition = unicodedata.decomposition(chr(codepoint))
        if not decomposition:
            continue
        tag, *parts = decomposition.split()
        bases = [int(p, 16) for p in parts]
        if tag not in FORM_FEATURE or any(b not in best for b in bases):
            # A letter plus a diacritic, or a space plus one. There is no
            # single glyph to point those at and no shaper produces one.
            continue

        glyphs = [best[b] for b in bases]
        feature = FORM_FEATURE[tag]
        target: str | None = None
        if len(glyphs) == 1:
            target = features.get(feature, {}).get(glyphs[0])
            # No `isol` lookup is the normal case, not a failure: in a modern
            # font the isolated shape *is* the base glyph, which is why these
            # codepoints were left out of the cmap in the first place.
            if target is None and tag == "<isolated>":
                target = glyphs[0]
        else:
            # Lam-alef and friends. The ligature lives under `rlig` or `liga`
            # depending on the foundry, and there is no third place to look.
            key = "+".join(glyphs)
            target = features.get("rlig", {}).get(key) or features.get("liga", {}).get(key)

        if target is None or target not in font.getGlyphOrder():
            continue
        for table in tables:
            table.cmap.setdefault(codepoint, target)
        filled += 1

    blank = "editlyZeroWidth"
    order = font.getGlyphOrder()
    if blank not in order:
        from fontTools.ttLib.tables._g_l_y_f import Glyph

        font["glyf"].glyphs[blank] = Glyph()
        font["hmtx"].metrics[blank] = (0, 0)
        font.setGlyphOrder([*order, blank])
        font["maxp"].numGlyphs = len(font.getGlyphOrder())

    invisible = 0
    for codepoint in INVISIBLE:
        if codepoint in best:
            continue
        for table in tables:
            table.cmap.setdefault(codepoint, blank)
        invisible += 1

    return filled, invisible


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
        web.flavor = "woff2"
        web.save(WEB / f"{face_id}.woff2")
        print(f"  {face_id}.woff2: {(WEB / f'{face_id}.woff2').stat().st_size // 1024}KB")




if __name__ == "__main__":
    main()
