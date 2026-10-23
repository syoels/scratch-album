#!/usr/bin/env python3
"""Make web-sized copies of the photos in imgs/ and write photos.json.

Run from the repo root:   python tools/build_photos.py
Needs Pillow:             pip install pillow

- Originals in imgs/ are never modified.
- Web copies go to photos/ (short edge 1440px, JPEG q82, EXIF/GPS stripped,
  rotation baked in).
- Copies whose original no longer exists are removed.
"""
import json
import sys
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("Pillow is missing. Install it with:  pip install pillow")

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "imgs"
OUT = ROOT / "photos"
SHORT_EDGE = 1440
QUALITY = 82
EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic"}


def web_name(p: Path) -> str:
    # keep it URL-friendly: letters, digits, dash, underscore
    stem = "".join(c if c.isalnum() or c in "-_" else "_" for c in p.stem)
    return stem + ".jpg"


def main():
    OUT.mkdir(exist_ok=True)
    sources = sorted(p for p in SRC.iterdir() if p.suffix.lower() in EXTS)
    names = []
    for src in sources:
        name = web_name(src)
        dst = OUT / name
        names.append(name)
        if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
            continue
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            w, h = im.size
            scale = SHORT_EDGE / min(w, h)
            if scale < 1:
                im = im.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
            im.save(dst, "JPEG", quality=QUALITY, optimize=True, progressive=True)
        print(f"  {src.name} -> photos/{name} ({dst.stat().st_size // 1024} KB)")

    for old in OUT.glob("*.jpg"):
        if old.name not in names:
            old.unlink()
            print(f"  removed stale photos/{old.name}")

    (ROOT / "photos.json").write_text(json.dumps(names, indent=1), encoding="utf-8")
    print(f"photos.json: {len(names)} photos")


if __name__ == "__main__":
    main()
