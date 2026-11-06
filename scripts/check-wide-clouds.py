"""Independent WCSLIB/SVD checks for the two published-quad mosaics.

The SVD fit is independent of the preparation script's eight-equation solve.
This verifies interpolation and sampling, not original plate-solve accuracy.
"""
import hashlib
import json
from pathlib import Path
import sys

import numpy as np
from astropy.wcs import WCS
from PIL import Image

from deep_sky_panels import quad_matrix


def svd_homography(corners):
    center = corners.mean(axis=0)
    scale = np.std(corners, axis=0)
    normalized = (corners-center)/scale
    rows = []
    for (u, v), (x, y) in zip([[0, 0], [1, 0], [1, 1], [0, 1]], normalized):
        rows.extend([[-u, -v, -1, 0, 0, 0, u*x, v*x, x],
                     [0, 0, 0, -u, -v, -1, u*y, v*y, y]])
    _, _, vectors = np.linalg.svd(rows)
    fitted = vectors[-1].reshape(3, 3)
    return np.array([[scale[0], 0, center[0]], [0, scale[1], center[1]], [0, 0, 1]]) @ fitted


def check(source_dir, spec):
    wcs = spec["wcs"]
    reference = WCS(naxis=2)
    reference.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    reference.wcs.crpix = wcs["ReferencePixel"]
    reference.wcs.crval = wcs["ReferenceValue"]
    reference.wcs.cd = wcs["CDMatrix"]
    mosaic = np.asarray(Image.open(source_dir/spec["file"]))
    mesh = np.array([[u, v, 1] for v in np.linspace(0.1, 0.9, 5) for u in np.linspace(0.1, 0.9, 5)])
    records = []
    for panel in spec["panels"]:
        path = source_dir/panel["file"]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == panel["sha256"]
        corners = reference.all_world2pix(panel["skyCorners"], 1)
        independent = svd_homography(corners)
        pixels = mesh @ independent.T
        pixels = pixels[:, :2]/pixels[:, 2:]
        matrix, _ = quad_matrix(panel["skyCorners"], *wcs["ReferenceValue"])
        plane = mesh @ matrix.T
        plane = plane[:, :2]/plane[:, 2:]
        # FITS TAN plane coordinates are in degrees, with 1-based source pixels.
        actual = np.degrees(plane) @ np.linalg.inv(wcs["CDMatrix"]).T+wcs["ReferencePixel"]
        error = float(np.max(np.abs(actual-pixels)))
        assert error < 1e-7, (panel["file"], error)
        corner_pixels = np.array([[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]) @ independent.T
        corner_error = float(np.max(np.abs(corner_pixels[:, :2]/corner_pixels[:, 2:]-corners)))
        assert corner_error < 1e-7
        # Compare retained samples away from overlap and exterior transitions.
        source = np.asarray(Image.open(path), dtype=float)
        matches = 0
        inverse = np.linalg.inv(independent)
        for pixel in pixels:
            px, py = np.rint(pixel).astype(int)
            uv = inverse @ [px, py, 1]
            u, v = uv[:2]/uv[2]
            h, w, _ = source.shape
            x, y = u*(w-1), (1-v)*(h-1)
            x0, y0 = np.floor([x, y]).astype(int)
            x1, y1 = min(x0+1, w-1), min(y0+1, h-1)
            fx, fy = x-x0, y-y0
            expected = ((1-fx)*source[y0, x0]+fx*source[y0, x1])*(1-fy)+((1-fx)*source[y1, x0]+fx*source[y1, x1])*fy
            actual_rgb = mosaic[mosaic.shape[0]-py, px-1]
            if np.max(np.abs(expected-actual_rgb)) <= 1.01:
                matches += 1
        assert matches >= 20, (panel["file"], matches)
        records.append({"file": panel["file"], "sha256": panel["sha256"],
                        "nativeDimensions": panel["dimensions"], "sampleCount": len(mesh),
                        "maximumMosaicPixelError": error, "maximumCornerPixelError": corner_error,
                        "retainedRgbSamples": matches})
    return {"catalogId": spec["catalogId"], "mosaicSha256": spec["sha256"], "records": records}


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    sources = json.loads((root/"scripts/deep-sky-image-sources.json").read_text(encoding="utf-8"))
    result = {
        "reference": "Independent Astropy/WCSLIB plus normalized SVD homographies",
        "scope": "Published-quad interpolation and source sampling, not original plate accuracy",
        "records": [check(Path(sys.argv[1]), spec) for spec in sources
                    if spec.get("registrationModel") == "published-quad-mosaic"],
    }
    (root/"tests/fixtures/wide-cloud-registration.json").write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
    print(json.dumps(result))
