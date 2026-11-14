"""Plan and validate one-lane additions bounded by two map points."""
from collections import defaultdict
from functools import lru_cache

from pydantic import BaseModel, Field

from .princeton_network import ENDPOINTS, PICKS_BY_ID, ROADS, endpoint_node, follow_route, road_directions
from .routing import find_route, legal_turn, next_via_history, way_for
from .street_picks import length


class LaneEndpoints(BaseModel):
    startId: str
    endId: str


class LaneStretch(LaneEndpoints):
    roadIds: list[str] = Field(min_length=1, max_length=2000)


def street_name(road):
    return road["name"].split(" (", 1)[0]


STREETS = defaultdict(set)
STREETS_AT = defaultdict(set)
for road_id, road in ROADS.items():
    if not road_directions(road, "car"):
        continue
    key = street_name(road).casefold()
    STREETS[key].add(road_id)
    STREETS_AT[road["from"]].add(key)
    STREETS_AT[road["to"]].add(key)


def lane_nodes(endpoints):
    if endpoints.startId not in ENDPOINTS or endpoints.endId not in ENDPOINTS:
        raise ValueError("Choose two points on the road network.")
    a, b = endpoint_node(endpoints.startId), endpoint_node(endpoints.endId)
    if a == b:
        raise ValueError("Choose an end point different from the start.")
    return a, b


def common_streets(start, end):
    streets = STREETS_AT[start] & STREETS_AT[end]
    if start in PICKS_BY_ID:
        key = street_name(ROADS[PICKS_BY_ID[start]["roadId"]]).casefold()
        return streets & {key}
    return streets


@lru_cache(maxsize=64)
def lane_options(start, end, closed):
    candidates = {}
    boundary_parents = {PICKS_BY_ID[id]["roadId"] for id in (start, end) if id in PICKS_BY_ID}
    for key in sorted(common_streets(start, end)):
        allowed = STREETS[key] - boundary_parents
        for src, dst in ((start, end), (end, start)):
            path = find_route(src, dst, closed, allowed_roads=allowed)
            if not path:
                continue
            alternatives = [path]
            # A second alignment can diverge at any edge of the shortest one.
            for edge in path:
                other = find_route(src, dst, closed | {edge}, allowed_roads=allowed)
                if other:
                    alternatives.append(other)
            for option in alternatives:
                if len(option) > 2000:
                    continue
                distance = sum(length(ROADS[id]["geometry"]) for id in option)
                # Omit duplicate reverse traversals of the same physical stretch.
                signature = frozenset(option)
                candidates.setdefault(signature, {
                    "street": street_name(ROADS[option[0]]), "roadIds": option,
                    "distanceMeters": round(distance),
                })
    return sorted(candidates.values(), key=lambda option: option["distanceMeters"])[:5]


def validate_stretch(stretch):
    start, end = lane_nodes(stretch)
    ids = stretch.roadIds
    if len(set(ids)) != len(ids) or any(id not in ROADS for id in ids):
        raise ValueError("Invalid lane stretch.")
    keys = common_streets(start, end)
    if not any(set(ids) <= STREETS[key] for key in keys):
        raise ValueError("Choose an endpoint on the same street.")
    if any(PICKS_BY_ID[id]["roadId"] in ids for id in (start, end) if id in PICKS_BY_ID):
        raise ValueError("The lane stretch cannot extend beyond a mid-block endpoint.")
    if any(ROADS[id].get("parentId") and not
           {ROADS[id]["from"], ROADS[id]["to"]}.intersection((start, end)) for id in ids):
        raise ValueError("A mid-block boundary must be a selected endpoint.")
    for src, dst in ((start, end), (end, start)):
        nodes = follow_route(ROADS, ids, src)
        if not nodes or nodes[-1] != dst or len(set(nodes)) != len(nodes):
            continue
        history = ()
        incoming = None
        for node, id in zip(nodes, ids):
            if not legal_turn(node, incoming, id, "car"):
                break
            history = next_via_history(history, way_for(id), "car")
            if history is None:
                break
            incoming = id
        else:
            return
    raise ValueError("The lane stretch must follow connected, drivable road segments.")
