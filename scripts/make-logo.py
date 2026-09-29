"""Create the square OnePhone mark for the hackathon submission."""

from pathlib import Path

from PIL import Image, ImageDraw


SIZE = 1024
SCALE = 3
OUT = Path(__file__).resolve().parents[1] / "docs" / "onephone-logo.png"

image = Image.new("RGB", (SIZE * SCALE, SIZE * SCALE), "#111827")
draw = ImageDraw.Draw(image)


def box(coords: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    return tuple(value * SCALE for value in coords)


draw.rounded_rectangle(box((36, 36, 988, 988)), radius=220 * SCALE, fill="#182335")
draw.ellipse(box((192, 192, 832, 832)), outline="#31425E", width=18 * SCALE)
draw.rounded_rectangle(
    box((348, 226, 676, 798)),
    radius=70 * SCALE,
    fill="#202E42",
    outline="#58E6CA",
    width=26 * SCALE,
)
draw.rounded_rectangle(box((444, 259, 580, 276)), radius=8 * SCALE, fill="#58E6CA")
draw.polygon(
    [(x * SCALE, y * SCALE) for x, y in ((441, 404), (495, 355), (529, 355), (529, 389), (462, 436))],
    fill="#FFFFFF",
)
draw.rounded_rectangle(box((495, 355, 529, 620)), radius=17 * SCALE, fill="#FFFFFF")
draw.rounded_rectangle(box((450, 594, 574, 626)), radius=16 * SCALE, fill="#FFFFFF")
draw.ellipse(box((490, 717, 534, 761)), fill="#58E6CA")

OUT.parent.mkdir(parents=True, exist_ok=True)
image.resize((SIZE, SIZE), Image.Resampling.LANCZOS).save(OUT, optimize=True)
print(OUT)
