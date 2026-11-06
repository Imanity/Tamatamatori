"""Offline registration: Astropy 7.1.1, PyAVM 0.9.9, NumPy 2.3.5, Pillow 12.0.0.

Usage: python scripts/check-deep-sky-images.py SOURCE_DIRECTORY
This checks AVM/TAN-CD transforms and published corners, not original plate solutions.
"""
import hashlib
import json
from pathlib import Path
import sys

import numpy as np
from astropy.wcs import WCS
from PIL import Image
from pyavm import AVM

from deep_sky_image import source_wcs, reference_pixels, diffuse_support

root = Path(__file__).resolve().parents[1]
source_dir = Path(sys.argv[1])
catalog = json.loads((root/"src/data/deep-sky.json").read_text(encoding="utf-8"))
image_bytes = (root/"src/data/deep-sky-atlas.png").read_bytes()
digest = hashlib.sha256(image_bytes).hexdigest()
assert digest == catalog["atlas"]["sha256"]
atlas = np.asarray(Image.open(root/"src/data/deep-sky-atlas.png"))
result = {"reference": "PyAVM 0.9.9 for AVM; Astropy 7.1.1 / WCSLIB for AVM/TAN-CD transforms and published corner residuals",
          "scope": "Coordinate transformation, corner fit and raster checks; not an independent source plate solve or photometry calibration",
          "atlasSha256": digest, "records": []}
result["supportChecks"] = []
for model in ("reflection", "emission", "mixed", "galaxy"):
    synthetic = np.zeros((160, 160, 3))
    colour = [0.01, 0.05, 0.2] if model in ("reflection", "mixed") else [0.2, 0.05, 0.01]
    synthetic[40:120, 40:120] = colour
    synthetic[78:82, 120:140] = colour  # Connected narrow filament.
    synthetic[71:89, 71:89] = 0.8  # White core inside genuine cloud.
    synthetic[15:18, 15:18] = colour  # Isolated compact colour source.
    support, stats = diffuse_support(synthetic, model)
    assert support[80, 80] > 0.99, "White cores must not punch holes"
    assert support[80, 130] > 0.99, "Connected filaments must survive"
    assert support[16, 16] == 0, "Compact exterior sources must fade"
    assert np.all(np.isfinite(support)) and support.min() >= 0 and support.max() <= 1
    result["supportChecks"].append({"model": model, "whiteCore": float(support[80, 80]),
        "connectedFilament": float(support[80, 130]), "exteriorPoint": float(support[16, 16]),
        "scope": "synthetic display support only, not GPU or source photometry"})
synthetic = np.zeros((300, 360, 3))
synthetic[70:150, 40:120] = [0.2, 0.05, 0.01]
synthetic[30:90, 90:150] = [0.01, 0.05, 0.2]
synthetic[100:105, 120:190] = [0.2, 0.05, 0.01]
synthetic[230:255, 280:305] = [0.2, 0.05, 0.01]
seed = np.zeros((300, 360), dtype=bool)
seed[80:120, 80:120] = True
support, stats = diffuse_support(synthetic, "mixed", seed)
assert support[50, 120] > 0.99, "Connected blue reflection must survive beyond the seed"
assert support[102, 170] > 0.99, "Connected red filament must survive beyond the seed"
assert support[242, 292] == 0, "Detached broad exterior star-field islands must fade"
result["supportChecks"].append({"model": "catalogue-seeded-mixed", "blueBeyondSeed": float(support[50, 120]),
    "redFilamentBeyondSeed": float(support[102, 170]), "detachedIsland": float(support[242, 292]),
    "scope": "Synthetic connected support, not source astrometry or GPU validation"})
