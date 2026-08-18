"""
Geocode all Kathmandu bus stops against Nominatim (OpenStreetMap) and flag
stops whose current coordinates differ from the geocoded result by > 500 m.

Outputs:
  - geocode_report.csv   : per-stop comparison (current vs geocoded coords)
  - stops_corrected.csv  : copy of stops_clean.csv with mismatched coords fixed

Rate-limited to 1 req/sec per Nominatim usage policy.
"""

import csv
import io
import json
import math
import os
import re
import sys
import time
import urllib.request
import urllib.parse
import urllib.error

# Force UTF-8 output on Windows (avoids cp1252 UnicodeEncodeError for Nepali names)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, "..", "processed")

STOPS_CSV = os.path.join(DATA_DIR, "stops_clean.csv")
REPORT_CSV = os.path.join(SCRIPT_DIR, "geocode_report.csv")
CORRECTED_CSV = os.path.join(SCRIPT_DIR, "stops_corrected.csv")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
MISMATCH_THRESHOLD_M = 500  # flag if > 500 m apart
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "KathmanduBusRouteFinder/1.0 (academic-project)"
# Kathmandu Valley bounding box (lng_min, lat_max, lng_max, lat_min)
VIEWBOX = "85.2,27.8,85.5,27.6"


def haversine(lat1, lng1, lat2, lng2):
    """Return distance in metres between two (lat, lng) points."""
    R = 6_371_000  # Earth radius in metres
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def nominatim_search(query):
    """Query Nominatim and return (lat, lng) or None."""
    params = urllib.parse.urlencode({
        "q": query,
        "format": "json",
        "limit": 1,
        "viewbox": VIEWBOX,
        "bounded": 1,
    })
    url = f"{NOMINATIM_URL}?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            if data:
                return float(data[0]["lat"]), float(data[0]["lon"])
    except Exception as e:
        print(f"    [ERR] {e}")
    return None


def clean_stop_name(name):
    """Strip common suffixes that hurt geocoding ('Stop', 'Chowk', etc.)."""
    # Remove trailing "Stop", "Chowk Stop", "North", "South", "East", "West"
    cleaned = re.sub(r'\s+(Stop|Chowk Stop|North|South|East|West)$', '', name, flags=re.IGNORECASE)
    # Remove trailing "-- North", "-- South", etc.
    cleaned = re.sub(r'\s*--\s*(North|South|East|West)$', '', cleaned, flags=re.IGNORECASE)
    return cleaned.strip()


def geocode_stop(stop_name):
    """Try multiple query variations to geocode a stop name in Kathmandu."""
    # Variation 1: full name + Kathmandu
    result = nominatim_search(f"{stop_name}, Kathmandu")
    if result:
        return result

    time.sleep(1)

    # Variation 2: cleaned name + Kathmandu
    cleaned = clean_stop_name(stop_name)
    if cleaned != stop_name:
        result = nominatim_search(f"{cleaned}, Kathmandu")
        if result:
            return result
        time.sleep(1)

    # Variation 3: cleaned name + Kathmandu Valley
    result = nominatim_search(f"{cleaned}, Kathmandu Valley, Nepal")
    if result:
        return result

    return None


def main():
    # Read stops
    with open(STOPS_CSV, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        stops = list(reader)

    print(f"Loaded {len(stops)} stops from {STOPS_CSV}")

    report_rows = []
    corrections = {}  # stop_id -> (new_lat, new_lng)
    ok = mismatch = not_found = 0

    for i, stop in enumerate(stops):
        sid = stop["stop_id"]
        name = stop["stop_name"]
        cur_lat = float(stop["lat"])
        cur_lng = float(stop["lng"])

        print(f"[{i+1}/{len(stops)}] {sid} {name} ({cur_lat}, {cur_lng})")

        geo = geocode_stop(name)
        time.sleep(1)  # rate limit

        if geo is None:
            status = "NOT_FOUND"
            geo_lat = geo_lng = ""
            dist_m = ""
            not_found += 1
            print(f"    -> NOT_FOUND")
        else:
            geo_lat, geo_lng = geo
            dist_m = round(haversine(cur_lat, cur_lng, geo_lat, geo_lng), 1)
            if dist_m > MISMATCH_THRESHOLD_M:
                status = "MISMATCH"
                corrections[sid] = (geo_lat, geo_lng)
                mismatch += 1
                print(f"    -> MISMATCH  dist={dist_m}m  geocoded=({geo_lat}, {geo_lng})")
            else:
                status = "OK"
                ok += 1
                print(f"    -> OK  dist={dist_m}m")

        report_rows.append({
            "stop_id": sid,
            "stop_name": name,
            "current_lat": cur_lat,
            "current_lng": cur_lng,
            "geocoded_lat": geo_lat,
            "geocoded_lng": geo_lng,
            "distance_m": dist_m,
            "status": status,
        })

    # Write report
    with open(REPORT_CSV, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "stop_id", "stop_name", "current_lat", "current_lng",
            "geocoded_lat", "geocoded_lng", "distance_m", "status",
        ])
        writer.writeheader()
        writer.writerows(report_rows)

    # Write corrected stops CSV
    with open(CORRECTED_CSV, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for stop in stops:
            row = dict(stop)
            if stop["stop_id"] in corrections:
                new_lat, new_lng = corrections[stop["stop_id"]]
                row["lat"] = new_lat
                row["lng"] = new_lng
            writer.writerow(row)

    print(f"\n{'='*60}")
    print(f"RESULTS:  OK={ok}  MISMATCH={mismatch}  NOT_FOUND={not_found}")
    print(f"Report:    {REPORT_CSV}")
    print(f"Corrected: {CORRECTED_CSV}")
    print(f"{'='*60}")

    # Print mismatches summary
    if mismatch > 0:
        print(f"\nMISMATCHED STOPS ({mismatch}):")
        print(f"{'ID':<8} {'Name':<35} {'Old Lat':>10} {'Old Lng':>10} {'New Lat':>10} {'New Lng':>10} {'Dist(m)':>8}")
        print("-" * 100)
        for r in report_rows:
            if r["status"] == "MISMATCH":
                print(f"{r['stop_id']:<8} {r['stop_name']:<35} {r['current_lat']:>10} {r['current_lng']:>10} {r['geocoded_lat']:>10} {r['geocoded_lng']:>10} {r['distance_m']:>8}")


if __name__ == "__main__":
    main()
