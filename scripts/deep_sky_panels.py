"""Prepare the eight pinned cloud panels as two TAN image references.

NumPy/Pillow only. Published sky quads constrain a projective display mapping,
not an original plate solution. Source RGB is sampled without invented detail.
"""
import hashlib
import json
from pathlib import Path
import sys

import numpy as np
from PIL import Image, ImageFilter, PngImagePlugin

from deep_sky_image import basis


def quad_matrix(corners, ra, dec):
    a, d = np.radians(corners).T
    rays = np.column_stack([np.cos(d)*np.cos(a), np.cos(d)*np.sin(a), np.sin(d)])
    center, east, north = basis(ra, dec)
    xy = np.column_stack([rays @ east, rays @ north])/(rays @ center)[:, None]
    equations, values = [], []
    for (u, v), (x, y) in zip([[0, 0], [1, 0], [1, 1], [0, 1]], xy):
        equations.extend([[u, v, 1, 0, 0, 0, -u*x, -v*x],
                          [0, 0, 0, u, v, 1, -u*y, -v*y]])
        values.extend([x, y])
    matrix = np.append(np.linalg.solve(equations, values), 1).reshape(3, 3)
    return matrix, xy


def prepare(source_dir, spec):
    ra, dec = spec["target"]["ra"], spec["target"]["dec"]
    panels = []
    for panel in spec["panels"]:
        path = source_dir/panel["file"]
        if hashlib.sha256(path.read_bytes()).hexdigest() != panel["sha256"]:
            raise ValueError(f"Panel changed: {path.name}")
        image = Image.open(path).convert("RGB")
        if list(image.size) != panel["dimensions"]:
            raise ValueError(f"Panel dimensions changed: {path.name}")
        matrix, xy = quad_matrix(panel["skyCorners"], ra, dec)
        panels.append((np.asarray(image, dtype=float)/255, matrix, xy))
    corners = np.concatenate([p[2] for p in panels])
    low, high = corners.min(axis=0), corners.max(axis=0)
    pad = (high-low)*0.03
    low, high = low-pad, high+pad
    width, height = spec["dimensions"]
    x, y = np.meshgrid(np.linspace(low[0], high[0], width),
                       np.linspace(high[1], low[1], height))
    target = np.stack([x, y, np.ones_like(x)], axis=-1)
    total = np.zeros((height, width, 3))
    weights = np.zeros((height, width))
    for image, matrix, _ in panels:
        projected = target @ np.linalg.inv(matrix).T
        u, v = (projected[..., :2]/projected[..., 2:]).transpose(2, 0, 1)
        h, w, _ = image.shape
        # A quarter input pixel accommodates rounding of adjoining sky corners.
        tolerance = 0.25/min(w, h)
        valid = (u >= -tolerance) & (u <= 1+tolerance) & (v >= -tolerance) & (v <= 1+tolerance)
        u, v = np.clip(u, 0, 1), np.clip(v, 0, 1)
        px, py = u*(w-1), (1-v)*(h-1)
        x0, y0 = np.floor(px).astype(int), np.floor(py).astype(int)
        x1, y1 = np.minimum(x0+1, w-1), np.minimum(y0+1, h-1)
        fx, fy = (px-x0)[..., None], (py-y0)[..., None]
        rgb = ((1-fx)*image[y0, x0]+fx*image[y0, x1])*(1-fy)+((1-fx)*image[y1, x0]+fx*image[y1, x1])*fy
        weight = np.maximum(np.minimum.reduce([u, 1-u, v, 1-v]), tolerance)*valid
        total += rgb*weight[..., None]
        weights += weight
    rgb = total/np.maximum(weights[..., None], 1e-12)
    # Fade only the exterior of the combined coverage. Internal tile edges
    # remain covered, so they receive no rectangular feathering or dark seam.
    support = Image.fromarray(np.uint8(weights > 0)*255)
    fade = np.zeros((height, width))
    for _ in range(8):
        fade += np.asarray(support, dtype=float)/255/8
        support = support.filter(ImageFilter.MinFilter(3))
    fade = fade*fade*(3-2*fade)
    rgb *= fade[..., None]
    dx, dy = (high-low)/[width-1, height-1]
    wcs = {
        "ReferenceDimension": [float(width), float(height)],
        "ReferencePixel": [float(1-low[0]/dx), float(1-low[1]/dy)],
        "ReferenceValue": [ra, dec],
        "CDMatrix": [[float(np.degrees(dx)), 0], [0, float(np.degrees(dy))]],
        "CoordinateFrame": "ICRS", "Equinox": "J2000", "CoordsystemProjection": "TAN",
        "Quality": "Derived TAN mosaic of published sky quads using projective interpolation; not an original plate solution",
    }
    fingerprint = hashlib.sha256(json.dumps(spec["panels"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    info = PngImagePlugin.PngInfo()
    info.add_text("tamatamatori_registration", json.dumps({"version": 1, "panelFingerprint": fingerprint, "wcs": wcs}, separators=(",", ":")))
    path = source_dir/spec["file"]
    Image.fromarray(np.uint8(np.clip(rgb, 0, 1)*255+0.5)).save(path, pnginfo=info, optimize=True)
    spec["wcs"] = wcs
    spec["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    spec["bytes"] = path.stat().st_size
    return {"catalogId": spec["catalogId"], "file": path.name, "sha256": spec["sha256"],
            "panelFingerprint": fingerprint, "coveredFraction": float(np.mean(weights > 0))}


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    path = root/"scripts/deep-sky-image-sources.json"
    sources = json.loads(path.read_text(encoding="utf-8"))
    for spec in sources:
        if spec.get("registrationModel") == "published-quad-mosaic":
            print(json.dumps(prepare(Path(sys.argv[1]), spec)))
    path.write_text(json.dumps(sources, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
