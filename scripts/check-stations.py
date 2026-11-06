"""Offline SGP4 C++ / ERFA reference. Run with sgp4, pyerfa and NumPy installed."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path

import erfa
import numpy as np
import sgp4
from sgp4 import omm
from sgp4.api import Satrec, jday, accelerated

root = Path(__file__).resolve().parents[1]
source = root / "docs/plan/stations-evidence/seed-snapshot.json"
elements = json.loads(source.read_text(encoding="utf-8"))["objects"]
rows = []
locations = [(35.4172, 138.8729, 982), (-33.45, -70.67, 800), (89.9, 179.99, 1.6), (0, -179.99, -20)]
for element in elements:
    satellite = Satrec()
    omm.initialize(satellite, {**element, "CENTER_NAME": "EARTH", "REF_FRAME": "TEME", "TIME_SYSTEM": "UTC", "MEAN_ELEMENT_THEORY": "SGP4"})
    for instant in ["2026-11-05T00:00:00Z", "2026-11-06T00:00:00Z", "2026-11-06T12:34:56Z", "2026-11-07T23:59:50Z"]:
        date = datetime.fromisoformat(instant.replace("Z", "+00:00"))
        jd, fraction = jday(date.year, date.month, date.day, date.hour, date.minute, date.second)
        error, position, _ = satellite.sgp4(jd, fraction)
        assert error == 0
        theta = erfa.gmst82(jd, fraction)
        c, s = np.cos(theta), np.sin(theta)
        ecf = np.array([[c, s, 0], [-s, c, 0], [0, 0, 1]]) @ position
        lon, lat, height = erfa.gc2gd(1, ecf * 1000)
        for latitude, longitude, altitude in locations:
            phi, lam = np.radians([latitude, longitude])
            eye = erfa.gd2gc(1, lam, phi, altitude) / 1000
            east = np.array([-np.sin(lam), np.cos(lam), 0])
            north = np.array([-np.sin(phi) * np.cos(lam), -np.sin(phi) * np.sin(lam), np.cos(phi)])
            up = np.array([np.cos(phi) * np.cos(lam), np.cos(phi) * np.sin(lam), np.sin(phi)])
            enu = np.array([east, north, up]) @ (ecf - eye)
            distance = np.linalg.norm(enu)
            rows.append({"noradId": element["NORAD_CAT_ID"], "instant": instant,
                         "observer": {"latitude": latitude, "longitude": longitude, "altitude": altitude},
                         "direction": (enu / distance).tolist(), "rangeKm": float(distance),
                         "subpoint": {"latitude": float(np.degrees(lat)), "longitude": float(np.degrees(lon)), "heightKm": float(height / 1000)}})
result = {"reference": f"python-sgp4 {sgp4.__version__} C++ accelerated={accelerated}; ERFA {erfa.__version__} GMST82 and WGS84",
          "conventions": "TEME to PEF using GMST82 with UT1=UTC; polar motion omitted; full input epoch precision",
          "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(), "elements": elements, "rows": rows}
output = root / "tests/fixtures/stations-reference.json"
output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Wrote {len(rows)} independent station positions")
