"""Independent no-refraction reference: pyerfa==2.0.1.5, numpy==2.3.5."""
import json
from pathlib import Path
from datetime import datetime
import erfa
import numpy as np

root=Path(__file__).resolve().parents[1]
catalog=json.loads((root/'src/data/deep-sky.json').read_text(encoding='utf-8'))
records=[]
for lat,lon,instant in [(35.4172,138.8729,'2026-11-08T16:00:00Z'),(-33.8688,151.2093,'2026-07-15T15:00:00Z'),(0,179.9,'2000-01-01T12:00:00Z'),(64,-21,'2099-01-01T00:00:00Z')]:
    date=datetime.fromisoformat(instant.replace('Z','+00:00'))
    t1,t2=erfa.dtf2d('UTC',date.year,date.month,date.day,date.hour,date.minute,float(date.second))
    for obj in catalog['objects']:
        a,z,*_=erfa.atco13(np.radians(obj['ra']),np.radians(obj['dec']),0.,0.,0.,0.,t1,t2,0.,np.radians(lon),np.radians(lat),0.,0.,0.,0.,10.,0.,0.55)
        records.append(dict(latitude=lat,longitude=lon,instant=instant,id=obj['id'],azimuth=float(np.degrees(a)%360),elevation=float(90-np.degrees(z))))
output=dict(source='ERFA atco13; fixed OpenNGC ICRS/J2000 coordinates; zero PM/parallax/radial velocity, DUT1=0, polar motion=0, pressure=0, observer ellipsoidal height=0.',records=records)
(root/'tests/fixtures/deep-sky-reference.json').write_text(json.dumps(output,indent=2)+'\n',encoding='utf-8')
print(f'{len(records)} independent ERFA directions')
