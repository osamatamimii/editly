#!/usr/bin/env python3
"""
One uploaded font file, made into something this renderer can burn with.

Run:  python3 prepare-user-font.py <source> <font-dir> <preview-dir> [--id ID]

Prints one JSON object on stdout and nothing else, because the caller is a
worker and not a person:

  {"ok": true, "family": "...", "file": "...", "preview": "...",
   "arabicGlyphs": 0, "latinGlyphs": 0, "forms": 0, "invisible": 0}
  {"ok": false, "code": "...", "detail": "..."}

## Two directories, and it is not tidiness

The burnable face and the picker's preview go to different places because they
cannot share one. The preview is a *subset* — the twenty or so characters the
picker draws — carrying the same family name as the full file. Put the two side
by side and fontconfig indexes both under that name; libass then picks one of
them, and when it picks the subset every character outside the sample renders
as nothing at all. Measured: the same face, byte for byte, accepted from one
directory and refused as blank from another, the only difference being the name
of the woff2 lying next to it.

## What it does, and what it deliberately does not

It repairs — the same repair the thirteen shipped faces get, from the same
module, for the reasons written at the top of `facerepair.py`. It converts
cubic outlines to quadratic, because six of the first eleven fonts a person
handed this product were `.otf` and half the repair cannot be done to one. It
renames the family to something addressable, because the name a foundry put in
the file may collide with a font already on the machine, and a style row that
resolves to the wrong file is the failure mode this whole area is about.

It does **not** decide whether the font is any good, and it does not measure
it. Measuring means rendering, rendering means libass, and libass is on the
other side of this process boundary — see `artifacts/worker/src/font-intake.ts`,
which does that half. A number this script could produce from the font's own
tables would be a number nobody measured, which is the thing the catalogue's
header spends four paragraphs warning about.

It also does not check a licence. Nothing can: a font file does not carry a
machine-readable statement of what its owner may do with it, and a name table
saying "OFL" is a string somebody typed. What the product does instead is ask
the person, at upload, and keep their answer — see the upload route.
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

MAX_BYTES = 8 * 1024 * 1024


def fail(code: str, detail: str) -> None:
    print(json.dumps({"ok": False, "code": code, "detail": detail}))
    sys.exit(0)


def slug(text: str) -> str:
    """A family name a fontconfig pattern and a file path can both hold."""
    cleaned = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-")
    return cleaned or "Face"


def coverage(font) -> tuple[int, int]:
    """How many Arabic letters and how many Latin ones this file actually has.

    Counted from the cmap over the base blocks only, before the repair adds the
    presentation forms — otherwise every repaired font would look like it
    covers Arabic because the repair just put 117 codepoints in.
    """
    best = font.getBestCmap()
    arabic = sum(1 for cp in best if 0x0620 <= cp <= 0x064A or 0x0671 <= cp <= 0x06D3)
    latin = sum(1 for cp in best if 0x0041 <= cp <= 0x005A or 0x0061 <= cp <= 0x007A)
    return arabic, latin


def main() -> None:
    if len(sys.argv) < 4:
        fail("usage", "prepare-user-font.py <source> <font-dir> <preview-dir> [--id ID]")
    source = Path(sys.argv[1])
    into = Path(sys.argv[2])
    preview_dir = Path(sys.argv[3])
    face_id = sys.argv[sys.argv.index("--id") + 1] if "--id" in sys.argv else source.stem

    if not source.exists():
        fail("missing", f"{source} is not there")
    size = source.stat().st_size
    if size == 0:
        fail("empty", "the file is zero bytes")
    if size > MAX_BYTES:
        fail("tooLarge", f"{size // 1024}KB, over the {MAX_BYTES // 1024 // 1024}MB ceiling")

    try:
        from fontTools import ttLib
        import facerepair as fr
    except Exception as exc:  # the image is missing a dependency, not the font
        fail("toolingMissing", f"{type(exc).__name__}: {exc}")

    try:
        font = ttLib.TTFont(str(source), fontNumber=0)
    except Exception as exc:
        fail("unreadable", f"{type(exc).__name__}: {exc}")

    if "glyf" not in font and "CFF " not in font and "CFF2" not in font:
        fail("noOutlines", "the file has neither TrueType nor CFF outlines")
    if "cmap" not in font:
        fail("noCmap", "the file maps no characters at all")

    arabic_glyphs, latin_glyphs = coverage(font)
    if arabic_glyphs < 20 and latin_glyphs < 20:
        fail(
            "noLetters",
            f"{arabic_glyphs} Arabic and {latin_glyphs} Latin letters — not a text font",
        )

    declared = fr.family_of(font)
    # Prefixed and suffixed, because the point of the name is to be *ours*. A
    # file calling itself "Rubik" would otherwise be resolved by fontconfig
    # from wherever Rubik already is on the machine, and the render would draw
    # a font the person never uploaded.
    family = f"Editly {slug(declared) if declared else 'Face'} {slug(face_id)[:8]}"

    try:
        fr.to_truetype(font)
        fr.rename(font, family)
        forms, invisible = fr.repair(font)
        fr.stamp(font)
    except Exception as exc:
        fail("cannotRepair", f"{type(exc).__name__}: {exc}")

    into.mkdir(parents=True, exist_ok=True)
    out = into / f"{family.replace(' ', '-')}.ttf"
    try:
        font.save(str(out))
        # Reopened, because a file fontTools can write and not read is a file
        # libass will not read either, and finding that out here is cheaper
        # than finding it out in a render somebody paid minutes for.
        ttLib.TTFont(str(out))
    except Exception as exc:
        fail("cannotWrite", f"{type(exc).__name__}: {exc}")

    preview_dir.mkdir(parents=True, exist_ok=True)
    preview = preview_dir / f"{face_id}.woff2"
    try:
        from fontTools.subset import Subsetter, Options

        web = ttLib.TTFont(str(out))
        options = Options()
        options.flavor = "woff2"
        options.desubroutinize = True
        options.layout_features = ["*"]
        subsetter = Subsetter(options=options)
        subsetter.populate(
            text=(
                "لا أحد يخبرك بهذا لكنه يغير كل شيء ٠١٢٣٤٥٦٧٨٩"
                "NOBODY TELLS YOU THIS nobody tells you this 0123456789.,!?'\"-:;()"
            )
        )
        subsetter.subset(web)
        fr.stamp(web)
        web.flavor = "woff2"
        web.save(str(preview))
    except Exception as exc:
        # A missing preview is a picker that shows a name instead of a sample.
        # That is worse, and it is not a reason to refuse the font.
        preview = None
        print(f"preview failed: {exc}", file=sys.stderr)

    print(json.dumps({
        "ok": True,
        "family": family,
        "declared": declared,
        "file": out.name,
        "preview": preview.name if preview else None,
        "arabicGlyphs": arabic_glyphs,
        "latinGlyphs": latin_glyphs,
        "forms": forms,
        "invisible": invisible,
        "bytes": out.stat().st_size,
    }))


if __name__ == "__main__":
    main()
