"""Offline registration: Astropy 7.1.1, PyAVM 0.9.9, NumPy 2.3.5, Pillow 12.0.0.

Usage: python scripts/check-deep-sky-images.py SOURCE_DIRECTORY
This checks the AVM implementation against WCSLIB, not the original plate solution.
"""
import hashlib
import json
from pathlib import Path
import sys

import numpy as np
from astropy.wcs import WCS
from PIL import Image
from pyavm import AVM

from deep_sky_image import read_avm, reference_pixels

root = Path(__file__).resolve().parents[1]
source_dir = Path(sys.argv[1])
catalog = json.loads((root/"src/data/deep-sky.json").read_text(encoding="utf-8"))
image_bytes = (root/"src/data/deep-sky-atlas.png").read_bytes()
digest = hashlib.sha256(image_bytes).hexdigest()
assert digest == catalog["atlas"]["sha256"]
atlas = np.asarray(Image.open(root/"src/data/deep-sky-atlas.png"))
size = catalog["atlas"]["tileSize"]
result = {"reference": "PyAVM 0.9.9 + Astropy 7.1.1 / WCSLIB, independent of the NumPy AVM/TAN implementation",
          "scope": "AVM transformation and raster checks, not source astrometry/photometry calibration",
          "atlasSha256": digest, "records": []}
for spec in catalog["imageSources"]:
    raw = (source_dir/spec["file"]).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == spec["sha256"]
    m = read_avm(raw)
    assert m == spec["wcs"]
    # Pass only spatial fields: the M42 XMP has an empty Spatial.Notes value
    # rejected by PyAVM, unrelated to its coordinate solution.
    avm = AVM()
    for key, value in m.items():
        setattr(avm.Spatial, key, value)
    reference = avm.to_wcs()
    obj = next(o for o in catalog["objects"] if o["catalogId"] == spec["catalogId"])
    x0, y0, x1, y1 = obj["bounds"]
    dx, dy = (x1-x0)/(size-1), (y1-y0)/(size-1)
    target = WCS(naxis=2)
    target.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    target.wcs.crpix = [1-x0/dx, 1+y1/dy]
    target.wcs.crval = [obj["ra"], obj["dec"]]
    target.wcs.cdelt = np.degrees([dx, -dy])
    rw, rh = m["ReferenceDimension"]
    corners = reference.all_pix2world([[1, 1], [rw, 1], [rw, rh], [1, rh]], 1)
    projected_corners = target.all_world2pix(corners, 0)
    assert np.all(projected_corners > 0) and np.all(projected_corners < size-1), "The complete source footprint must fit; no inscribed crop"
    # Include the reference point and all atlas regions, even outside the photo.
    mesh = np.array([[x, y] for y in np.linspace(0, size-1, 5) for x in np.linspace(0, size-1, 5)])
    world = target.all_pix2world(mesh, 0)
    ra, dec = np.radians(world).T
    rays = np.array([np.cos(dec)*np.cos(ra), np.cos(dec)*np.sin(ra), np.sin(dec)]).T
    expected = reference.all_world2pix(world, 1)
    actual = reference_pixels(rays, m)
    error = float(np.max(np.abs(expected-actual)))
    assert error < 1e-7, (spec["file"], error)
    tx, ty = (obj["tile"] % 4)*size, (obj["tile"]//4)*size
    tile = atlas[ty:ty+size, tx:tx+size]
    if obj["model"] == "galaxy":
        assert np.all(tile[..., 3] == 255), "M31 must not acquire an additive red increment"
    else:
        assert np.any(tile[..., 3] < 255)
    border = np.concatenate([tile[0], tile[-1], tile[:, 0], tile[:, -1]])
    assert border[:, :3].max() == 0 and np.all(border[:, 3] == 255), "Neighbouring atlas targets must not bleed"
    result["records"].append({"catalogId": spec["catalogId"], "sourceSha256": spec["sha256"],
        "wcs": m, "sampleCount": len(mesh), "maxReferencePixelError": error,
        "zeroAtlasBorder": True, "fullSourceFootprintContained": True,
        "samples": [{"atlasPixel": p.tolist(), "icrsDegrees": q.tolist(), "sourceReferencePixel": r.tolist()}
                    for p, q, r in zip(mesh, world, expected)]})
path = root/"tests/fixtures/deep-sky-image-registration.json"
path.write_text(json.dumps(result, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
print(json.dumps({"atlasSha256": digest, "WCSLIB": [{"id": r["catalogId"], "samples": r["sampleCount"], "maxPixelError": r["maxReferencePixelError"]} for r in result["records"]]}))
