from collections import Counter, defaultdict
from typing import Annotated

from pydantic import BaseModel, Field

from .princeton_network import (
    DEFAULT_DESTINATION, DEFAULT_ORIGIN, DEMO, NODES, PRINCETON_NETWORK, ROADS, ROAD_SPLITS, PICKS_BY_ID,
    endpoint_node, follow_route, road_directions,
)

from .custom_bus import CustomBusRoute, plan_custom
from .routing import find_route
from .lane_stretches import LaneStretch
from .street_picks import length

TOTAL_TRIPS = 200
CAPACITY_PER_LANE = 100
FREE_FLOW_MINUTES = 2
SIGNAL_CYCLE_SECONDS = 90
MAX_EXTRA_LANES = 3
ROAD_LENGTHS = {id: length(road["geometry"]) for id, road in ROADS.items()}

SIGNAL_APPROACHES = {}
inbound = defaultdict(list)
for road_id, road in ROADS.items():
    directions = road_directions(road, "car")
    if road.get("parentId"):
        continue
    if 1 in directions:
        inbound[road["to"]].append(road_id)
    if -1 in directions:
        inbound[road["from"]].append(road_id)
for intersection_id in NODES:
    incoming = inbound[intersection_id]
    main_ids = PRINCETON_NETWORK["mainApproaches"].get(intersection_id, incoming)
    SIGNAL_APPROACHES[intersection_id] = {
        "mainRoadIds": [road_id for road_id in incoming if road_id in main_ids],
        "crossRoadIds": [road_id for road_id in incoming if road_id not in main_ids],
    }


class Signal(BaseModel):
    intersectionId: str
    mainGreenShare: float = Field(ge=0.2, le=0.8)


class SimulationRequest(BaseModel):
    closedRoadIds: list[str] = Field(default_factory=list)
    extraLanesByRoadId: dict[str, Annotated[int, Field(ge=0)]] = Field(default_factory=dict)
    laneStretches: list[LaneStretch] = Field(default_factory=list, max_length=24)
    signals: list[Signal] = Field(default_factory=list)
    enabledBusRouteIds: list[str] = Field(default_factory=list)
    busShiftPercent: int = Field(default=0, ge=0, le=50)
    originId: str = DEFAULT_ORIGIN
    destinationId: str = DEFAULT_DESTINATION
    customBusRoutes: list[CustomBusRoute] = Field(default_factory=list, max_length=24)


def car_assignments(origin, destination, closed, demand):
    if DEMO and (origin, destination) == (endpoint_node(DEMO["originId"]), endpoint_node(DEMO["destinationId"])):
        open_routes = [route for route in DEMO["carRoutes"] if closed.isdisjoint(route["roadIds"])]
        if len(open_routes) == 2:
            primary, secondary = open_routes
            primary_trips = (demand * primary["percent"] + 50) // 100
            return [(primary["roadIds"], primary_trips), (secondary["roadIds"], demand - primary_trips)]
        if open_routes:
            return [(open_routes[0]["roadIds"], demand)]

    route = find_route(origin, destination, closed)
    return [(route, demand)] if route is not None else []


def bus_service(request, origin, destination, closed):
    services = []
    shifted = 0
    demand = (TOTAL_TRIPS * request.busShiftPercent + 50) // 100
    for route in request.customBusRoutes:
        enabled = route.id in request.enabledBusRouteIds
        if not enabled:
            continue
        plan = plan_custom(route, closed)
        stops = plan["stopIds"]
        stop_nodes = [endpoint_node(stop) for stop in stops]
        boarding = stops[stop_nodes.index(origin)] if origin in stop_nodes else None
        alighting = stops[stop_nodes.index(destination)] if destination in stop_nodes else None
        serves = bool(boarding and alighting and stops.index(boarding) < stops.index(alighting))
        trip_mismatch = None
        if not serves:
            if boarding and alighting:
                trip_mismatch = "The selected trip runs in the opposite direction."
            elif not boarding and not alighting:
                trip_mismatch = "Neither selected trip endpoint matches a stop."
            elif not boarding:
                trip_mismatch = "The selected From location does not match a stop."
            else:
                trip_mismatch = "The selected To location does not match a stop."
        operating = not plan["error"]
        riders = demand - shifted if operating and serves else 0
        shifted += riders
        services.append({**plan, "id": route.id, "enabled": True, "operating": operating,
                         "servesTrip": serves, "tripMismatch": trip_mismatch, "boardingStopId": boarding,
                         "alightingStopId": alighting, "shiftedTrips": riders,
                         "partialShiftedTrips": 0, "blockedRoadIds": []})
    return services, shifted


def split_route(route, origin, split_ids):
    node = origin
    pieces = []
    for id in route:
        road = ROADS[id]
        forward = road["from"] == node
        if id in split_ids:
            halves = ROAD_SPLITS[id]
            pieces.extend(halves if forward else reversed(halves))
        else:
            pieces.append(id)
        node = road["to"] if forward else road["from"]
    return pieces


def directed_segments(roads, nodes):
    return tuple(zip(roads, nodes, nodes[1:]))


