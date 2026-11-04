"""Optional fixture regeneration with pyproj==3.7.2; not a CI/app dependency.

Run from the repository root. PROJ is independent of the TypeScript reference.
All heights below are synthetic WGS84 ellipsoidal heights, not surveyed DEM.
"""
import json
from pathlib import Path

import pyproj
from pyproj import Geod, Transformer

if pyproj.__version__ != "3.7.2":
    raise RuntimeError("Use pyproj==3.7.2 for reproducible fixtures")

geod = Geod(ellps="WGS84")
ecef = Transformer.from_crs("EPSG:4979", "EPSG:4978", always_xy=True)


def point(lat, lon, h):
    return dict(latitude=lat, longitude=lon, ellipsoidalHeight=h)


def xyz(p):
    return p["longitude"], p["latitude"], p["ellipsoidalHeight"]


def fixture(name, eye, target):
    pipeline = (
        "+proj=pipeline +step +proj=cart +ellps=WGS84 "
        "+step +proj=topocentric +ellps=WGS84 "
        f'+lat_0={eye["latitude"]} +lon_0={eye["longitude"]} +h_0={eye["ellipsoidalHeight"]}'
    )
    enu = Transformer.from_pipeline(pipeline).transform(*xyz(target))
    return dict(name=name, eye=eye, target=target, enu=enu, ecef=ecef.transform(*xyz(target)))


cases = []
eye = point(35.4172, 138.8729, 1000)
for distance in (1000, 10000, 100000):
    lon, lat, _ = geod.fwd(eye["longitude"], eye["latitude"], 247, distance)
    cases.append(fixture(f"same-height-{distance}m", eye, point(lat, lon, 1000)))
cases += [
    fixture("fuji-conditional-heights", point(35.4172, 138.8729, 982.1), point(35.36083333333333, 138.7275, 3756.8253984306566)),
    fixture("antimeridian", point(35, 179.9, 10), point(35.02, -179.9, 210)),
    fixture("high-latitude", point(85, 30, 100), point(85.05, 31, 100)),
    fixture("southern-hemisphere", point(-43, 172, -20), point(-43.3, 172.5, 1500)),
    fixture("vertical", eye, point(eye["latitude"], eye["longitude"], 1010)),
    # Official PROJ example defaults to GRS80. Explicit WGS84 has the same
    # published millimetre-rounded answer; retain full independent values here.
    fixture("proj-documentation", point(55, 5, 200), point(53.80939444, 2.12955, 73)),
]
document = dict(
    generator=f"pyproj {pyproj.__version__} / PROJ {pyproj.proj_version_str}",
    source="https://proj.org/en/stable/operations/conversions/topocentric.html",
    convention="WGS84 geographic degrees; ellipsoidal heights and ECEF/ENU in metres; ENU origin at eye; no refraction",
    cases=cases,
    mapSurfaceBearing=fixture("fuji-map-surface-direction", point(35.4172, 138.8729, 0), point(35.36083333333333, 138.7275, 0)),
)
Path("tests/fixtures/geodetic-reference.json").write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
