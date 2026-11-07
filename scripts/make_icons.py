#!/usr/bin/env python3
"""Draw the app icons into public/icons/: a small choropleth, green to red.

    python3 scripts/make_icons.py      (needs Pillow: pip install pillow)
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
BG = (18, 52, 59)
RAMP = [(26, 150, 65), (166, 217, 106), (255, 255, 191), (253, 174, 97), (215, 25, 28)]


def draw(size: int, safe: float) -> Image.Image:
    """safe: fraction of the canvas the motif may use (maskable icons need padding)."""
    s = size * 4  # draw large, then downsample for smooth edges
    img = Image.new("RGB", (s, s), BG)
    d = ImageDraw.Draw(img)
    inner = s * safe
    off = (s - inner) / 2
    gap = inner * 0.06
    cell = (inner - 2 * gap) / 3
    r = cell * 0.22
    for row in range(3):
        for col in range(3):
            x = off + col * (cell + gap)
            y = off + row * (cell + gap)
            colour = RAMP[min(4, (2 - row) + col)]  # cheap bottom-left, dear top-right
            d.rounded_rectangle([x, y, x + cell, y + cell], radius=r, fill=colour)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    draw(512, 0.72).save(OUT / "icon-512.png")
    draw(192, 0.72).save(OUT / "icon-192.png")
    draw(512, 0.56).save(OUT / "icon-512-maskable.png")
    draw(180, 0.70).save(OUT / "apple-touch-icon.png")
    draw(32, 0.86).save(OUT / "favicon-32.png")
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
