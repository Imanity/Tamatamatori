"""Build a diffuse Galactic atlas from ESO0932a (ESO/S. Brunier, CC BY 4.0).

Manual data preparation only; runtime/build/CI do not require Python.
Requires Pillow==12.0.0. Usage: python scripts/build-milky-way.py INPUT.jpg
Source: https://cdn.eso.org/images/large/eso0932a.jpg
"""

import hashlib
import json
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter

SOURCE_SHA = "60400c92c54b7c1bd12299c69e83b16e5b6256e7dabacc478c021758ecd28179"
root = Path(__file__).resolve().parents[1]
source = Path(sys.argv[1])
if hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE_SHA:
    raise ValueError("ESO source checksum does not match the validated image")
image = Image.open(source).convert("RGB")
if image.size != (6000, 3000):
    raise ValueError("Expected the 6000 x 3000 ESO Galactic panorama")

# Plate carree: l=0 at x=3000, positive l to the left; north at the top.
# Keep b=+22.5..-22.5 only. Median removes bright photographic stars before
# downsampling; the remaining unresolved stellar light forms the Milky Way.
image = image.crop((0, 1125, 6000, 1875)).resize((4096, 512), Image.Resampling.LANCZOS)
image = image.filter(ImageFilter.MedianFilter(5))
# Suppress larger stellar/planetary halos without blurring all dust structure.
ceiling = image.filter(ImageFilter.MedianFilter(11)).point(lambda value: min(255, round(value * 1.6 + 4)))
image = ImageChops.darker(image, ceiling).filter(ImageFilter.GaussianBlur(0.55))
image = ImageChops.subtract(image, Image.new("RGB", image.size, (12, 12, 14)))

# Blend the two borders over 16 pixels. Longitude repeats without a visible
# brightness jump, preserving all structure outside the seam around l=180.
pixels = image.load()
for y in range(image.height):
    left, right = pixels[0, y], pixels[image.width - 1, y]
    mean = tuple(round((a + b) / 2) for a, b in zip(left, right))
    for x in range(16):
        weight = x / 16
        for edge in (x, image.width - 1 - x):
            pixels[edge, y] = tuple(round(a * weight + b * (1 - weight)) for a, b in zip(pixels[edge, y], mean))

output = root / "src/data/milky-way.webp"
image.save(output, "WEBP", quality=88, method=6)
metadata = {
    "source": "https://www.eso.org/public/images/eso0932a/",
    "download": "https://cdn.eso.org/images/large/eso0932a.jpg",
    "credit": "ESO/S. Brunier",
    "license": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "sourceSha256": SOURCE_SHA,
    "outputSha256": hashlib.sha256(output.read_bytes()).hexdigest(),
    "width": 4096,
    "height": 512,
    "coordinates": "Galactic plate carree; l=0 at u=0.5, longitude increases left; b=+22.5 at v=0, b=-22.5 at v=1",
    "modifications": "Crop Galactic latitude +/-22.5 deg, Lanczos resize, 5x5 median star suppression, cap channels at 1.6*11x11 median+4 to suppress halos, 0.55px Gaussian, subtract RGB(12,12,14), blend 16px longitude seam, WebP quality 88. No AI processing.",
    "limitation": "Photographic panorama, not an astrometric/photometric map. Residual photographic stars are possible; no target positions are derived from this texture.",
}
(root / "src/data/milky-way.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"{output.name}: {output.stat().st_size} bytes; SHA256 {metadata['outputSha256']}")
