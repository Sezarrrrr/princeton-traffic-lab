"""Export local footprints from saved OpenStreetMap XML tiles."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

from import_osm import ROOT, tags

BOUNDS = (40.320, -74.698, 40.375, -74.602)
SOURCE = "https://api.openstreetmap.org/api/0.6/map"


def building_height(attributes):
    height = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*(m|ft|feet|')?\s*", attributes.get("height", ""))
    if height:
        meters = float(height[1]) * (0.3048 if height[2] in ("ft", "feet", "'") else 1)
        if 0 < meters <= 300:
            return round(meters, 2), "height"
    try:
        levels = float(attributes.get("building:levels", ""))
        if 0 < levels <= 70:
            return round(levels * 3.2, 2), "levels"
    except ValueError:
        pass
    return 6.4, "default"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, nargs="+", required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "frontend/geo/princeton-buildings.json")
    args = parser.parse_args()
    nodes, buildings = {}, {}
    south, west, north, east = BOUNDS
    for path in args.input:
        root = ET.parse(path).getroot()
        for point in root.iterfind("node"):
            nodes[point.get("id")] = [float(point.get("lat")), float(point.get("lon"))]
        for way in root.iterfind("way"):
            attributes = tags(way)
            if attributes.get("building") in (None, "no"):
                continue
            refs = [point.get("ref") for point in way.iterfind("nd")]
            if len(refs) >= 4 and refs[0] == refs[-1]:
                buildings[way.get("id")] = (refs[:-1], attributes)

    features = []
    for way_id, (refs, attributes) in sorted(buildings.items(), key=lambda entry: int(entry[0])):
        if not all(ref in nodes for ref in refs):
            continue
        footprint = [nodes[ref] for ref in refs]
        if not any(south <= lat <= north and west <= lon <= east for lat, lon in footprint):
            continue
        meters, source = building_height(attributes)
        features.append({"way": int(way_id), "footprint": footprint, "meters": meters, "heightSource": source})

    data = {"source": SOURCE, "license": "https://www.openstreetmap.org/copyright",
            "exportedUtc": datetime.now(timezone.utc).isoformat(), "bounds": BOUNDS, "buildings": features}
    args.output.write_text(json.dumps(data, separators=(",", ":")) + "\n", encoding="utf8")
    print(f"{len(features):,} footprints, {sum(f['heightSource'] == 'height' for f in features):,} mapped heights")


if __name__ == "__main__":
    main()
