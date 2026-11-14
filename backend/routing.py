"""Directed routing for cars and shuttles on the imported OSM graph."""
from collections import defaultdict
from heapq import heappop, heappush
from math import cos, hypot, radians

from .princeton_network import PRINCETON_NETWORK, ROADS, road_directions

ADJACENCY = {mode: defaultdict(list) for mode in ("car", "bus")}
BARRIERS = PRINCETON_NETWORK.get("barriers", {})
TURNS = defaultdict(list)
VIA = PRINCETON_NETWORK.get("viaWayRestrictions", [])
VIA_STARTS = {way for rule in VIA for way in rule["fromWays"]}
for restriction in PRINCETON_NETWORK.get("turnRestrictions", []):
    TURNS[restriction["node"]].append(restriction)

for road_id, road in ROADS.items():
    # Route by modeled free-flow time on imported data. Preserve geographic
    # weighting for curated pieces whose times are calibrated for the demo.
    cost = road["freeFlowMinutes"] if "osmWay" in road else sum(
        hypot((b[0] - a[0]), (b[1] - a[1]) * cos(radians(a[0]))) * 166.8
        for a, b in zip(road["geometry"], road["geometry"][1:])
    )
    for mode, graph in ADJACENCY.items():
        for direction in road_directions(road, mode):
            src, dst = (road["from"], road["to"]) if direction == 1 else (road["to"], road["from"])
            graph[src].append((dst, road_id, cost))


def way_for(road_id):
    road = ROADS[road_id]
    return road.get("osmWay", road.get("osmWayRef", ""))


def mode_restriction(rule, mode):
    exemption = {"motorcar", "motor_vehicle", "vehicle"} if mode == "car" else {"bus", "psv", "motor_vehicle", "vehicle"}
    return rule.get(mode) or (None if exemption.intersection(rule["except"]) else rule["restriction"])


def legal_turn(node, incoming, outgoing, mode):
    if not incoming:
        return True
    if mode in BARRIERS.get(node, ()):
        return False
    from_way, to_way = way_for(incoming), way_for(outgoing)
    for rule in TURNS[node]:
        if from_way not in rule["fromWays"]:
            continue
        restriction = mode_restriction(rule, mode)
        if not restriction:
            continue
        if restriction == "no_u_turn" and from_way == to_way and ROADS[incoming].get("parentId", incoming) != ROADS[outgoing].get("parentId", outgoing):
            continue
        matches = to_way in rule["toWays"]
        if (restriction.startswith("no_") and matches) or (restriction.startswith("only_") and not matches):
            return False
    return True


def next_via_history(history, way, mode):
    if history and history[-1] == way:
        return history
    for rule in VIA if history else ():
        restriction = mode_restriction(rule, mode)
        if not restriction:
            continue
        for index, previous in enumerate(history):
            if previous not in rule["fromWays"]:
                continue
            following = history[index+1:]
            via = tuple(rule["viaWays"])
            if following != via[:len(following)]:
                continue
            if restriction.startswith("only_"):
                if following == via and way not in rule["toWays"]:
                    return None
            elif following == via and way in rule["toWays"]:
                return None
    candidate = (*history, way)
    for length in range(min(len(candidate), max_via_history), 0, -1):
        prefix = candidate[-length:]
        if prefix in via_prefixes:
            return prefix
    return (way,) if way in VIA_STARTS else ()


via_prefixes = {
    (way, *rule["viaWays"][:length])
    for rule in VIA for way in rule["fromWays"] for length in range(len(rule["viaWays"]) + 1)
}
max_via_history = max(map(len, via_prefixes), default=0)


def find_route(origin, destination, closed, mode="car", incoming=None, previous_roads=(), allowed_roads=None):
    graph = ADJACENCY[mode]
    history = ()
    for road_id in previous_roads:
        history = next_via_history(history, way_for(road_id), mode)
        if history is None:
            return None
    start = (origin, incoming or "", history)
    best, previous = {start: 0}, {}
    pending = [(0, *start)]
    while pending:
        cost, node, arrived_on, history = heappop(pending)
        key = (node, arrived_on, history)
        if cost != best[key]:
            continue
        if node == destination:
            route = []
            while key != start:
                parent, road_id = previous[key]
                route.append(road_id)
                key = parent
            return tuple(reversed(route))
        for next_node, road_id, weight in graph[node]:
            if ((allowed_roads is not None and road_id not in allowed_roads)
                    or road_id in closed or ROADS[road_id].get("parentId") in closed
                    or (ROADS[road_id].get("parentId") and origin not in (node, next_node)
                        and destination not in (node, next_node))
                    or not legal_turn(node, arrived_on, road_id, mode)):
                continue
            next_history = next_via_history(history, way_for(road_id), mode)
            if next_history is None:
                continue
            # Use a string sentinel so tied heap entries always compare cleanly.
            next_key = (next_node, road_id if next_node in TURNS or next_node in BARRIERS else "", next_history)
            next_cost = cost + weight
            if next_cost < best.get(next_key, float("inf")):
                best[next_key] = next_cost
                previous[next_key] = (key, road_id)
                heappush(pending, (next_cost, *next_key))
    return None
