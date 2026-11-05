"""Manual reference generation only: pyerfa==2.0.1.5; not an app/CI dependency.
ERFA atco13 independently computes ICRS -> observed place (pressure/DUT1/polar
motion zero). JPL Horizons supplies airless Venus/Jupiter observer directions.
"""
import json
import math
import warnings
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen
import erfa

root = Path(__file__).resolve().parent.parent
catalog = json.loads((root / "src/data/bright-stars.json").read_text(encoding="utf-8"))
names = catalog["names"]
sites = [(35.4172, 138.8729), (-33.8688, 151.2093)]
dates = [(2000, 1, 1, 12), (2026, 7, 1, 13), (2099, 1, 1, 0)]
records = []
for year, month, day, hour in dates:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # Future UTC uses ERFA's last known leap second.
        utc1, utc2 = erfa.dtf2d("UTC", year, month, day, hour, 0, 0)
        stars = []
        for id, ra, dec, dist, vx, vy, vz, mag, ci in catalog["stars"]:
            if names.get(f"hyg-{id}") not in ["北极星", "牛郎星", "织女星", "天狼星", "大角星"]:
                continue
            r, d = math.radians(ra*15), math.radians(dec)
            u = [math.cos(d)*math.cos(r), math.cos(d)*math.sin(r), math.sin(d)]
            east, north = [-math.sin(r), math.cos(r), 0], [-math.sin(d)*math.cos(r), -math.sin(d)*math.sin(r), math.cos(d)]
            dot = lambda a,b: sum(x*y for x,y in zip(a,b))
            velocity = [vx,vy,vz]
            pr, pd = dot(velocity,east)/dist/math.cos(d), dot(velocity,north)/dist
            rv = dot(velocity,u)*3.0856775814913673e13/(365.25*86400)
            stars.append((f"hyg-{id}",r,d,pr,pd,1/dist,rv))
        stars.append(("galactic-center", math.radians((17+45/60+40.034047/3600)*15), math.radians(-29-28.21601/3600), 0,0,0,0))
        # Three independent ERFA ICRS directions for the Galactic equator.
        for l in [0, 90, 180]:
            r,d=erfa.g2icrs(math.radians(l),0)
            stars.append((f"galactic-{l}",r,d,0,0,0,0))
        for lat, lon in sites:
            for id,r,d,pr,pd,px,rv in stars:
                az,zd,*_=erfa.atco13(r,d,pr,pd,px,rv,utc1,utc2,0,math.radians(lon),math.radians(lat),0,0,0,0,10,0,0.55)
                records.append(dict(id=id,latitude=lat,longitude=lon,instant=f"{year:04}-{month:02}-{day:02}T{hour:02}:00:00Z",azimuth=math.degrees(az),elevation=90-math.degrees(zd)))

planets=[]
for body,id in [(299,"venus"),(599,"jupiter")]:
    for lat,lon in sites:
        args=dict(format="json",COMMAND=str(body),OBJ_DATA="NO",MAKE_EPHEM="YES",EPHEM_TYPE="OBSERVER",CENTER="coord@399",COORD_TYPE="GEODETIC",SITE_COORD=f"'{lon},{lat},0'",START_TIME="'2026-07-01 13:00'",STOP_TIME="'2026-07-01 13:01'",STEP_SIZE="'1 m'",QUANTITIES="'4'",APPARENT="AIRLESS",CSV_FORMAT="YES",TIME_DIGITS="SECONDS",EXTRA_PREC="YES")
        url="https://ssd.jpl.nasa.gov/api/horizons.api?"+urlencode(args)
        with urlopen(url,timeout=60) as response:
            result=json.load(response)["result"]
        row=result.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines()[0].split(",")
        planets.append(dict(id=id,latitude=lat,longitude=lon,instant="2026-07-01T13:00:00Z",azimuth=float(row[3]),elevation=float(row[4]),url=url))

fixture=dict(source="PyERFA 2.0.1.5 / ERFA atco13 and g2icrs; JPL Horizons",erfaUrl="https://github.com/liberfa/erfa/blob/master/src/atco13.c",conventions="ICRS J2000, zero observer height / pressure / DUT1 / polar motion; fixed Sgr A* direction; future leap seconds not predicted",records=records,planets=planets)
(root / "tests/fixtures/starfield-reference.json").write_text(json.dumps(fixture,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
print(f"Reference: {len(records)} ERFA directions; {len(planets)} JPL directions")
