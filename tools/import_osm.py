"""Build the offline Princeton road graph from OpenStreetMap XML."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import math
from pathlib import Path
from urllib.parse import urlencode
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from time import sleep
import xml.etree.ElementTree as ET

EARTH = 6_371_000
MILE = 1609.344
ROOT = Path(__file__).resolve().parents[1]
OVERPASS = "https://overpass-api.de/api/interpreter"
OSM_MAP = "https://api.openstreetmap.org/api/0.6/map"
MOTOR_ROADS = {
    "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified",
    "residential", "living_street", "service", "road", "track",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
}
ACCESS = {"yes", "designated", "permissive", "official"}
MODES = {"car": ("motorcar", "motor_vehicle", "vehicle", "access"),
         "bus": ("bus", "psv", "motor_vehicle", "vehicle", "access")}


def tags(element):
    return {tag.get("k"): tag.get("v") for tag in element.findall("tag")}


def motor_access(attributes, mode, default):
    return next((attributes[key] in ACCESS for key in MODES[mode] if key in attributes), default)


def directions(attributes, mode):
    keys = MODES[mode][:-1]
    value = next((attributes["oneway:" + key] for key in keys if "oneway:" + key in attributes),
                 attributes.get("oneway", "yes" if attributes.get("junction") in ("roundabout", "circular")
                                or attributes.get("highway") == "motorway" else "no"))
    return (-1,) if value == "-1" else (1, -1) if value in ("no", "0", "false") else (1,)


def allowed_directions(attributes, mode):
    default = attributes["highway"] != "track"
    result = []
    for direction in directions(attributes, mode):
        suffix = ":forward" if direction == 1 else ":backward"
        allowed = next((attributes[tag] in ACCESS for key in MODES[mode]
                        for tag in (key + suffix, key) if tag in attributes), default)
        if allowed:
            result.append(direction)
    return result


def project(point, center):
    """Azimuthal equidistant coordinates in meters from the configured center."""
    lat, lon = map(math.radians, point)
    lat0, lon0 = map(math.radians, center)
    delta = lon - lon0
    x = math.cos(lat) * math.sin(delta)
    y = math.cos(lat0) * math.sin(lat) - math.sin(lat0) * math.cos(lat) * math.cos(delta)
    dot = math.sin(lat0) * math.sin(lat) + math.cos(lat0) * math.cos(lat) * math.cos(delta)
    distance = math.hypot(x, y)
    scale = EARTH * math.atan2(distance, dot) / distance if distance else EARTH
    return x * scale, y * scale


def unproject(point, center):
    x, y = point
    lat0, lon0 = map(math.radians, center)
    distance = math.hypot(x, y)
    if not distance:
        return list(center)
    angle = distance / EARTH
    lat = math.asin(math.cos(angle) * math.sin(lat0) + y * math.sin(angle) * math.cos(lat0) / distance)
    lon = lon0 + math.atan2(x * math.sin(angle), distance * math.cos(lat0) * math.cos(angle)
                            - y * math.sin(lat0) * math.sin(angle))
    return [round(math.degrees(lat), 7), round(math.degrees(lon), 7)]


def clip(a, b, radius):
    dx, dy = b[0] - a[0], b[1] - a[1]
    aa = dx * dx + dy * dy
    if not aa:
        return None
    bb = a[0] * dx + a[1] * dy
    discriminant = bb * bb - aa * (a[0] ** 2 + a[1] ** 2 - radius ** 2)
    if discriminant <= 0:
        return None
    root = math.sqrt(discriminant)
    start, end = max(0, (-bb - root) / aa), min(1, (-bb + root) / aa)
    return (start, end) if start < end else None


def fetch(center, radius, server):
    lat, lon = center
    y = math.degrees(radius / EARTH) + 0.001
    x = math.degrees(radius / EARTH / math.cos(math.radians(abs(lat) + y))) + 0.001
    bounds = f"{lat-y},{lon-x},{lat+y},{lon+x}"
    query = (f'[out:xml][timeout:180];way["highway"]({bounds})->.roads;'
             '(.roads;node(w.roads)["barrier"];rel(bw.roads)["type"="restriction"];);out body geom;')
    request = Request(server + "?" + urlencode({"data": query}),
                      headers={"User-Agent": "PrincetonTrafficLab/1.0 (local research demo)"})
    with urlopen(request, timeout=210) as response:
        return ET.fromstring(response.read())


def fetch_tiles(center, radius):
    lat, lon = center
    y = math.degrees(radius / EARTH) + 0.0015
    x = math.degrees(radius / EARTH / math.cos(math.radians(abs(lat) + y))) + 0.0015
    columns, rows = math.ceil(2 * x / 0.018), math.ceil(2 * y / 0.019)

    def fetch_box(west, south, east, north):
        query = urlencode({"bbox": f"{west:.7f},{south:.7f},{east:.7f},{north:.7f}"}, safe=",")
        request = Request(OSM_MAP + "?" + query, headers={"User-Agent": "PrincetonTrafficLab/1.0"})
        for attempt in range(4):
            try:
                with urlopen(request, timeout=60) as response:
                    return [ET.fromstring(response.read())]
            except HTTPError as error:
                if error.code == 400 and "too many nodes" in error.read().decode(errors="replace"):
                    middle = (west + east) / 2
                    return fetch_box(west, south, middle, north) + fetch_box(middle, south, east, north)
                if error.code not in (429, 509, 502, 503, 504) or attempt == 3:
                    raise
                sleep(32)

    documents = []
    for row in range(rows):
        for column in range(columns):
            documents.extend(fetch_box(lon-x+2*x*column/columns, lat-y+2*y*row/rows,
                                       lon-x+2*x*(column+1)/columns, lat-y+2*y*(row+1)/rows))
    return documents


def read_osm(documents):
    points, barriers, ways, restrictions = {}, {}, {}, {}
    for root in documents:
        if root.tag != "osm" or root.find("remark") is not None:
            raise ValueError("OSM returned an incomplete response")
        for node in root.findall("node"):
            node_id = node.get("id")
            points[node_id] = (float(node.get("lat")), float(node.get("lon")))
            attributes = tags(node)
            if "barrier" in attributes:
                barriers[node_id] = attributes
        for way in root.findall("way"):
            attributes = tags(way)
            if attributes.get("highway") not in MOTOR_ROADS:
                continue
            refs = []
            for node in way.findall("nd"):
                refs.append(node.get("ref"))
                if node.get("lat") is not None:
                    points[refs[-1]] = (float(node.get("lat")), float(node.get("lon")))
            allowed = {mode: allowed_directions(attributes, mode) for mode in MODES}
            if any(allowed.values()) and len(refs) > 1:
                ways[way.get("id")] = refs, attributes, allowed
        for relation in root.findall("relation"):
            attributes = tags(relation)
            if attributes.get("type") == "restriction":
                restrictions[relation.get("id")] = (attributes, [(m.get("role"), m.get("type"), m.get("ref"))
                                                                 for m in relation.findall("member")])
    if not ways:
        raise ValueError("No motor roads in OSM response")
    return points, barriers, ways, restrictions


def build(documents, base, center, radius, source):
    points, barriers, ways, restrictions = read_osm(documents)
    usage = Counter(ref for refs, _, _ in ways.values() for ref in set(refs))
    way_nodes = {way_id: set(refs) for way_id, (refs, _, _) in ways.items()}
    ways_by_node = {}
    for way_id, refs in way_nodes.items():
        for ref in refs:
            ways_by_node.setdefault(ref, []).append(way_id)
    nodes, roads = {}, []
    projected = {ref: project(point, center) for ref, point in points.items()}
    # Snap only exact OSM vertices after the rounding used by the hand-curated file.
    point_refs = {}
    for ref in usage:
        point_refs.setdefault(tuple(round(value, 6) for value in points[ref]), []).append(ref)
    aliases, legacy_edges = {}, set()

    def add_node(node_id, point, name=None):
        x, y = project(point, center)
        nodes.setdefault(node_id, {"id": node_id, "name": name or "Road access point",
                                   "latLng": list(point), "x": round(x, 1), "y": round(-y, 1),
                                   "imported": node_id.startswith("osm_")})

    for node in base["intersections"]:
        if math.hypot(*project(node["latLng"], center)) > radius:
            continue
        add_node(node["id"], node["latLng"], node["name"])
        refs = point_refs.get(tuple(node["latLng"]), [])
        if len(refs) == 1:
            aliases[refs[0]] = node["id"]

    replacements = {}
    for road in base["roads"]:
        if road["from"] not in nodes or road["to"] not in nodes:
            continue
        geometry = road["geometry"]
        if any(math.hypot(*project(point, center)) > radius for point in geometry):
            continue
        refs = [point_refs.get(tuple(point), []) for point in geometry]
        refs = [matches[0] if len(matches) == 1 else None for matches in refs]
        legacy_edges.update(frozenset((a, b)) for a, b in zip(refs, refs[1:]) if a and b)
        breaks = [0, *(i for i, ref in enumerate(refs[1:-1], 1) if ref and
                       (usage[ref] > 1 or ref in aliases or ref in barriers)), len(geometry) - 1]
        lengths = [sum(math.dist(project(a, center), project(b, center))
                       for a, b in zip(geometry[i:j], geometry[i+1:j+1]))
                   for i, j in zip(breaks, breaks[1:])]
        total = sum(lengths)
        ids = []
        start = road["from"]
        for index, (i, j) in enumerate(zip(breaks, breaks[1:])):
            end = road["to"] if j == breaks[-1] else aliases.get(refs[j], "osm_n" + refs[j])
            if start == end:
                continue
            if refs[j]:
                aliases[refs[j]] = end
            add_node(end, geometry[j], road["name"])
            segment_id = road["id"] if not index else f"{road['id']}_n{refs[i]}"
            ids.append(segment_id)
            way_matches = [
                way_id for way_id in ways_by_node.get(refs[i], ())
                if refs[j] in way_nodes[way_id]
            ]
            roads.append({**road, "id": segment_id, "from": start, "to": end, "laneGroup": road["id"],
                          **({"osmWayRef": way_matches[0]} if len(way_matches) == 1 else {}),
                          "geometry": [nodes[start]["latLng"], *geometry[i+1:j], nodes[end]["latLng"]],
                          "freeFlowMinutes": road.get("freeFlowMinutes", 2) * lengths[index] / total})
            start = end
        replacements[road["id"]] = ids

    # Break only at actual shared OSM nodes, barriers, legacy attachments and boundary crossings.
    for way_id, (refs, attributes, allowed) in sorted(ways.items(), key=lambda entry: int(entry[0])):
        name = attributes.get("name") or attributes.get("ref") or attributes["highway"].replace("_", " ").title()
        group = []

        def emit():
            if len(group) < 2:
                return
            start, end = group[0][0], group[-1][0]
            if start == end:
                if len(group) > 2:
                    full = group[:]
                    middle = len(full) // 2
                    group[:] = full[:middle + 1]
                    emit()
                    group[:] = full[middle:]
                    emit()
                return
            for node_id, point in (group[0], group[-1]):
                add_node(node_id, point, name)
            length = sum(math.dist(project(a[1], center), project(b[1], center))
                         for a, b in zip(group, group[1:]))
            if length < 0.01:
                return
            geometry = [nodes[start]["latLng"], *(point for _, point in group[1:-1]), nodes[end]["latLng"]]
            road_id = f"osm_w{way_id}_{start}_{end}"
            speed = 72 if attributes["highway"].startswith(("motorway", "trunk")) else 40
            roads.append({"id": road_id, "name": name, "from": start, "to": end, "geometry": geometry,
                          "twoWay": len(allowed["car"]) == 2, "carAccess": bool(allowed["car"]),
                          "busAccess": bool(allowed["bus"]), "directions": allowed, "osmWay": way_id,
                          "freeFlowMinutes": length / (speed * 1000 / 60),
                          **{key: attributes[key] for key in ("bridge", "tunnel", "layer") if key in attributes}})

        for a, b in zip(refs, refs[1:]):
            if a not in projected or b not in projected:
                raise ValueError(f"Missing geometry on OSM way {way_id}")
            pair = None if frozenset((a, b)) in legacy_edges else clip(projected[a], projected[b], radius)
            if not pair:
                emit()
                group = []
                continue

            def vertex(ref, t, suffix):
                if t == suffix:
                    node_id = aliases.get(ref, "osm_n" + ref)
                    return node_id, nodes.get(node_id, {}).get("latLng", list(points[ref]))
                xy = tuple(x + t * (y - x) for x, y in zip(projected[a], projected[b]))
                low, high = sorted((int(a), int(b)))
                side = suffix if int(a) == low else 1 - suffix
                return f"osm_cut_{low}_{high}_{side}", unproject(xy, center)

            start, end = vertex(a, pair[0], 0), vertex(b, pair[1], 1)
            if not group or group[-1][0] != start[0]:
                emit()
                group = [start]
            group.append(end)
            if pair[1] != 1 or usage[b] > 1 or b in aliases or b in barriers:
                emit()
                group = []
        emit()

    used = {road[key] for road in roads for key in ("from", "to")}
    names = {}
    for road in roads:
        for key in ("from", "to"):
            names.setdefault(road[key], set()).add(road["name"])
    for node_id, node in nodes.items():
        if node["imported"]:
            names_for_node = sorted(names.get(node_id, ()))
            if names_for_node:
                node["name"] = " & ".join(names_for_node[:3])
                if len(names_for_node) == 1:
                    node["name"] += " (boundary)" if node_id.startswith("osm_cut_") else " (road junction)"
    node_barriers = {}
    for ref, attributes in barriers.items():
        node_id = aliases.get(ref, "osm_n" + ref)
        if node_id in used:
            default = attributes["barrier"] in {"cattle_grid", "toll_booth", "border_control", "entrance"}
            node_barriers[node_id] = [mode for mode in MODES if not motor_access(attributes, mode, default)]

    turns, via_turns, ignored_turns = [], [], 0
    present_ways = {road.get("osmWay", road.get("osmWayRef")) for road in roads}
    for attributes, members in restrictions.values():
        via = [ref for role, kind, ref in members if role == "via" and kind == "node"]
        incoming = [ref for role, kind, ref in members if role == "from" and kind == "way"]
        outgoing = [ref for role, kind, ref in members if role == "to" and kind == "way"]
        if not (present_ways.intersection(incoming) and present_ways.intersection(outgoing)):
            continue
        rule = {"fromWays": incoming, "toWays": outgoing, "restriction": attributes.get("restriction"),
                "car": attributes.get("restriction:motorcar", attributes.get("restriction:motor_vehicle")),
                "bus": attributes.get("restriction:bus", attributes.get("restriction:psv")),
                "except": attributes.get("except", "").split(";")}
        via_ways = [ref for role, kind, ref in members if role == "via" and kind == "way"]
        if len(via) == 1:
            via_id = aliases.get(via[0], "osm_n" + via[0])
            if via_id in used:
                turns.append({**rule, "node": via_id})
        elif via_ways and set(via_ways) <= present_ways:
            via_turns.append({**rule, "viaWays": via_ways})
        else:
            ignored_turns += 1

    def expand(route, start):
        ids = []
        for road_id in route["roadIds"]:
            original = original_roads[road_id]
            forward = original["from"] == start
            pieces = replacements.get(road_id)
            if not pieces:
                return None
            ids.extend(pieces if forward else reversed(pieces))
            start = original["to"] if forward else original["from"]
        return {**route, "roadIds": ids}

    original_roads = {road["id"]: road for road in base["roads"]}
    locations = [point for point in base["locations"] if point["nodeId"] in used]
    bus_routes = [result for route in base["busRoutes"] if (result := expand(route, route["startNodeId"]))]
    stop_ids = {stop for route in bus_routes for stop in route["stopIds"]}
    demo = dict(base["demo"])
    demo["carRoutes"] = [result for route in demo["carRoutes"] if (result := expand(route, demo["originId"]))]
    if len(demo["carRoutes"]) != 2:
        demo = None

    return {"intersections": [node for key, node in nodes.items() if key in used],
            "roads": roads, "locations": locations,
            "busStops": [stop for stop in base["busStops"] if stop["id"] in stop_ids],
            "busRoutes": bus_routes, "mainApproaches": {node: [
                replacements[road][0 if original_roads[road]["from"] == node else -1] for road in ids
                if replacements.get(road)] for node, ids in base["mainApproaches"].items() if node in used},
            "demo": demo, "barriers": node_barriers, "turnRestrictions": turns, "viaWayRestrictions": via_turns,
            "coverage": {"center": center, "radiusMeters": radius, "source": source,
                         "importedUtc": datetime.now(timezone.utc).isoformat(),
                         "snapshotUtc": next((meta.get("osm_base") for root in documents
                                              if (meta := root.find("meta")) is not None), None),
                         "ignoredViaWayRestrictions": ignored_turns,
                         "conditionalWays": sum(any("conditional" in key and
                             key.split(":")[0] in {"access", "vehicle", "motor_vehicle", "motorcar", "bus", "psv", "oneway"}
                             for key in attributes) for _, attributes, _ in ways.values()),
                         "attribution": "\u00a9 OpenStreetMap contributors",
                         "license": "https://www.openstreetmap.org/copyright"}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--center", type=float, nargs=2, default=(40.350392, -74.657115), metavar=("LAT", "LON"))
    parser.add_argument("--radius-miles", type=float, default=5)
    parser.add_argument("--overpass", nargs="?", const=OVERPASS, help="Use Overpass instead of tiled OSM API downloads")
    parser.add_argument("--input", type=Path, nargs="+", help="Use saved OSM XML instead of downloading")
    parser.add_argument("--base", type=Path, default=ROOT / "backend/network.json")
    parser.add_argument("--output", type=Path, default=ROOT / "backend/osm-network.json")
    args = parser.parse_args()
    lat, lon = args.center
    if not (0 < args.radius_miles <= 20 and abs(lat) < 85 and abs(lon) < 179):
        parser.error("Use a positive radius up to 20 miles and a nonpolar center away from the antimeridian")
    radius = args.radius_miles * MILE
    documents = ([ET.parse(path).getroot() for path in args.input] if args.input else
                 [fetch(args.center, radius, args.overpass)] if args.overpass else fetch_tiles(args.center, radius))
    base = json.loads(args.base.read_text(encoding="utf-8"))
    source = args.overpass or OSM_MAP
    data = build(documents, base, args.center, radius, source)
    import sys
    sys.path.insert(0, str(ROOT))
    from backend.princeton_network import validate_network
    validate_network(data)
    temporary = args.output.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    print(f"{len(data['intersections']):,} intersections and {len(data['roads']):,} road segments in {args.output}")


if __name__ == "__main__":
    main()
