"""Extract the IMO working list of visual meteor showers. Manual tooling, outside build/CI.

Requires pypdf 7.0.0 (isolated environment). Inputs are the original PDFs:
  IMO Meteor Shower Calendar 2026 (IMO INFO(3-25)), https://www.imo.net/files/meteor-shower/cal2026.pdf
  Moorhead et al. 2019, Meteor shower forecasting in near-Earth space, https://arxiv.org/pdf/1904.06370
Usage: python scripts/build-meteor-showers.py cal2026.pdf 1904.06370.pdf

Table 5 gives activity, maximum, radiant, V∞, r and ZHR. Table 6 gives radiant
positions every five days; its columns are reused by several showers through the
year and are labelled above or below, so each column run is identified by
matching it against the Table 5 radiant at maximum instead of reading labels.
Activity profile shapes (growth/decay exponents) come from Moorhead et al. 2019
Table 5, where a decay exponent printed as 0.00 means a symmetric profile (both
exponents are listed in Moorhead, Cooke & Campbell-Brown 2017, Table 3).
"""

import hashlib
import json
import math
import re
import sys
from pathlib import Path

from pypdf import PdfReader

IMO_SHA = "fde5388889ebda9fe13436d793da5e9935ae46b99edf20e0b19f7fe32ce1ed9f"
MEO_SHA = "8df129390c41df5bdefd54f8979ec18afc7ce94090316ca94a6d7a2609fe4fa1"
root = Path(__file__).resolve().parents[1]
MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()

# Simplified Chinese names (this project's translation of the IMO/IAU names).
NAMES = {
    "ANT": "反日点源", "QUA": "象限仪座流星雨", "GUM": "小熊座γ流星雨", "ACE": "半人马座α流星雨",
    "LYR": "天琴座流星雨", "PPU": "船尾座π流星雨", "ETA": "宝瓶座η流星雨", "ELY": "天琴座η流星雨",
    "ARI": "白天白羊座流星雨", "JBO": "六月牧夫座流星雨", "JPE": "七月飞马座流星雨",
    "GDR": "七月天龙座γ流星雨", "SDA": "南宝瓶座δ流星雨", "CAP": "摩羯座α流星雨",
    "ERI": "波江座η流星雨", "PER": "英仙座流星雨", "KCG": "天鹅座κ流星雨", "AUR": "御夫座流星雨",
    "SPE": "九月英仙座ε流星雨", "SLY": "九月天猫座流星雨", "DSX": "白天六分仪座流星雨",
    "OCT": "十月鹿豹座流星雨", "DRA": "天龙座流星雨", "EGE": "双子座ε流星雨", "ORI": "猎户座流星雨",
    "LMI": "小狮座流星雨", "STA": "南金牛座流星雨", "NTA": "北金牛座流星雨", "LEO": "狮子座流星雨",
    "AMO": "麒麟座α流星雨", "NOO": "十一月猎户座流星雨", "PHO": "凤凰座流星雨",
    "PUP": "船尾-船帆座流星雨", "MON": "麒麟座流星雨", "HYD": "长蛇座σ流星雨", "GEM": "双子座流星雨",
    "COM": "后发座流星雨", "URS": "小熊座流星雨",
}
# Moorhead et al. 2019 codes that differ from the IMO codes; July Phoenicids (PHE) are not the IMO PHO.
MEO_CODES = {"PUV": "PUP"}


def checked(path, expected):
    digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    if digest != expected:
        raise ValueError(f"{path}: SHA-256 {digest} does not match {expected}")
    return digest


def fragments(page):
    items = []

    def visit(text, cm, tm, font, size):
        if text.strip():
            items.append((round(tm[4] * cm[1] + tm[5] * cm[3] + cm[5], 1), round(tm[4] * cm[0] + tm[5] * cm[2] + cm[4], 1), text))

    page.extract_text(visitor_text=visit)
    return items


def month_day(text):
    """(month, day); Table 6 writes the last day of the previous year as "Jan 0"."""
    month, day = text.split()
    return MONTHS.index(month) + 1, int(day)


def md(value):
    return "12-31" if value == (1, 0) else f"{value[0]:02d}-{value[1]:02d}"


