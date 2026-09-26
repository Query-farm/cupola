"""Build the static Noto Sans cuts Typst uses for PDF export.

Typst reads neither WOFF2 nor variable axes, so the variable sources from google/fonts are
instanced at the weights the template uses and subset to Latin (with Vietnamese), Greek,
Cyrillic, and the punctuation, currency, arrows and symbols reports contain. OpenType layout
features are all kept: tabular figures (on by default in Noto Sans), `zero`, `onum`, `frac`,
`smcp`. The full variable font is 2 MB; each cut here is a fraction of that.

    uv run --with fonttools --with brotli python scripts/make-pdf-fonts.py
"""
import io
import urllib.request
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

FONTS = Path(__file__).resolve().parent.parent / "public" / "typst" / "fonts"
SOURCE = "https://raw.githubusercontent.com/google/fonts/main/ofl/notosans/"
UPRIGHT = "NotoSans%5Bwdth,wght%5D.ttf"
ITALIC = "NotoSans-Italic%5Bwdth,wght%5D.ttf"
CUTS = [("Regular", UPRIGHT, 400), ("SemiBold", UPRIGHT, 600), ("Bold", UPRIGHT, 700), ("Italic", ITALIC, 400), ("BoldItalic", ITALIC, 700)]
UNICODES = [
    (0x0020, 0x024F),  # Basic Latin, Latin-1, Latin Extended-A and -B
    (0x0250, 0x02FF),  # IPA extensions, spacing modifiers
    (0x0300, 0x036F),  # Combining diacritics
    (0x0370, 0x03FF),  # Greek
    (0x0400, 0x052F),  # Cyrillic and Cyrillic Supplement
    (0x1E00, 0x1FFF),  # Latin Extended Additional (Vietnamese), Greek Extended
    (0x2000, 0x206F),  # General punctuation
    (0x2070, 0x209F),  # Superscripts and subscripts
    (0x20A0, 0x20CF),  # Currency
    (0x2100, 0x218F),  # Letterlike symbols, number forms
    (0x2190, 0x22FF),  # Arrows, mathematical operators
    (0x2500, 0x25FF),  # Box drawing, block elements, geometric shapes
    (0xFB00, 0xFB06),  # Latin ligatures
]


def fetch(name: str) -> bytes:
    with urllib.request.urlopen(SOURCE + name) as response:
        return response.read()


def main() -> None:
    sources = {name: fetch(name) for name in {UPRIGHT, ITALIC}}
    options = subset.Options()
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.notdef_outline = True
    options.glyph_names = False
    unicodes = [code for start, end in UNICODES for code in range(start, end + 1)]
    for cut, source, weight in CUTS:
        font = TTFont(io.BytesIO(sources[source]))
        font = instancer.instantiateVariableFont(font, {"wght": weight, "wdth": 100}, updateFontNames=True)
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=unicodes)
        subsetter.subset(font)
        out = FONTS / f"NotoSans-{cut}.ttf"
        font.save(out)
        names = font["name"]
        print(f"{out.name}: {out.stat().st_size // 1024} KB, {len(font.getGlyphOrder())} glyphs, "
              f"family {names.getDebugName(16) or names.getDebugName(1)!r} / {names.getDebugName(17) or names.getDebugName(2)!r}")
    licence = urllib.request.urlopen(SOURCE + "OFL.txt").read()
    (FONTS / "OFL-notosans.txt").write_bytes(licence)


main()
