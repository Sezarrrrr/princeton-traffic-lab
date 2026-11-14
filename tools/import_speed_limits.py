"""Recover speed limits from OSM XML without replacing the existing road graph."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import xml.etree.ElementTree as ET

from import_osm import ROOT, read_osm
from backend.speed_limits import speed_records


def way_orientation(geometry, way_points):
    """Match all vertices in order, allowing curated six-decimal rounding."""
    def rounded(points):
        return [tuple(round(value, 6) for value in point) for point in points]

    segment, way = rounded(geometry), rounded(way_points)
    if len(segment) < 2 or len(way) < len(segment):
        return None
    for i, point in enumerate(way):
        if point != segment[0]:
            continue
        if way[i:i + len(segment)] == segment:
            return 1
        if list(reversed(way[max(0, i + 1 - len(segment)):i + 1])) == segment:
            return -1
    return None


def contains_point(a, point, b):
    span = ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** .5
    if not span:
        return False
    return (sum((x - y) ** 2 for x, y in zip(a, point)) ** .5 +
            sum((x - y) ** 2 for x, y in zip(point, b)) ** .5 <= span + 1e-7)


def clipped_orientation(road, way_points):
    """Reinsert the original boundary edges when comparing a clipped way."""
    geometry = road["geometry"]
    if not road["from"].startswith("osm_cut_") and not road["to"].startswith("osm_cut_"):
        return way_orientation(geometry, way_points)
    for direction, way in ((1, way_points), (-1, way_points[::-1])):
        starts = [i for i, point in enumerate(way) if point == tuple(geometry[0])]
        if road["from"].startswith("osm_cut_"):
            starts = [i for i, (a, b) in enumerate(zip(way, way[1:])) if contains_point(a, geometry[0], b)]
        for i in starts:
            j = i + len(geometry) - 1
            if j >= len(way) or way[i+1:j] != list(map(tuple, geometry[1:-1])):
                continue
            if (contains_point(way[j-1], geometry[-1], way[j]) if road["to"].startswith("osm_cut_")
                    else way[j] == tuple(geometry[-1])):
                return direction
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, nargs="+", required=True, help="OSM XML source tiles")
    parser.add_argument("--network", type=Path, default=ROOT / "backend/osm-network.json")
    parser.add_argument("--output", type=Path, default=ROOT / "backend/osm-speed-limits.json")
    parser.add_argument("--source", action="append", help="OSM source URL, repeatable")
    args = parser.parse_args()
    network = json.loads(args.network.read_text(encoding="utf-8"))
    points, _, ways, _ = read_osm(ET.parse(path).getroot() for path in args.input)
    geometries = {key: [points[ref] for ref in refs] for key, (refs, _, _) in ways.items()
                  if all(ref in points for ref in refs)}
    limits = {}
    for road in network["roads"]:
        way_id = road.get("osmWay") or road.get("osmWayRef")
        if not way_id:
            continue
        # Official overrides are tied to verified way IDs. OSM data is
        # accepted only where the current way still matches the snapshot.
        tags = {}
        orientation = clipped_orientation(road, geometries.get(way_id, ()))
        if orientation:
            tags = ways[way_id][1]
        records = speed_records(way_id, tags, orientation)
        if records:
            limits[road["id"]] = records
    data = {"networkImportedUtc": network["coverage"]["importedUtc"],
            "retrievedUtc": datetime.now(timezone.utc).isoformat(),
            "osmSources": args.source or ["https://api.openstreetmap.org/api/0.6/map"], "limits": limits}
    prefix = json.dumps({key: value for key, value in data.items() if key != "limits"}, ensure_ascii=False)
    entries = ",\n".join(f"    {json.dumps(key)}: {json.dumps(value, ensure_ascii=False)}"
                        for key, value in sorted(limits.items()))
    args.output.write_text(prefix[:-1] + ',\n  "limits": {\n' + entries + "\n  }\n}\n", encoding="utf-8")
    print(Counter(next(iter(records.values()))["source"] for records in limits.values()))


if __name__ == "__main__":
    main()
