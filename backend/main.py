from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, Field
from .lane_stretches import LaneEndpoints, lane_nodes, lane_options, validate_stretch
from .custom_bus import CustomBusRoute, plan_custom, validate_custom

from .princeton_network import BUS_ROUTES, DEFAULT_DESTINATION, DEFAULT_ORIGIN, ENDPOINTS, PRINCETON_NETWORK, PICK_ROADS, ROAD_SPLITS, STREET_PICKS, STRETCHES, endpoint_node, road_directions
from .speed_limits import speed_record
from .simulator import (
    CAPACITY_PER_LANE, DEFAULT_TRIPS, MAX_TRIPS, MODELED_BASE_LANES, ROADS, SIGNAL_APPROACHES, SIGNAL_CYCLE_SECONDS,
    SimulationRequest, recommend, run_simulation,
)

app = FastAPI(title="Traffix Lab")
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5501", "http://localhost:5501"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.get("/api/health")
def health_check():
    return {"status": "ok"}


@app.get("/api/network")
def get_network():
    coverage = {"sourced": 0, "fallback": 0, "mixed": 0, "noCarAccess": 0}
    for road in PRINCETON_NETWORK["roads"]:
        sources = [bool(speed_record(road, direction).get("url")) for direction in road_directions(road, "car")]
        kind = "noCarAccess" if not sources else "sourced" if all(sources) else "mixed" if any(sources) else "fallback"
        coverage[kind] += 1
    return {
        **PRINCETON_NETWORK,
        "defaults": {"originId": DEFAULT_ORIGIN, "destinationId": DEFAULT_DESTINATION},
        "signalIntersections": list(SIGNAL_APPROACHES),
        "signalApproaches": SIGNAL_APPROACHES, "signalCycleSeconds": SIGNAL_CYCLE_SECONDS,
        "streetStretches": STRETCHES,
        "streetPicks": STREET_PICKS,
        "pickRoads": PICK_ROADS,
        "modeledBaseLanes": MODELED_BASE_LANES,
        "modeledBaseCapacity": MODELED_BASE_LANES * CAPACITY_PER_LANE,
        "tripDemand": {"default": DEFAULT_TRIPS, "max": MAX_TRIPS},
        "speedLimitCoverage": coverage,
        "busRoutes": [],
        "busStops": [],
    }


def validate(request):
    if (set(request.closedRoadIds) | set(request.extraLanesByRoadId)) - ROADS.keys():
        raise HTTPException(status_code=422, detail="Unknown road ID")
    if request.originId not in ENDPOINTS or request.destinationId not in ENDPOINTS:
        raise HTTPException(status_code=422, detail="Unknown trip endpoint")
    if endpoint_node(request.originId) == endpoint_node(request.destinationId):
        raise HTTPException(status_code=422, detail="Choose different points for From and To")
    try:
        for stretch in [*request.laneStretches, *request.speedStretches]:
            validate_stretch(stretch)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    custom_ids = set()
    for route in request.customBusRoutes:
        try:
            validate_custom(route)
            if route.id in custom_ids:
                raise ValueError("Duplicate custom bus route ID.")
            custom_ids.add(route.id)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
    preset_ids = {route["id"] for route in BUS_ROUTES}
    request.enabledBusRouteIds = [id for id in request.enabledBusRouteIds if id not in preset_ids]
    if set(request.enabledBusRouteIds) - custom_ids:
        raise HTTPException(status_code=422, detail="Unknown bus route ID")
    ids = [signal.intersectionId for signal in request.signals]
    if set(ids) - SIGNAL_APPROACHES.keys():
        raise HTTPException(status_code=422, detail="Unknown signal intersection")
    if len(ids) != len(set(ids)):
        raise HTTPException(status_code=422, detail="Use one signal per intersection")


@app.post("/api/simulate")
def simulate(request: SimulationRequest):
    validate(request)
    edited_roads = set(request.extraLanesByRoadId)
    edited_roads.update(id for stretch in [*request.laneStretches, *request.speedStretches]
                        for id in stretch.roadIds)
    return {
        "baseline": run_simulation(SimulationRequest(originId=request.originId, destinationId=request.destinationId,
                                                     tripDemand=request.tripDemand),
                                   report_roads=edited_roads),
        "scenario": run_simulation(request),
    }


@app.post("/api/recommend")
def recommend_fix(request: SimulationRequest):
    validate(request)
    return recommend(request)


class BusPreview(BaseModel):
    route: CustomBusRoute
    closedRoadIds: list[str] = Field(default_factory=list)


@app.post("/api/bus-preview")
def preview_bus(request: BusPreview):
    if set(request.closedRoadIds) - ROADS.keys():
        raise HTTPException(status_code=422, detail="Unknown road ID")
    try:
        return plan_custom(request.route, set(request.closedRoadIds))
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


class LanePreview(LaneEndpoints):
    closedRoadIds: list[str] = Field(default_factory=list)


class RoadEditDetails(BaseModel):
    scenario: SimulationRequest
    laneIndex: int | None = Field(default=None, ge=0)
    speedIndex: int | None = Field(default=None, ge=0)
    extraLaneRoadId: str | None = None


@app.post("/api/road-edit-details")
def road_edit_details(request: RoadEditDetails):
    scenario = request.scenario
    validate(scenario)
    if sum(key is not None for key in (request.laneIndex, request.speedIndex, request.extraLaneRoadId)) != 1:
        raise HTTPException(status_code=422, detail="Choose one road edit to compare.")
    if request.extraLaneRoadId is not None:
        road_id = request.extraLaneRoadId
        if not scenario.extraLanesByRoadId.get(road_id):
            raise HTTPException(status_code=422, detail="Lane edit not found.")
        road_ids = [road_id]
        extra_lanes = {id: count for id, count in scenario.extraLanesByRoadId.items() if id != road_id}
        without_edit = scenario.model_copy(update={"extraLanesByRoadId": extra_lanes})
    else:
        field, index = ("laneStretches", request.laneIndex) if request.laneIndex is not None else ("speedStretches", request.speedIndex)
        stretches = getattr(scenario, field)
        if index >= len(stretches):
            raise HTTPException(status_code=422, detail="Road edit not found.")
        road_ids = stretches[index].roadIds
        without_edit = scenario.model_copy(update={field: stretches[:index] + stretches[index + 1:]})

    after = {road["id"]: road for road in run_simulation(scenario, report_roads=road_ids)["roads"]}
    # Report the same pieces in both results when either boundary splits a road.
    split_parents = {ROADS[id]["parentId"] for id in after if "parentId" in ROADS[id]}
    segments = [piece for id in road_ids for piece in (ROAD_SPLITS[id] if id in split_parents else [id])]
    before = {road["id"]: road for road in run_simulation(
        without_edit, report_roads=segments, report_splits=split_parents)["roads"]}
    return [{"id": id, "before": before[id], "after": after[id]} for id in segments]


@app.post("/api/lane-preview")
def preview_lane(request: LanePreview):
    if set(request.closedRoadIds) - ROADS.keys():
        raise HTTPException(status_code=422, detail="Unknown closed road ID")
    try:
        start, end = lane_nodes(request)
        return {"options": lane_options(start, end, frozenset(request.closedRoadIds))}
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