def parse_table5(reader):
    text = reader.pages[24].extract_text()
    pattern = re.compile(
        r"^(?P<name>.+?)\s*\((?P<iau>\d{3}) (?P<code>[A-Z]{3})\)\s+(?P<a1>[A-Z][a-z]{2} \d{2})–(?P<a2>[A-Z][a-z]{2} \d{2})\s+"
        r"(?P<ref>\()?(?P<max>[A-Z][a-z]{2} \d{2})\)?\s+\(?(?P<lam>\d+) ?(?:\.◦(?P<frac>\d+)|◦)\)?\s+"
        r"(?P<ra>\d+) ?◦\s+(?P<dec>[+−-]\d+)◦\s+(?P<v>\d+)\s+(?P<r>\d\.\d)\s+(?P<zhr>\d+|Var)$"
    )
    showers = []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("Antihelion Source (ANT)"):
            m = re.match(r"^Antihelion Source \(ANT\) (\w{3} \d{2})–(\w{3} \d{2}) .* (\d+) (\d\.\d) (\d+)$", line)
            showers.append({"code": "ANT", "iau": None, "nameEn": "Antihelion Source", "activity": [md(month_day(m[1])), md(month_day(m[2]))],
                            "maximum": None, "solarLongitude": None, "referenceOnly": False, "radiant": None,
                            "velocity": int(m[3]), "populationIndex": float(m[4]), "zhr": int(m[5])})
            continue
        m = pattern.match(line)
        if not m:
            continue
        lam = float(f"{m['lam']}.{m['frac']}") if m["frac"] else float(m["lam"])
        showers.append({
            "code": m["code"], "iau": int(m["iau"]), "nameEn": re.sub(r"\s+", " ", m["name"]).strip(),
            "activity": [md(month_day(m["a1"])), md(month_day(m["a2"]))],
            "maximum": md(month_day(m["max"])), "solarLongitude": lam, "referenceOnly": bool(m["ref"]),
            "radiant": [int(m["ra"]), int(m["dec"].replace("−", "-"))],
            "velocity": int(m["v"]), "populationIndex": float(m["r"]),
            "zhr": None if m["zhr"] == "Var" else int(m["zhr"]),
        })
    return showers


def parse_table6(reader):
    alpha0, delta0, step = 94.3, 128.6, 65.7
    rows = {}
    for y, x, text in fragments(reader.pages[25]):
        rows.setdefault(y, []).append((x, text.strip()))
    table = []  # (date, {slot: [ra, dec]})
    for y in sorted(rows, reverse=True):
        row = sorted(rows[y])
        date, embedded, values, sign = None, None, {}, 1
        for x, t in row:
            m = re.match(r"^([A-Z][a-z]{2}) (\d{1,2})(?: (\d+))?$", t)
            if m and m[1] in MONTHS and x < 40:
                date = month_day(f"{m[1]} {m[2]}")
                embedded = float(m[3]) if m[3] else None
                continue
            if t in ("−", "-"):
                sign = -1
                continue
            if re.match(r"^[+−-]?\d+$", t):
                number = (-1 if t.startswith(("−", "-")) else sign) * float(t.lstrip("+−-"))
                sign = 1
                # Values are right-aligned to their degree symbol columns.
                columns = [(alpha0 + step * k, k, 0) for k in range(8)] + [(delta0 + step * k, k, 1) for k in range(8)]
                _, slot, coord = min(c for c in columns if c[0] > x)
                if embedded is not None and coord == 1 and slot not in values:
                    values[slot] = [embedded, None]
                    embedded = None
                values.setdefault(slot, [None, None])[coord] = number
        if date:
            if embedded is not None or any(None in v for v in values.values()):
                raise ValueError(f"Table 6 row {date} incomplete: {values}")
            table.append((date, values))
    return table


def unit(ra, dec):
    a, d = math.radians(ra), math.radians(dec)
    return (math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d))


def separation(p, q):
    u, v = unit(*p), unit(*q)
    return math.degrees(math.acos(max(-1, min(1, sum(a * b for a, b in zip(u, v))))))


def day_of_year(value):
    month, day = value
    return sum([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][: month - 1]) + day


def runs_from(table):
    """Contiguous radiant tracks per column, split where the radiant jumps (a new shower)."""
    open_runs, runs = {}, []
    for date, values in table:
        for slot in list(open_runs):
            if slot not in values:
                runs.append(open_runs.pop(slot))
        for slot, (ra, dec) in values.items():
            run = open_runs.get(slot)
            if run:
                last_date, last_ra, last_dec = run[-1]
                days = (day_of_year(date) - day_of_year(last_date)) % 365 or 365
                if separation((last_ra, last_dec), (ra, dec)) / days > 1.6:
                    runs.append(open_runs.pop(slot))
                    run = None
            if not run:
                run = open_runs[slot] = []
            run.append((date, ra, dec))
    return runs + list(open_runs.values())


def position_at(run, date):
    """Linear interpolation (extrapolation from the nearest pair) in day of year, unwrapping RA."""
    days = [day_of_year(d) for d, _, _ in run]
    for i in range(1, len(days)):
        while days[i] < days[i - 1]:
            days[i] += 365
    t = day_of_year(date)
    if t < days[0] - 60:
        t += 365
    if len(run) == 1:
        return run[0][1], run[0][2]
    i = max(1, min(len(days) - 1, next((k for k in range(1, len(days)) if days[k] >= t), len(days) - 1)))
    f = (t - days[i - 1]) / (days[i] - days[i - 1])
    ra0, ra1 = run[i - 1][1], run[i][1]
    if ra1 - ra0 > 180:
        ra1 -= 360
    if ra0 - ra1 > 180:
        ra1 += 360
    return (ra0 + f * (ra1 - ra0)) % 360, run[i - 1][2] + f * (run[i][2] - run[i - 1][2])


