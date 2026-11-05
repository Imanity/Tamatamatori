"""Build qualitative component masks from OpenNGC contours (CC BY-SA 4.0).

Manual data preparation: Pillow==12.0.0, numpy==2.3.5.
Run node scripts/build-deep-sky.mjs first, then pass a source-image directory.
Verified CC BY 4.0 images supply structure; components stay qualitative.
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from deep_sky_image import image_components, image_bounds

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
atlas = Image.new("RGBA", (4096, 4096), (0, 0, 0, 255))
# Fixed eight-object layout; preserve the five existing photographic rasters.
regions = {
    "NGC0224": [0, 2048, 1024, 1024],
    "NGC1976": [1024, 2048, 1024, 1024],
    "Mel022": [2048, 0, 2048, 1024],
    "NGC6523": [2048, 1024, 2048, 1024],
    "NGC7000": [0, 0, 2048, 2048],
    "NGC1499": [2048, 2048, 2048, 2048],
    "IC1805": [0, 3072, 1024, 1024],
    "IC1848": [1024, 3072, 1024, 1024],
}
detail_stats = []


def tangent(points, obj):
    a, d = np.radians(np.array(points).T)
    a0, d0 = np.radians([obj["ra"], obj["dec"]])
    z = np.sin(d0)*np.sin(d)+np.cos(d0)*np.cos(d)*np.cos(a-a0)
    return np.array([np.cos(d)*np.sin(a-a0)/z, (np.cos(d0)*np.sin(d)-np.sin(d0)*np.cos(d)*np.cos(a-a0))/z]).T


for obj in catalog["objects"]:
    tx, ty, width, height = regions[obj["catalogId"]]
    obj["atlasRect"] = [tx, ty, width, height]
    spec = next((source for source in sources if source["catalogId"] == obj["catalogId"]), None)
    if spec:
        obj["bounds"] = image_bounds(spec, obj)
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
    # Preserve remaining catalogue masks at their original angular scale.
    components = np.stack([np.asarray(Image.fromarray(channel.astype(np.float32)).resize((tile_size, tile_size), Image.Resampling.BILINEAR)) for channel in components.transpose(2, 0, 1)], axis=-1)
    if spec:
        components, stats = image_components(source_dir, spec, obj, width, height)
        detail_stats.append(stats)
    else:
        # Preserve remaining targets' stock/modified display through an
        # equivalent RGB base + increment representation.
        c, ha, other = components.transpose(2, 0, 1)
        tint = np.array([0.36, 0.64, 1]) if obj["model"] == "reflection" else np.array([0.65, 0.76, 1])
        rgb = c[..., None]*tint+ha[..., None]*0.25*np.array([1, 0.10, 0.18])+other[..., None]*np.array([0.12, 0.75, 0.85])
        components = np.concatenate([rgb, (ha*0.75)[..., None]], axis=-1)
    obj["redEnhancementMax"] = int(np.clip(components[..., 3].max(), 0, 1)*255+0.5)
    # Inverse packing keeps no-enhancement RGB fully opaque in PNG decoders;
    # alpha is data, never the final on-screen opacity.
    components[..., 3] = 1-components[..., 3]
    components = np.uint8(np.clip(components, 0, 1)*255+0.5)
    obj["componentMax"] = [int(value) for value in components.max(axis=(0, 1))]
    tile = Image.fromarray(components)
    atlas.paste(tile, (tx, ty))

output = root / "src/data/deep-sky-atlas.png"
atlas.save(output, optimize=True)
catalog["atlas"]["sha256"] = hashlib.sha256(output.read_bytes()).hexdigest()
catalog["atlas"].pop("tileSize", None)
catalog["atlas"].update(width=4096, height=4096,
    layout="Fixed per-object atlasRect in pixels; pixel centres define UVs",
    channels="RGB baseline colour; A = 1 - additive red enhancement. Alpha is packed data, not display opacity. Not spectral fluxes.",
    detailStatistics=detail_stats)
catalog["imageSources"] = sources
path.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":"))+"\n", encoding="utf-8")
print(f"{output.name}: {output.stat().st_size} bytes; {catalog['atlas']['sha256']}")
