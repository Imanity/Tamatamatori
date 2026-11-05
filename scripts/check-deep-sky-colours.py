"""Fixed RGB-increment audit; display-model checks, not camera calibration.

Run in the existing NumPy/Pillow data-preparation environment. The runtime tint
is separately checked by the Node tests using the exported shader constant.
"""
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image

root = Path(__file__).resolve().parents[1]
catalog = json.loads((root/"src/data/deep-sky.json").read_text(encoding="utf-8"))
raw = (root/"src/data/deep-sky-atlas.png").read_bytes()
digest = hashlib.sha256(raw).hexdigest()
assert digest == catalog["atlas"]["sha256"]
atlas = np.asarray(Image.open(root/"src/data/deep-sky-atlas.png"), dtype=float)/255
result = {"checkedOn": "2026-11-06", "atlasSha256": digest,
    "scope": "Packed display-signal colour ratios before opacity/compositing, not spectral flux or camera colour accuracy",
    "oldIncrementRgb": [1, 0.1, 0.18], "correctedIncrementRgb": [1, 0, 0],
    "minimumPeak": 0.02, "minimumExtra": 0.004, "records": []}
for obj in catalog["objects"]:
    x, y, w, h = obj["atlasRect"]
    tile = atlas[y:y+h, x:x+w]
    rgb, extra = tile[..., :3], 1-tile[..., 3]
    mask = (rgb.max(axis=-1) > result["minimumPeak"]) & (extra > result["minimumExtra"])
    base_fraction = rgb[..., 0]/np.maximum(rgb.sum(axis=-1), 1e-9)
    record = {"catalogId": obj["catalogId"], "source": next(s["page"] for s in catalog["imageSources"] if s["catalogId"] == obj["catalogId"]),
        "enhancedPixels": int(mask.sum()), "extraMaximum": float(extra.max())}
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
path = root/"docs/plan/deep-sky-colour-evidence/pixel-audit.json"
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(result, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
print(json.dumps({"atlasSha256": digest, "records": result["records"]}, ensure_ascii=False))