def partial_section(car_path, bus_path):
    """Find the longest contiguous shared section in travel order and direction."""
    bus_positions = defaultdict(list)
    for index, segment in enumerate(bus_path):
        bus_positions[segment].append(index)
    best_start, best_length = 0, 0
    previous = {}
    for index, segment in enumerate(car_path):
        current = {}
        for bus_index in bus_positions.get(segment, ()):
            run = previous.get(bus_index - 1, 0) + 1
            current[bus_index] = run
            if run > best_length:
                best_start, best_length = index - run + 1, run
        previous = current
    return range(best_start, best_start + best_length)


def partial_shifts(route, nodes, trips, services, share, split_ids):
    # The same cohort uses all covered sections on this itinerary. A segment
    # covered by several lines still loses just one cohort of car trips.
    riders = (trips * share + 50) // 100
    car_path = directed_segments(route, nodes)
    covered = set()
    for service in services:
        if not service["operating"] or service["servesTrip"]:
            continue
        start = service["nodeIds"][0]
        bus_roads = split_route(service["roadIds"], start, split_ids)
        bus_path = directed_segments(bus_roads, follow_route(ROADS, bus_roads, start, "bus"))
        match = partial_section(car_path, bus_path)
        if not match:
            continue
        service["servesPartialTrip"] = True
        service["tripMismatch"] = None
        fresh = set(match) - covered
        if fresh:
            service["partialShiftedTrips"] += riders
            covered.update(fresh)
    return covered, riders if covered else 0


def signal_wait(green_share):
    # Uniform arrivals over a fixed cycle. Probability of red times the
    # mean remaining red time, in minutes.
    return SIGNAL_CYCLE_SECONDS / 120 * (1 - green_share) ** 2


def signal_results(signals, arrivals):
    results = []
    for signal in signals:
        intersection_id = signal.intersectionId
        phases = SIGNAL_APPROACHES[intersection_id]
        approaches = []
        total_delay = 0
        for phase, green_share in (
            ("main", signal.mainGreenShare), ("cross", 1 - signal.mainGreenShare)
        ):
            for road_id in phases[f"{phase}RoadIds"]:
                trips = arrivals[intersection_id, road_id]
                wait = signal_wait(green_share)
                total_delay += trips * wait
                approaches.append({
                    "roadId": road_id, "phase": phase, "carTrips": trips,
                    "waitMinutes": round(wait, 3),
                })
        results.append({
            "intersectionId": intersection_id, "approaches": approaches,
            "totalCarDelayMinutes": round(total_delay, 3),
        })
    return results


def run_simulation(request):
    closed = set(request.closedRoadIds)
    origin, destination = endpoint_node(request.originId), endpoint_node(request.destinationId)
    buses, shifted = bus_service(request, origin, destination, closed)
    assignments = car_assignments(origin, destination, closed, TOTAL_TRIPS - shifted)
    pick_ids = [origin, destination, *(point.endpointId for bus in request.customBusRoutes
                if bus.id in request.enabledBusRouteIds for point in bus.points)]
    pick_ids.extend(id for stretch in request.laneStretches for id in (stretch.startId, stretch.endId))
    split_ids = {PICKS_BY_ID[id]["roadId"] for id in pick_ids if id in PICKS_BY_ID}
    assignments = [(split_route(route, origin, split_ids), trips) for route, trips in assignments]
    completed = sum(trips for _, trips in assignments)
    arrivals, forward, reverse = Counter(), Counter(), Counter()
    itinerary_volumes = Counter()
    partial = 0
    for route, trips in assignments:
        nodes = follow_route(ROADS, route, origin)
        covered, riders = partial_shifts(route, nodes, trips, buses, request.busShiftPercent, split_ids)
        partial += riders
        for index, (start, end, road_id) in enumerate(zip(nodes, nodes[1:], route)):
            car_trips = trips - riders if index in covered else trips
            itinerary_volumes[road_id] += trips
            direction = forward if start == ROADS[road_id]["from"] else reverse
            direction[road_id] += car_trips
            arrivals[end, ROADS[road_id].get("parentId", road_id)] += car_trips
        if route:
            # At the origin, modeled demand enters on the phase for its
            # departure corridor. At every other node it pays on arrival.
            first = ROADS[route[0]].get("parentId", route[0])
            if any(first in ids for ids in SIGNAL_APPROACHES.get(origin, {}).values()):
                arrivals[origin, first] += trips - riders if 0 in covered else trips

    roads = []
    total_road_minutes = 0.0
    active_ids = forward.keys() | reverse.keys() | closed | request.extraLanesByRoadId.keys()
    lanes = request.extraLanesByRoadId
    stretch_lanes = Counter()
    for stretch in request.laneStretches:
        for id in stretch.roadIds:
            stretch_lanes.update(ROAD_SPLITS[id] if id in split_ids else [id])
    active_ids |= stretch_lanes.keys()
    for id in split_ids:
        if any(piece in active_ids for piece in ROAD_SPLITS[id]):
            active_ids.update(ROAD_SPLITS[id])
            active_ids.discard(id)
    for road_id in (sorted(active_ids) if PRINCETON_NETWORK.get("coverage") else ROADS):
        road = ROADS[road_id]
        is_closed = road_id in closed or road.get("parentId") in closed
        trips = forward[road_id] + reverse[road_id]
        parent = road.get("parentId", road_id)
        capacity = CAPACITY_PER_LANE * (1 + lanes.get(parent, lanes.get(road.get("laneGroup"), 0)) + stretch_lanes[road_id])
        ratio = None if is_closed else trips / capacity
        minutes = None if is_closed else road.get("freeFlowMinutes", FREE_FLOW_MINUTES) * (1 + 0.15 * ratio**4)
        if minutes is not None:
            # Evaluate the full itinerary at the resulting segment speeds.
            # Partial bus trips remain in the denominator and retain their
            # full route distance. Shuttle journey times are not simulated.
            total_road_minutes += itinerary_volumes[road_id] * minutes
        roads.append({
            "id": road_id, "carTrips": trips, "forwardCarTrips": forward[road_id],
            "reverseCarTrips": reverse[road_id], "closed": is_closed,
            "capacity": capacity,
            "congestionRatio": ratio,
            "travelMinutes": None if minutes is None else round(minutes, 6),
            "effectiveSpeedKph": None if minutes is None else round(ROAD_LENGTHS[road_id] * .06 / minutes, 4),
        })

    for service in buses:
        if service["operating"] and not (service["servesTrip"] or service.get("servesPartialTrip")):
            if service["tripMismatch"] != "The selected trip runs in the opposite direction.":
                service["tripMismatch"] = "No continuous same-direction section shared with the selected car route."

    signals = signal_results(request.signals, arrivals)
    delay = sum(signal["totalCarDelayMinutes"] for signal in signals)
    return {
        "totalCarTrips": TOTAL_TRIPS,
        "completedCarTrips": completed,
        "unservedCarTrips": TOTAL_TRIPS - completed - shifted,
        "carTripsShiftedToBus": shifted,
        "partialBusTrips": partial,
        "avgCarTravelMinutes": round((total_road_minutes + delay) / completed, 2) if completed else None,
        "avgCarSignalWaitMinutes": round(delay / completed, 3) if completed else None,
        "carRoutes": [{"roadIds": route, "carTrips": trips} for route, trips in assignments],
        "signals": signals,
        "busRoutes": buses,
        "roads": roads,
    }


