#!/usr/bin/env python3
"""Inline the Vite dist build into one self-contained preview HTML file.

Reads dist/index.html, replaces the <script src="/assets/..."> and
<link href="/assets/...css"> tags with the file contents inlined, and
writes preview.html. Uses re.sub with a function replacement
so backslashes in the bundle are never interpreted as escapes.
Asserts there are zero real src="/assets/ or href="/assets/ references
left in the output.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
OUT = ROOT / "preview.html"


def inline_js(m: re.Match) -> str:
    src = m.group(1)
    js = (DIST / src.lstrip("/")).read_text(encoding="utf-8")
    js = js.replace("</script", "<\\/script")
    return '<script type="module">\n' + js + "\n</script>"


def inline_css(m: re.Match) -> str:
    href = m.group(1)
    css = (DIST / href.lstrip("/")).read_text(encoding="utf-8")
    css = css.replace("</style", "<\\/style")
    return "<style>\n" + css + "\n</style>"


def main() -> int:
    html = (DIST / "index.html").read_text(encoding="utf-8")
    html = re.sub(
        r'<script[^>]*\ssrc="([^"]+)"[^>]*>\s*</script>', inline_js, html
    )
    html = re.sub(
        r'<link[^>]*\shref="([^"]+\.css)"[^>]*>', inline_css, html
    )
    assert 'src="/assets/' not in html, "real JS asset ref remains"
    assert 'href="/assets/' not in html, "real CSS asset ref remains"
    OUT.write_text(html, encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
