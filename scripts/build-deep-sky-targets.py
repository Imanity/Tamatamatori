"""Build the twelve actually used per-target textures; no runtime mega-atlas.

Run the catalogue + legacy-atlas builders first. Old eight tiles are extracted
without changing a byte; four new references use the same verified pipeline.
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from deep_sky_image import image_bounds, image_components

root = Path(__file__).resolve().parents[1]
path = root/"src/data/deep-sky.json"
catalog = json.loads(path.read_text(encoding="utf-8"))
source_dir = Path(sys.argv[1])
sources = json.loads((root/"scripts/deep-sky-image-sources.json").read_text(encoding="utf-8"))
legacy = Image.open(root/"src/data/deep-sky-atlas.png")
assert hashlib.sha256((root/"src/data/deep-sky-atlas.png").read_bytes()).hexdigest() == catalog["atlas"]["sha256"]
output = root/"src/data/deep-sky"
output.mkdir(exist_ok=True)
sizes = {"NGC6514": 2048, "NGC0598": 2048, "NGC2237": 1024, "IC0434": 1024}
stats = list(catalog["atlas"]["detailStatistics"])
for obj in catalog["objects"]:
    cid = obj["catalogId"]
    if cid in sizes:
        spec = next(s for s in sources if s["catalogId"] == cid)
        obj["bounds"] = image_bounds(spec, obj)
        size = sizes[cid]
        data, detail = image_components(source_dir, spec, obj, size)
        data[..., 3] = 1-data[..., 3]
        tile = Image.fromarray(np.uint8(np.clip(data, 0, 1)*255+0.5))
        obj["atlasRect"] = [0, 0, size, size]  # Local texture coordinates.
        obj["redEnhancementMax"] = None if obj["model"] == "dark" else int(255-np.asarray(tile)[..., 3].min())
        obj["componentMax"] = np.asarray(tile).max(axis=(0, 1)).astype(int).tolist()
        stats.append(detail)
    else:
        x, y, w, h = obj["atlasRect"]
        tile = legacy.crop((x, y, x+w, y+h))
    file = output/(cid.lower()+".png")
    tile.save(file, optimize=True)
    obj["texture"] = {"file": file.name, "width": tile.width, "height": tile.height,
        "sha256": hashlib.sha256(file.read_bytes()).hexdigest(), "bytes": file.stat().st_size,
        "license": "CC-BY-SA-4.0", "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0/",
        "alphaData": "1 - background contrast opacity" if obj["model"] == "dark" else "1 - additive red increment"}
    print(cid, tile.size, file.stat().st_size)
catalog["textureStatistics"] = stats
catalog["textureBudgetBytes"] = 64*1024*1024
catalog["imageSources"] = sources
path.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":"))+"\n", encoding="utf-8")
