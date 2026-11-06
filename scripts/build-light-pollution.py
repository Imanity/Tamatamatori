"""Prepare World Atlas 2015 static tiles. Manual tooling, outside build/CI.

Requires numpy 2.3.5 and tifffile 2026.10.15. Input is the original GeoTIFF.
Source and CC BY-NC 4.0 terms: https://doi.org/10.5880/GFZ.1.4.2016.001
Usage: python scripts/build-light-pollution.py INPUT.tif
"""

import gzip
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import tifffile

SOURCE_SHA = "9725566ed4fcf1a8fa311654143bb024c4fe2a792b85356be99adce07e1e83c1"
ARCHIVE_SHA = "9c6a624427463c40717efbca7696e3c6bb0f332c26d1b039e7a91e0dbc831fbf"
root = Path(__file__).resolve().parents[1]
source = Path(sys.argv[1])
digest = hashlib.sha256()
with source.open("rb") as stream:
    for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
        digest.update(block)
if digest.hexdigest() != SOURCE_SHA:
    raise ValueError("World Atlas source checksum does not match")

with tifffile.TiffFile(source) as tiff:
    page = tiff.pages[0]
    scale = page.tags["ModelPixelScaleTag"].value
    tiepoint = page.tags["ModelTiepointTag"].value
    if page.shape != (17406, 43200) or page.dtype != np.dtype("float32"):
        raise ValueError("Unexpected source raster dimensions or type")
    if page.compression != 1 or (page.tilewidth, page.tilelength) != (128, 128):
        raise ValueError("Expected uncompressed 128-pixel source tiles")
    offsets = np.asarray(page.dataoffsets, dtype=np.int64)
    if not np.all(np.diff(offsets) == 128 * 128 * 4):
        raise ValueError("Source tile storage is not contiguous")
    if not np.all(np.asarray(page.databytecounts) == 128 * 128 * 4):
        raise ValueError("Unexpected source tile byte counts")
    if tiff.geotiff_metadata["GeographicTypeGeoKey"] != 4326:
        raise ValueError("Source needs geographic WGS84 coordinates")
    source_height, source_width = page.shape
    storage = np.memmap(source, dtype="<f4", mode="r", offset=int(offsets[0]),
                        shape=(136, 338, 128, 128))

    def window(x, y, width, height):
        tx, ty = x // 128, y // 128
        right, bottom = (x + width + 127) // 128, (y + height + 127) // 128
        section = storage[ty:bottom, tx:right].transpose(0, 2, 1, 3)
        assembled = section.reshape((bottom - ty) * 128, (right - tx) * 128)
        return assembled[y % 128:y % 128 + height, x % 128:x % 128 + width]

    # The TIFF includes zero padding north of the published 75 N limit.
    # Start on a native row whose first pixel centre is at 75 N, then average
    # 3x3 native samples in linear luminance. Keep the original grid registration.
    crop_row = 1206
    width, height = source_width // 3, (source_height - crop_row) // 3
    raster_north = tiepoint[4] - crop_row * scale[1]
    pixel_size = scale[0] * 3
    tile_size = 800
    directory = root / "public/light-pollution/atlas-2015"
    directory.mkdir(parents=True, exist_ok=True)
    tiles = []
    maximum = 0.0
    missing = 0
    encoded = np.zeros((height, width), dtype=np.uint8)
    for y in range(0, height, tile_size):
        for x in range(0, width, tile_size):
            w, h = min(tile_size, width - x), min(tile_size, height - y)
            native = window(x * 3, crop_row + y * 3, w * 3, h * 3)
            blocks = native.reshape(h, 3, w, 3)
            valid = np.all(np.isfinite(blocks) & (blocks >= 0), axis=(1, 3))
            mean = np.where(valid, blocks.mean(axis=(1, 3), dtype=np.float64), 0)
            maximum = max(maximum, float(mean.max()))
            code = 1 + np.rint(16 * np.log1p(mean / 0.001))
            if code.max() > 255:
                raise ValueError("Luminance exceeds the encoded range")
            code = np.where(valid, code, 0).astype(np.uint8)
            missing += int(np.count_nonzero(~valid))
            encoded[y:y+h, x:x+w] = code
            # Opaque .bin avoids static hosts treating the gzip payload as
            # HTTP Content-Encoding and the browser decompressing it first.
            filename = f"{x // tile_size}-{y // tile_size}.bin"
            payload = gzip.compress(code.tobytes(), compresslevel=9, mtime=0)
            (directory / filename).write_bytes(payload)
            tiles.append({"x": x // tile_size, "y": y // tile_size, "file": filename,
                          "width": w, "height": h, "bytes": len(payload),
                          "sha256": hashlib.sha256(payload).hexdigest()})

    metadata = {
        "id": "world-atlas-2015-v1.1-3x3-log8", "year": 2015,
        "source": "https://doi.org/10.5880/GFZ.1.4.2016.001",
        "paper": "https://doi.org/10.1126/sciadv.1600377",
        "download": "https://datapub.gfz-potsdam.de/download/10.5880.GFZ.1.4.2016.001/World_Atlas_2015.zip",
        "credit": "Fabio Falchi, Pierantonio Cinzano, Dan Duriscoe, Christopher C. M. Kyba, Christopher D. Elvidge, Kimberly Baugh, Boris Portnov, Nataliya A. Rybnikova, Riccardo Furgoni / ISTIL / GFZ Data Services",
        "license": "CC BY-NC 4.0", "licenseUrl": "https://creativecommons.org/licenses/by-nc/4.0/",
        "sourceSha256": SOURCE_SHA, "archiveSha256": ARCHIVE_SHA,
        "directory": "light-pollution/atlas-2015/", "width": width, "height": height,
        "tileSize": tile_size, "pixelSize": pixel_size, "rasterNorth": raster_north,
        "west": tiepoint[3], "east": tiepoint[3] + source_width * scale[0],
        "north": 75, "south": tiepoint[4] - source_height * scale[1],
        "encoding": {"unitMcd": 0.001, "scale": 16, "nodata": 0, "compression": "gzip"},
        "nativeGrid": {"width": source_width, "height": source_height,
                       "pixelScale": list(scale), "tiepoint": list(tiepoint), "cropRow": crop_row},
        "modifications": "Crop zero padding above published 75 N coverage, average valid native 3x3 samples in linear mcd/m², preserve missing pixels, encode 1+round(16*ln(1+L/0.001)) with 0 reserved for missing, split into up-to-800x800 gzip tiles. Runtime bilinear interpolation in decoded luminance. Native TIFF longitude rounding leaves its east edge about 16 m west of 180 degrees.",
        "limitation": "Historical 2015 model of artificial zenith luminance, no natural sky component, real-time lighting, Bortle class, directional light domes or exposure calibration. Derived grid is about 2.8 km north-south. Quantisation relative error is below exp(1/32)-1 for L+0.001.",
        "maximumMcd": maximum, "missingCells": missing, "tiles": tiles,
    }
    (root / "src/data/light-pollution.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # Fixed source-derived samples for the separate JS coordinate/decoder tests.
    fixtures = []
    for name, lat, lon in [("东京",35.6762,139.6503),("山中湖",35.4172,138.8729),
                           ("纽约",40.7128,-74.006),("巴黎",48.8566,2.3522),
                           ("纳米布",-24.5,15),("撒哈拉",23,10),("太平洋",0,-150),
                           ("日期变更线",20,179.999),("北界",75,0)]:
        gx=(lon-tiepoint[3])/pixel_size-0.5
        gy=max(0,min(height-1,(raster_north-lat)/pixel_size-0.5))
        left,top=int(np.floor(gx)),int(np.floor(gy))
        fx,fy=gx-left,gy-top
        cells=[]
        for xx,yy,weight in [(left,top,(1-fx)*(1-fy)),(left+1,top,fx*(1-fy)),
                              (left, min(top+1,height-1),(1-fx)*fy),
                              (left+1,min(top+1,height-1),fx*fy)]:
            if weight <= 0: continue
            xx %= width
            raw=window(xx*3,crop_row+yy*3,3,3)
            value=float(raw.mean(dtype=np.float64)) if np.all(np.isfinite(raw)&(raw>=0)) else None
            code=int(encoded[yy,xx])
            decoded=0.001*np.expm1((code-1)/16) if code else None
            if value is not None:
                assert abs((decoded+0.001)/(value+0.001)-1) <= np.expm1(1/32)+1e-12
            cells.append({"x":xx,"y":yy,"weight":weight,"sourceMeanMcd":value,"code":code,"decodedMcd":decoded})
        result=None if any(cell["decodedMcd"] is None for cell in cells) else sum(cell["decodedMcd"]*cell["weight"] for cell in cells)
        fixtures.append({"name":name,"latitude":lat,"longitude":lon,"cells":cells,"artificialMcd":result})
    evidence=root/"tests/fixtures/light-pollution-reference.json"
    evidence.write_text(json.dumps({"sourceSha256":SOURCE_SHA,"samples":fixtures},ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"tiles":len(tiles),"bytes":sum(t["bytes"] for t in tiles),"width":width,"height":height,"maximumMcd":maximum,"missingCells":missing,"samples":[(f["name"],f["artificialMcd"]) for f in fixtures]},ensure_ascii=False))
