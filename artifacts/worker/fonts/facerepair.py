#!/usr/bin/env python3
"""
Making an arbitrary font file into one this renderer can burn captions with.

Two callers, one body. `make-caption-faces.py` runs it over the thirteen faces
the product ships; `prepare-user-font.py` runs it over whatever a person
uploads. They must be the same code, because the thing being repaired is a
property of fonts in general and not of the thirteen we happened to pick — and
because a user's font that got a weaker repair than ours would fail in the one
way this whole file exists to prevent: legibly, on some machines, silently.

What the repair is, and why a font needs one at all, is written at the top of
`make-caption-faces.py`. The short version: FriBidi rewrites Arabic into the
legacy presentation-form codepoints and looks *those* up in the cmap, modern
fonts do not map them, and an unmapped codepoint on a machine that has another
Arabic font is drawn by that font instead — a correct letter at the wrong
proportions in the middle of a caption, with nothing failing anywhere.
"""
import unicodedata

from fontTools import ttLib
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen

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

# Unicode's name for each shape, and OpenType's. The presentation-form block
# and the GSUB feature that produces the same shape are two spellings of one
# idea, and this is the only place they have to be lined up.
FORM_FEATURE = {
    "<isolated>": "isol",
    "<initial>": "init",
    "<medial>": "medi",
    "<final>": "fina",
}

BLANK = "editlyZeroWidth"

# A fixed date in every built face, so that building twice from the same source
# lands the same bytes.
#
# `head.modified` is a clock reading, and fontTools writes the current one on
# every save. With it, rebuilding thirteen unchanged faces produces thirteen
# changed files — and the question "did the repair change anything" stops
# having an answer you can get from `git diff`. Which is the question this
# whole folder is reviewed by.
#
# 2000-01-01, in the font epoch (seconds since 1904-01-01).
EPOCH = 3029529600


def stamp(font: ttLib.TTFont) -> None:
    """Same input, same bytes. See EPOCH."""
    # Both, and the second one is the one that matters: fontTools rewrites
    # `modified` from the system clock at compile time unless told not to, so
    # setting the field alone changes nothing at all.
    font.recalcTimestamp = False
    head = font["head"]
    head.created = EPOCH
    head.modified = EPOCH


def rename(font: ttLib.TTFont, family: str) -> None:
    """
    One family name, everywhere a name table can hold one.

    fontconfig matches on the family, libass asks fontconfig, and a file whose
    name records say "Cairo" while the style says "Black" resolves to whatever
    the system decides Cairo means. Naming the instance outright is how a style
    row naming "Cairo Black" gets these bytes and not another cut.
    """
    name = font["name"]
    for nid, value in [
        (1, family),
        (2, "Regular"),
        (4, family),
        (6, family.replace(" ", "-")),
        (16, family),
        (17, "Regular"),
    ]:
        name.setName(value, nid, 3, 1, 0x409)
        name.setName(value, nid, 1, 0, 0)


def family_of(font: ttLib.TTFont) -> str:
    """The name the font calls itself, preferring the typographic family."""
    name = font["name"]
    for nid in (16, 1):
        for record in name.names:
            if record.nameID == nid:
                try:
                    text = record.toUnicode().strip()
                except UnicodeDecodeError:
                    continue
                if text:
                    return text
    return ""


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


def to_truetype(font: ttLib.TTFont, tolerance: float = 1.0) -> ttLib.TTFont:
    """
    Cubic outlines to quadratic ones, so every font leaves here as one kind.

    An `.otf` keeps its outlines in `CFF `, and half the repair below cannot be
    done to one: adding the zero-width glyph means adding to `glyf`, which a
    CFF font does not have. Six of the first eleven fonts a person handed this
    product were `.otf`, so "we only take TrueType" is not an answer, and a
    repair that quietly skipped its second half on those six would be the same
    silent-wrongness this file exists to stop.

    So the outlines are converted once, on the way in, and everything
    downstream — the repair, the subset, the measurement, the burn — sees one
    format. The conversion is the ordinary cubic-to-quadratic approximation at
    a one-unit tolerance, which is a fifth of a pixel at caption size.
    """
    if "glyf" in font:
        return font

    glyphset = font.getGlyphSet()
    order = font.getGlyphOrder()
    glyf = ttLib.newTable("glyf")
    glyf.glyphOrder = order
    glyf.glyphs = {}
    for name in order:
        pen = TTGlyphPen(glyphset)
        glyphset[name].draw(Cu2QuPen(pen, tolerance))
        glyf.glyphs[name] = pen.glyph()
    font["glyf"] = glyf

    # `loca` is written from `glyf` on save, but the table has to exist for the
    # compiler to reach it, and `maxp` has to be the TrueType version or it
    # carries none of the fields `glyf` needs.
    font["loca"] = ttLib.newTable("loca")
    maxp = font["maxp"]
    maxp.tableVersion = 0x00010000
    for field, value in [
        ("maxZones", 1),
        ("maxTwilightPoints", 0),
        ("maxStorage", 0),
        ("maxFunctionDefs", 0),
        ("maxInstructionDefs", 0),
        ("maxStackElements", 0),
        ("maxSizeOfInstructions", 0),
        ("maxComponentElements", 0),
        ("maxComponentDepth", 0),
    ]:
        setattr(maxp, field, value)
    font["head"].indexToLocFormat = 0
    font["glyf"].compile(font)

    for table in ("CFF ", "CFF2", "VORG"):
        if table in font:
            del font[table]
    font.sfntVersion = "\x00\x01\x00\x00"
    return font


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

    order = font.getGlyphOrder()
    if BLANK not in order:
        from fontTools.ttLib.tables._g_l_y_f import Glyph

        font["glyf"].glyphs[BLANK] = Glyph()
        font["hmtx"].metrics[BLANK] = (0, 0)
        font.setGlyphOrder([*order, BLANK])
        font["maxp"].numGlyphs = len(font.getGlyphOrder())

    invisible = 0
    for codepoint in INVISIBLE:
        if codepoint in best:
            continue
        for table in tables:
            table.cmap.setdefault(codepoint, BLANK)
        invisible += 1

    return filled, invisible