def continues(before, after):
    """`after` picks up where `before` stops, across the Dec 30 → Jan 0 wrap of the table."""
    days = (day_of_year(after[0][0]) - day_of_year(before[-1][0])) % 365
    # The two halves of the table round independently; allow 3° at the seam.
    return 0 < days <= 10 and separation(before[-1][1:], after[0][1:]) <= max(3, 1.6 * days)


def assign(showers, runs):
    """Each shower with a Table 5 radiant takes the run whose position at maximum is nearest."""
    pairs = []
    for s, shower in enumerate(showers):
        if shower["radiant"]:
            maximum = tuple(int(v) for v in shower["maximum"].split("-"))
            pairs += [(separation(position_at(run, maximum), shower["radiant"]), s, i) for i, run in enumerate(runs)]
    # Closest pairs first, so a nearby track cannot be claimed by a worse match.
    tracks, taken, report = {}, set(), {}
    for distance, s, i in sorted(pairs):
        if s in tracks or i in taken or distance > 8:
            continue
        tracks[s] = list(runs[i])
        taken.add(i)
        report[showers[s]["code"]] = round(distance, 2)
    missing = [shower["code"] for s, shower in enumerate(showers) if shower["radiant"] and s not in tracks]
    if missing:
        raise ValueError(f"No Table 6 track within 8° of the Table 5 radiant: {missing}")
    # A track crossing the year end is split by the table; rejoin its pieces.
    rest = [run for i, run in enumerate(runs) if i not in taken]
    for run in list(rest):
        for s, track in tracks.items():
            if continues(track, run):
                tracks[s] = track + run
            elif continues(run, track):
                tracks[s] = run + track
            else:
                continue
            rest.remove(run)
            break
    for s, track in tracks.items():
        showers[s]["drift"] = [[md(d), ra, dec] for d, ra, dec in track]
    # The antihelion source has no radiant at maximum: it owns the remaining tracks.
    ant = next(shower for shower in showers if shower["code"] == "ANT")
    rest.sort(key=lambda run: day_of_year(run[0][0]))
    ant["drift"] = [[md(d), ra, dec] for run in rest for d, ra, dec in run]
    return report


def parse_profiles(reader):
    text = reader.pages[17].extract_text()
    rows = re.findall(r"^([A-Z]{3}) (\d+\.\d+) (\d+) (\d\.\d) (\d+\.\d+) (\d+\.\d+) (\d+) (.+)$", text, re.M)
    profiles = {}
    for code, lam, zhr, _r, growth, decay, _v, name in rows:
        decay = float(decay) or float(growth)
        part = "base" if "(base)" in name else "peak"
        profiles.setdefault(MEO_CODES.get(code, code), []).append(
            {"component": part, "solarLongitude": float(lam), "zhr": int(zhr), "growth": float(growth), "decay": decay})
    return profiles


def main():
    imo_path, meo_path = sys.argv[1:3]
    imo_sha, meo_sha = checked(imo_path, IMO_SHA), checked(meo_path, MEO_SHA)
    imo, meo = PdfReader(imo_path), PdfReader(meo_path)
    showers = parse_table5(imo)
    if len(showers) != 38 or len({s["code"] for s in showers}) != 38:
        raise ValueError(f"Table 5: expected 38 showers, found {len(showers)}")
    report = assign(showers, runs_from(parse_table6(imo)))
    profiles = parse_profiles(meo)
    for shower in showers:
        shower["name"] = NAMES[shower["code"]]
        shower["profile"] = profiles.get(shower["code"])
    output = {
        "sources": [
            {"title": "IMO Meteor Shower Calendar 2026 (IMO INFO(3-25)), Tables 5 and 6", "editor": "Jürgen Rendtel",
             "url": "https://www.imo.net/files/meteor-shower/cal2026.pdf", "sha256": imo_sha,
             "rights": "© International Meteor Organization, 2025. No explicit licence; factual values are excerpted with attribution and will be withdrawn on request."},
            {"title": "Moorhead, Egal, Brown, Moser & Cooke (2019), Meteor shower forecasting in near-Earth space, Table 5",
             "url": "https://arxiv.org/abs/1904.06370", "sha256": meo_sha,
             "note": "Activity growth/decay exponents only; a decay of 0.00 denotes a symmetric profile (Moorhead, Cooke & Campbell-Brown 2017, Table 3)."},
        ],
        "generatedBy": "scripts/build-meteor-showers.py",
        "dates": "Month-day in the 2026 calendar; the application converts them to J2000 solar longitude.",
        "table6Matching": report,
        "showers": showers,
    }
    target = root / "src" / "data" / "meteor-showers.json"
    target.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    print(f"wrote {target} ({target.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
