import json
import re
from pathlib import Path

from .street_picks import build_stretches


def index(records, label):
    indexed = {}
    for record in records:
        record_id = record["id"]
        if not isinstance(record_id, str) or not re.fullmatch(r"[a-z][a-z0-9_]*", record_id):
            raise ValueError(f"Invalid {label} ID: {record_id}")
        if record_id in indexed:
            raise ValueError(f"Duplicate {label} ID: {record_id}")
        indexed[record_id] = record
    return indexed


def follow_route(roads, road_ids, start, mode="car"):
    """Return the ordered graph nodes, or None for an illegal traversal."""
    nodes = [start]
    for road_id in road_ids:
        road = roads.get(road_id)
        if not road:
            return None
        directions = road_directions(road, mode)
        if road["from"] == nodes[-1] and 1 in directions:
            nodes.append(road["to"])
        elif road["to"] == nodes[-1] and -1 in directions:
            nodes.append(road["from"])
        else:
            return None
    return nodes


def road_directions(road, mode):
    if not road.get(f"{mode}Access", road.get("carAccess", True)):
        return ()
    return road.get("directions", {}).get(mode, (1, -1) if road.get("twoWay") else (1,))


def validate_network(network):
    nodes = index(network["intersections"], "intersection")
    roads = index(network["roads"], "road")
    stops = index(network["busStops"], "bus stop")
    endpoints = index(network["intersections"] + network["locations"] + network["busStops"], "endpoint")
    index(network["busRoutes"], "bus route")
    connected_nodes = set()
    for road in roads.values():
        start, end = road["from"], road["to"]
        if start not in nodes or end not in nodes or start == end:
            raise ValueError(f"Invalid road endpoints: {road['id']}")
        points = road["geometry"]
        if len(points) < 2 or points[0] != nodes[start]["latLng"] or points[-1] != nodes[end]["latLng"]:
            raise ValueError(f"Geometry must run from start to end: {road['id']}")
        if road.get("freeFlowMinutes", 2) <= 0:
            raise ValueError(f"Invalid free-flow time: {road['id']}")
        connected_nodes.update((start, end))
    for node_id in network.get("barriers", {}):
        if node_id not in connected_nodes:
            raise ValueError(f"Unknown barrier node: {node_id}")
    osm_ways = {road.get("osmWay", road.get("osmWayRef")) for road in roads.values()}
    for rule in network.get("turnRestrictions", []) + network.get("viaWayRestrictions", []):
        if "node" in rule and rule["node"] not in connected_nodes:
            raise ValueError(f"Unknown turn restriction node: {rule['node']}")
        if not (osm_ways.intersection(rule["fromWays"]) and osm_ways.intersection(rule["toWays"])
                and set(rule.get("viaWays", ())) <= osm_ways):
            raise ValueError("Turn restriction references a way outside the graph")
    for endpoint in endpoints.values():
        if endpoint.get("nodeId", endpoint["id"]) not in connected_nodes:
            raise ValueError(f"Unknown or disconnected graph node for {endpoint['id']}")
    for node_id, road_ids in network["mainApproaches"].items():
        if node_id not in nodes or any(
            road_id not in roads or node_id not in (roads[road_id]["from"], roads[road_id]["to"])
            for road_id in road_ids
        ):
            raise ValueError(f"Invalid signal approaches at {node_id}")
    bus_paths = {}
    used_stops = set()
    for route in network["busRoutes"]:
        route_id = route["id"]
        path = follow_route(roads, route["roadIds"], route["startNodeId"], mode="bus")
        stop_ids = route["stopIds"]
        if not path or len(path) < 2 or len(stop_ids) < 2 or len(set(stop_ids)) != len(stop_ids):
            raise ValueError(f"Invalid bus route: {route_id}")
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", route["color"]):
            raise ValueError(f"Invalid bus route color: {route_id}")
        previous = -1
        indices = {}
        for stop_id in stop_ids:
            if stop_id not in stops:
                raise ValueError(f"Unknown bus stop {stop_id} on {route_id}")
            try:
                previous = path.index(stops[stop_id]["nodeId"], previous + 1)
            except ValueError:
                raise ValueError(f"Stop {stop_id} is out of road order on {route_id}") from None
            indices[stop_id] = previous
        used_stops.update(stop_ids)
        bus_paths[route_id] = (path, indices)
    if stops.keys() - used_stops:
        raise ValueError(f"Stops missing a route: {', '.join(sorted(stops.keys() - used_stops))}")
    demo = network["demo"]
    if demo is None:
        return nodes, roads, endpoints, bus_paths
    if any(demo[key] not in endpoints for key in ("originId", "destinationId")) or demo["closureRoadId"] not in roads:
        raise ValueError("Invalid demo references")
    start = endpoints[demo["originId"]].get("nodeId", demo["originId"])
    end = endpoints[demo["destinationId"]].get("nodeId", demo["destinationId"])
    demo_paths = [follow_route(roads, route["roadIds"], start) for route in demo["carRoutes"]]
    if start == end or any(not path or path[-1] != end for path in demo_paths):
        raise ValueError("Invalid demo car route")
    shares = [route["percent"] for route in demo["carRoutes"]]
    if len(shares) != 2 or any(share <= 0 for share in shares) or sum(shares) != 100:
        raise ValueError("Demo needs two car routes totaling 100 percent")
    return nodes, roads, endpoints, bus_paths


def reject_duplicate_keys(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError(f"Duplicate JSON key: {key}")
        obj[key] = value
    return obj


PRINCETON_NETWORK = json.loads(
    Path(__file__).with_name("network.json").read_text(encoding="utf-8"),
    object_pairs_hook=reject_duplicate_keys,
)
generated = Path(__file__).with_name("osm-network.json")
if generated.exists():
    PRINCETON_NETWORK = json.loads(generated.read_text(encoding="utf-8"), object_pairs_hook=reject_duplicate_keys)
NODES, ROADS, ENDPOINTS, BUS_PATHS = validate_network(PRINCETON_NETWORK)
STRETCHES, STREET_PICKS, PICK_ROADS = build_stretches(ROADS, NODES)
PICKS_BY_ID = {pick["id"]: pick for pick in STREET_PICKS}
ENDPOINTS.update(PICKS_BY_ID)
ROADS.update((road["id"], road) for road in PICK_ROADS)
ROAD_SPLITS = {pick["roadId"]: (pick["id"] + "_a", pick["id"] + "_b") for pick in STREET_PICKS}

BUS_ROUTES = PRINCETON_NETWORK["busRoutes"]
DEMO = PRINCETON_NETWORK["demo"]
DEFAULT_ORIGIN = DEMO["originId"] if DEMO else next(iter(NODES))
DEFAULT_DESTINATION = DEMO["destinationId"] if DEMO else next(node for node in NODES if node != DEFAULT_ORIGIN)


def endpoint_node(endpoint_id):
    return ENDPOINTS[endpoint_id].get("nodeId", endpoint_id)
