"""Fixed RGB-increment audit; display-model checks, not camera calibration.

Run in the existing NumPy/Pillow data-preparation environment. The runtime tint
is separately checked by the Node tests using the exported shader constant.
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

root = Path(__file__).resolve().parents[1]
catalog = json.loads((root/"src/data/deep-sky.json").read_text(encoding="utf-8"))
raw = (root/"src/data/deep-sky-atlas.png").read_bytes()
digest = hashlib.sha256(raw).hexdigest()
assert digest == catalog["atlas"]["sha256"]
target_mode = "--targets" in sys.argv
atlas = None if target_mode else np.asarray(Image.open(root/"src/data/deep-sky-atlas.png"), dtype=float)/255
result = {"checkedOn": "2026-11-06", "atlasSha256": digest,
    "scope": "Packed display-signal colour ratios before opacity/compositing, not spectral flux or camera colour accuracy",
    "oldIncrementRgb": [1, 0.1, 0.18], "correctedIncrementRgb": [1, 0, 0],
    "minimumPeak": 0.02, "minimumExtra": 0.004, "records": []}
legacy_ids = {s["catalogId"] for s in catalog["atlas"]["detailStatistics"]}
objects = catalog["objects"] if target_mode else [obj for obj in catalog["objects"] if obj["catalogId"] in legacy_ids]
for obj in objects:
    if target_mode:
        path = root/"src/data/deep-sky"/obj["texture"]["file"]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == obj["texture"]["sha256"]
        tile = np.asarray(Image.open(path), dtype=float)/255
    else:
        x, y, w, h = obj["atlasRect"]
        tile = atlas[y:y+h, x:x+w]
    rgb, extra = tile[..., :3], 1-tile[..., 3]
    contrast_maximum = None
    if obj["model"] == "dark":
        contrast_maximum = float(extra.max())
        extra = np.maximum(rgb[..., 0]-(rgb[..., 1]+rgb[..., 2])*0.5, 0)*0.6
    mask = (rgb.max(axis=-1) > result["minimumPeak"]) & (extra > result["minimumExtra"])
    base_fraction = rgb[..., 0]/np.maximum(rgb.sum(axis=-1), 1e-9)
    record = {"catalogId": obj["catalogId"], "source": next(s["page"] for s in catalog["imageSources"] if s["catalogId"] == obj["catalogId"]),
        "enhancedPixels": int(mask.sum()), "extraMaximum": float(extra.max()),
        "backgroundContrastMaximum": contrast_maximum}
    for label, tint in [("old", result["oldIncrementRgb"]), ("corrected", result["correctedIncrementRgb"])]:
        signal = rgb+extra[..., None]*tint
        fraction = signal[..., 0]/np.maximum(signal.sum(axis=-1), 1e-9)
        drop = np.where(mask, base_fraction-fraction, 0)
        record[label] = {"redFractionLoweredPixels": int(np.count_nonzero(mask & (drop > 1e-6))),
            "maximumRedFractionDrop": float(max(0, drop.max()))}
    assert record["corrected"]["redFractionLoweredPixels"] == 0
    if obj["model"] in ("galaxy", "reflection"):
        assert extra.max() == 0
    result["records"].append(record)
directory = "deep-sky-next-four-evidence" if target_mode else "deep-sky-colour-evidence"
path = root/"docs/plan"/directory/"pixel-audit.json"
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(result, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
print(json.dumps({"atlasSha256": digest, "records": result["records"]}, ensure_ascii=False))