def candidate_scenarios(request, current):
    for road in current["roads"]:
        road_id = road["id"]
        count = request.extraLanesByRoadId.get(road_id, 0)
        if road["carTrips"] and count < MAX_EXTRA_LANES and "parentId" not in ROADS[road_id]:
            yield (
                f"Add one lane on {ROADS[road_id]['name']}",
                request.model_copy(update={"extraLanesByRoadId": {
                    **request.extraLanesByRoadId, road_id: count + 1
                }}),
            )

    for signal in request.signals:
        name = next(node["name"] for node in PRINCETON_NETWORK["intersections"]
                    if node["id"] == signal.intersectionId)
        for share in (0.2, 0.35, 0.5, 0.65, 0.8):
            if share == signal.mainGreenShare:
                continue
            tuned = [existing if existing != signal else signal.model_copy(
                update={"mainGreenShare": share}
            ) for existing in request.signals]
            yield f"Set {name} main green to {share:.0%}", request.model_copy(update={"signals": tuned})

    for service in current["busRoutes"]:
        if not (service["servesTrip"] or service.get("servesPartialTrip")) or service["blockedRoadIds"]:
            continue
        route_id = service["id"]
        if service.get("error"):
            continue
        bus_name = next(route.name for route in request.customBusRoutes if route.id == route_id)
        enabled_ids = list(dict.fromkeys([*request.enabledBusRouteIds, route_id]))
        for share in (20, 35, 50):
            if service["enabled"] and request.busShiftPercent == share:
                continue
            yield (
                f"Run {bus_name} with {share}% switching to bus",
                request.model_copy(update={"enabledBusRouteIds": enabled_ids, "busShiftPercent": share}),
            )


def recommend(request):
    current = run_simulation(request)
    candidates = [("Keep current scenario", request, current)]
    candidates.extend(
        (label, scenario, run_simulation(scenario))
        for label, scenario in candidate_scenarios(request, current)
    )

    def score(candidate):
        metrics = candidate[2]
        minutes = metrics["avgCarTravelMinutes"]
        return metrics["unservedCarTrips"], float("inf") if minutes is None else minutes

    options = []
    previous_score = None
    rank = 0
    for index, candidate in enumerate(sorted(candidates, key=score), start=1):
        label, scenario, metrics = candidate
        if score(candidate) != previous_score:
            rank = index
            previous_score = score(candidate)
        options.append({
            "label": label, "rank": rank, "scenario": scenario.model_dump(),
            "isCurrent": scenario is request,
            **{key: metrics[key] for key in (
                "completedCarTrips", "unservedCarTrips", "carTripsShiftedToBus", "partialBusTrips", "avgCarTravelMinutes"
            )},
        })
    return {"source": "Simulator recommendation", "options": options}