for spec in catalog["imageSources"]:
    raw = (source_dir/spec["file"]).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == spec["sha256"]
    m = source_wcs(spec, raw)
    assert m == spec["wcs"]
    # Pass only spatial fields: the M42 XMP has an empty Spatial.Notes value
    # rejected by PyAVM, unrelated to its coordinate solution.
    if spec.get("registrationModel", "avm") == "avm":
        avm = AVM()
        for key, value in m.items():
            setattr(avm.Spatial, key, value)
        reference = avm.to_wcs()
    else:
        reference = WCS(naxis=2)
        reference.wcs.ctype = ["RA---TAN", "DEC--TAN"]
        reference.wcs.crpix = m["ReferencePixel"]
        reference.wcs.crval = m["ReferenceValue"]
        reference.wcs.cd = m["CDMatrix"]
    obj = next(o for o in catalog["objects"] if o["catalogId"] == spec["catalogId"])
    tx, ty, width, height = obj["atlasRect"]
    x0, y0, x1, y1 = obj["bounds"]
    dx, dy = (x1-x0)/(width-1), (y1-y0)/(height-1)
    target = WCS(naxis=2)
    target.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    target.wcs.crpix = [1-x0/dx, 1+y1/dy]
    target.wcs.crval = [obj["ra"], obj["dec"]]
    target.wcs.cdelt = np.degrees([dx, -dy])
    rw, rh = m["ReferenceDimension"]
    quad_error = None
    if spec.get("registrationModel") == "stellarium-sky-corners":
        corners = np.array(spec["skyCorners"])
        edge_pixels = np.array([[0.5, 0.5], [rw+0.5, 0.5], [rw+0.5, rh+0.5], [0.5, rh+0.5]])
        quad_error = float(np.linalg.norm(reference.all_world2pix(corners, 1)-edge_pixels, axis=1).max())
        assert quad_error < spec.get("cornerTolerancePixels", 0.5), "Published quad and source pixel axes must agree within the fixed source-specific bound"
    else:
        corners = reference.all_pix2world([[1, 1], [rw, 1], [rw, rh], [1, rh]], 1)
    projected_corners = target.all_world2pix(corners, 0)
    assert np.all(projected_corners > 0) and np.all(projected_corners < [width-1, height-1]), "The complete source footprint must fit; no inscribed crop"
    # Include the reference point and all atlas regions, even outside the photo.
    mesh = np.array([[x, y] for y in np.linspace(0, height-1, 5) for x in np.linspace(0, width-1, 5)])
    world = target.all_pix2world(mesh, 0)
    ra, dec = np.radians(world).T
    rays = np.array([np.cos(dec)*np.cos(ra), np.cos(dec)*np.sin(ra), np.sin(dec)]).T
    expected = reference.all_world2pix(world, 1)
    actual = reference_pixels(rays, m)
    error = float(np.max(np.abs(expected-actual)))
    assert error < 1e-7, (spec["file"], error)
    texture = root/"src/data/deep-sky"/obj["texture"]["file"]
    assert hashlib.sha256(texture.read_bytes()).hexdigest() == obj["texture"]["sha256"]
    tile = np.asarray(Image.open(texture))
    if obj["model"] in ("galaxy", "reflection"):
        assert np.all(tile[..., 3] == 255), "Galaxy/reflection data must not acquire an additive red increment"
    else:
        assert np.any(tile[..., 3] < 255)
    border = np.concatenate([tile[0], tile[-1], tile[:, 0], tile[:, -1]])
    assert border[:, :3].max() == 0 and np.all(border[:, 3] == 255), "Neighbouring atlas targets must not bleed"
    result["records"].append({"catalogId": spec["catalogId"], "sourceSha256": spec["sha256"],
        "registrationModel": spec.get("registrationModel", "avm"),
        "publishedCornerMaxPixelError": quad_error,
        "wcs": m, "sampleCount": len(mesh), "maxReferencePixelError": error,
        "atlasRect": obj["atlasRect"],
        "textureSha256": obj["texture"]["sha256"],
        "cornerTolerancePixels": spec.get("cornerTolerancePixels", 0.5),
        "zeroAtlasBorder": True, "fullSourceFootprintContained": True,
        "samples": [{"atlasPixel": p.tolist(), "icrsDegrees": q.tolist(), "sourceReferencePixel": r.tolist()}
                    for p, q, r in zip(mesh, world, expected)]})
path = root/"tests/fixtures/deep-sky-image-registration.json"
path.write_text(json.dumps(result, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
print(json.dumps({"atlasSha256": digest, "WCSLIB": [{"id": r["catalogId"], "samples": r["sampleCount"], "maxPixelError": r["maxReferencePixelError"]} for r in result["records"]]}))
