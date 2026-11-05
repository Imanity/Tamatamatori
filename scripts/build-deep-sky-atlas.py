"""Build qualitative component masks from OpenNGC contours (CC BY-SA 4.0).

Manual data preparation: Pillow==12.0.0, numpy==2.3.5.
Run node scripts/build-deep-sky.mjs first, then pass a source-image directory.
The two verified CC BY 4.0 images supply structure; components stay qualitative.
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from deep_sky_image import image_components

root = Path(__file__).resolve().parents[1]
path = root / "src/data/deep-sky.json"
catalog = json.loads(path.read_text(encoding="utf-8"))
hyg = {f"hyg-{row[0]}": row for row in json.loads((root / "src/data/bright-stars.json").read_text(encoding="utf-8"))["stars"]}
sources = json.loads((root / "scripts/deep-sky-image-sources.json").read_text(encoding="utf-8"))
if len(sys.argv) != 2:
    raise SystemExit("Usage: python scripts/build-deep-sky-atlas.py SOURCE_DIRECTORY")
source_dir = Path(sys.argv[1])
size = 512
tile_size = 1024
atlas = Image.new("RGB", (4096, 2048))
detail_stats = []


def tangent(points, obj):
    a, d = np.radians(np.array(points).T)
    a0, d0 = np.radians([obj["ra"], obj["dec"]])
    z = np.sin(d0)*np.sin(d)+np.cos(d0)*np.cos(d)*np.cos(a-a0)
    return np.array([np.cos(d)*np.sin(a-a0)/z, (np.cos(d0)*np.sin(d)-np.sin(d0)*np.cos(d)*np.cos(a-a0))/z]).T


for obj in catalog["objects"]:
    x0, y0, x1, y1 = obj["bounds"]
    x, y = np.meshgrid(np.linspace(x0, x1, size), np.linspace(y1, y0, size))
    if obj["outlines"]:
        levels = []
        for level in [1, 2, 3]:
            image = Image.new("L", (size, size))
            draw = ImageDraw.Draw(image)
            for ring in obj["outlines"]:
                if ring["level"] != level:
                    continue
                xy = tangent(ring["points"], obj)
                pixels = [((a-x0)/(x1-x0)*(size-1), (y1-b)/(y1-y0)*(size-1)) for a, b in xy]
                draw.polygon(pixels, fill=255)
            levels.append(np.asarray(image.filter(ImageFilter.GaussianBlur([16, 14, 10][level-1])), dtype=float)/255)
        low, middle, high = levels
        sx = np.tan(np.radians(obj["majorArcmin"]/120))
        sy = np.tan(np.radians(obj["minorArcmin"]/120))
        # Smooth illustrative falloff around the catalogue centre; no invented
        # fine cloud texture or claim of calibrated isophotal brightness.
        falloff = 0.25+0.75*np.exp(-0.5*((x/max(sx, 0.001))**2+(y/max(sy, 0.001))**2))
        cloud = np.clip(low*0.16+middle*0.36+high*0.55, 0, 1)*falloff
        high = high*falloff
        if obj["model"] == "mixed":
            continuum = cloud*0.08+high*0.23
            hydrogen = cloud*0.9
            other = middle*0.08+high*0.42
        else:
            continuum, hydrogen, other = cloud*0.07, cloud*0.95, cloud*0.025
    elif obj["model"] == "galaxy":
        pa = np.radians(obj["positionAngle"])
        major = np.tan(np.radians(obj["majorArcmin"]/120))
        minor = np.tan(np.radians(obj["minorArcmin"]/120))
        u = (x*np.sin(pa)+y*np.cos(pa))/major
        v = (x*np.cos(pa)-y*np.sin(pa))/minor
        r = np.hypot(u, v)
        edge = np.clip((1-r)/0.18, 0, 1)
        continuum = (np.exp(-r*2.3)*0.65+np.exp(-r*18)*0.8)*edge
        hydrogen, other = np.zeros_like(x), np.zeros_like(x)
    else:
        scale = np.tan(np.radians(obj["majorArcmin"]/120))
        continuum = np.exp(-(np.hypot(x,y)/scale)**2*5)*0.09
        for star_id in obj["starIds"]:
            row = hyg[star_id]
            sx, sy = tangent([[row[1]*15, row[2]]], obj)[0]
            continuum += np.exp(-((x-sx)**2+(y-sy)**2)/(scale*0.17)**2)*0.24
        hydrogen, other = np.zeros_like(x), np.zeros_like(x)
    components = np.stack([continuum, hydrogen, other], axis=2)
    # Preserve the other six first-step masks at their original angular scale.
    components = np.stack([np.asarray(Image.fromarray(channel.astype(np.float32)).resize((tile_size, tile_size), Image.Resampling.BILINEAR)) for channel in components.transpose(2, 0, 1)], axis=-1)
    spec = next((source for source in sources if source["catalogId"] == obj["catalogId"]), None)
    if spec:
        detailed, fade, stats = image_components(source_dir, spec, obj, tile_size)
        # Source footprints are smaller than the catalogue's outer contours.
        # Add reference structure over a faint contour envelope; replacing the
        # envelope would cut a rectangular dark hole at the photographic edge.
        components = components*0.16+detailed*fade[..., None]
        detail_stats.append(stats)
    components = np.uint8(np.clip(components, 0, 1)*255+0.5)
    obj["componentMax"] = [int(value) for value in components.max(axis=(0, 1))]
    tile = Image.fromarray(components)
    atlas.paste(tile, ((obj["tile"] % 4)*tile_size, (obj["tile"]//4)*tile_size))

output = root / "src/data/deep-sky-atlas.png"
atlas.save(output, optimize=True)
catalog["atlas"]["sha256"] = hashlib.sha256(output.read_bytes()).hexdigest()
catalog["atlas"].update(width=4096, height=2048, tileSize=tile_size,
    channels="R continuum; G qualitative H-alpha; B qualitative other emission. OpenNGC masks plus registered M31/M42 image structure; not spectral fluxes.",
    detailStatistics=detail_stats)
catalog["imageSources"] = sources
path.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":"))+"\n", encoding="utf-8")
print(f"{output.name}: {output.stat().st_size} bytes; {catalog['atlas']['sha256']}")
