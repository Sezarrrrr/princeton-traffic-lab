"""Display stretches and routable picking points for the street map."""
from collections import defaultdict
from math import cos, hypot, radians


def distance(a, b):
    return hypot(b[0] - a[0], (b[1] - a[1]) * cos(radians((a[0] + b[0]) / 2))) * 111195


def length(points):
    return sum(distance(a, b) for a, b in zip(points, points[1:]))


def build_stretches(roads, nodes):
    incident = defaultdict(list)
    for road in roads.values():
        for node in (road["from"], road["to"]):
            incident[node].append(road["id"])

    def next_road(node, road_id):
        ids = incident[node]
        if len(ids) != 2:
            return None
        other = ids[0] if ids[1] == road_id else ids[1]
        keys = ("bridge", "tunnel", "layer")
        if any(roads[other].get(key) != roads[road_id].get(key) for key in keys):
            return None
        return other

    remaining = set(roads)
    stretches, picks, parts = [], [], []
    for seed in roads:
        if seed not in remaining:
            continue
        # Grow in both directions. The seed uses the original road orientation.
        remaining.remove(seed)
        left, right = roads[seed]["from"], roads[seed]["to"]
        prefix, suffix = [], []
        for node, target, prepend in ((left, prefix, True), (right, suffix, False)):
            prev = seed
            while (other := next_road(node, prev)) in remaining:
                remaining.remove(other)
                road = roads[other]
                forward = road["from"] == node
                target.append((other, not forward if prepend else forward))
                node = road["to"] if forward else road["from"]
                prev = other
        members = [*reversed(prefix), (seed, True), *suffix]
        # Keep original geometry coordinates, including curves and shared vertices.
        paths = [roads[id]["geometry"] if forward else roads[id]["geometry"][::-1]
                 for id, forward in members]
        points = paths[0] + [point for path in paths[1:] for point in path[1:]]
        stretches.append(points)

        # Keep the pick in the interior of a traversable routing segment.
        lengths = [length(path) for path in paths]
        if not any(lengths):
            continue
        target = sum(lengths) / 2
        for (road_id, forward), segment_length in zip(members, lengths):
            if target <= segment_length and segment_length > 0:
                break
            target -= segment_length
        road = roads[road_id]
        if road.get("carAccess", True) is False and not road.get("busAccess"):
            continue
        target = target if forward else segment_length - target
        target = max(segment_length * .01, min(segment_length * .99, target))
        path = road["geometry"]
        offset = 0
        for index, (a, b) in enumerate(zip(path, path[1:])):
            span = distance(a, b)
            if span and offset + span >= target:
                fraction = (target - offset) / span
                point = [a[i] + fraction * (b[i] - a[i]) for i in range(2)]
                break
            offset += span
        pick_id = "pick_" + road_id
        ratio = target / segment_length
        src, dst = nodes[road["from"]], nodes[road["to"]]
        picks.append({"id": pick_id, "name": road["name"] + " · road midpoint",
                      "latLng": point, "roadId": road_id,
                      "x": src["x"] + ratio * (dst["x"] - src["x"]),
                      "y": src["y"] + ratio * (dst["y"] - src["y"])})
        for side, start, end, shape, share in (
            ("a", road["from"], pick_id, path[:index+1] + [point], ratio),
            ("b", pick_id, road["to"], [point] + path[index+1:], 1-ratio),
        ):
            parts.append({**road, "id": pick_id + "_" + side, "parentId": road_id,
                          "from": start, "to": end, "geometry": shape,
                          "freeFlowMinutes": road.get("freeFlowMinutes", 2) * share})
    return stretches, picks, parts
