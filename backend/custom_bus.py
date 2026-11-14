from functools import lru_cache
from pydantic import BaseModel, Field

from .princeton_network import ENDPOINTS, ROADS, endpoint_node, follow_route
from .routing import find_route


class BusPoint(BaseModel):
    endpointId: str
    stop: bool = True


class CustomBusRoute(BaseModel):
    id: str = Field(pattern=r"^custom_[a-z0-9_]{1,80}$")
    name: str = Field(min_length=1, max_length=80)
    points: list[BusPoint] = Field(min_length=2)


def validate_custom(route):
    if not route.name.strip() or not all(point.stop for point in route.points):
        raise ValueError("Enter a name and choose at least two stops.")
    for point in route.points:
        if point.endpointId not in ENDPOINTS:
            raise ValueError(f"Unknown route point: {point.endpointId}")
    stops = [endpoint_node(point.endpointId) for point in route.points if point.stop]
    if len(stops) != len(set(stops)):
        raise ValueError("Use different road junctions for each stop.")


@lru_cache(maxsize=128)
def plan_points(points, closed):
    roads, nodes = [], [endpoint_node(points[0])]
    legs, errors = [], []
    for index, (left, right) in enumerate(zip(points, points[1:]), start=1):
        start, end = endpoint_node(left), endpoint_node(right)
        path = find_route(start, end, closed, "bus", roads[-1] if roads else None, roads)
        error = None
        if path is None:
            error = f"Stops {index} → {index + 1}: no legal shuttle path from {ENDPOINTS[left]['name']} to {ENDPOINTS[right]['name']}."
            errors.append(error)
            roads.clear()
        else:
            roads.extend(path)
            nodes.extend(follow_route(ROADS, path, start, "bus")[1:])
        legs.append({"roadIds": path or (), "error": error})
    if errors:
        return (), (), " ".join(errors), tuple(legs)
    return tuple(roads), tuple(nodes), None, tuple(legs)


def plan_custom(route, closed):
    validate_custom(route)
    ids = tuple(point.endpointId for point in route.points)
    path, nodes, error, legs = plan_points(ids, frozenset())
    detoured = False
    if closed and (error or any(id in closed or ROADS[id].get("parentId") in closed for id in path)):
        original = path
        path, nodes, error, legs = plan_points(ids, frozenset(closed))
        detoured = not error and path != original
    return {"roadIds": path, "nodeIds": nodes, "error": error, "detoured": detoured,
            "stopIds": ids, "legs": legs}
