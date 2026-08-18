#!/usr/bin/env python3
"""
Fix rows in stops_production_v2.csv where an unquoted comma inside the
`aliases` field caused it to split into extra columns, shifting lat/lng
and everything after them.

Strategy: for each row, if `lat` (index 3) doesn't parse as a float in
the plausible Kathmandu-valley range, progressively merge fields starting
at `aliases` (index 2) until lat/lng line up as valid floats again.
Writes the corrected file with proper quoting (so this can't recur silently).
"""
import csv
import sys

LAT_RANGE = (27.5, 27.9)
LNG_RANGE = (85.1, 85.6)

def valid_lat(s):
    try:
        v = float(s)
        return LAT_RANGE[0] < v < LAT_RANGE[1]
    except ValueError:
        return False

def valid_lng(s):
    try:
        v = float(s)
        return LNG_RANGE[0] < v < LNG_RANGE[1]
    except ValueError:
        return False

def fix_row(row, header_len):
    if len(row) >= 5 and valid_lat(row[3]) and valid_lng(row[4]):
        return row, False

    for k in range(2, min(8, len(row) - 3)):
        merged_alias = ", ".join(x for x in row[2:2 + k] if x != "")
        candidate = row[0:2] + [merged_alias] + row[2 + k:]
        if len(candidate) >= 5 and valid_lat(candidate[3]) and valid_lng(candidate[4]):
            return candidate, True

    return row, None

def main(path):
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)
        rows = list(reader)

    fixed_count = 0
    unfixed = []
    out_rows = []
    for i, row in enumerate(rows):
        new_row, changed = fix_row(row, len(header))
        if changed is None and len(row) >= 5 and not (valid_lat(row[3]) and valid_lng(row[4])):
            unfixed.append((i, row[:5]))
        elif changed:
            fixed_count += 1
        out_rows.append(new_row)

    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, quoting=csv.QUOTE_MINIMAL)
        writer.writerow(header)
        writer.writerows(out_rows)

    print(f"Fixed {fixed_count} rows automatically.")
    if unfixed:
        print(f"{len(unfixed)} rows could NOT be auto-fixed — needs manual review:")
        for i, snippet in unfixed:
            print(f"  row {i}: {snippet}")
    else:
        print("No remaining unfixed rows.")

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "raw/stops_production_v2.csv")
