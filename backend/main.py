from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, Field
from .lane_stretches import LaneEndpoints, lane_nodes, lane_options, validate_stretch
from .custom_bus import CustomBusRoute, plan_custom, validate_custom

from .princeton_network import BUS_ROUTES, DEFAULT_DESTINATION, DEFAULT_ORIGIN, ENDPOINTS, PRINCETON_NETWORK, PICK_ROADS, STREET_PICKS, STRETCHES, endpoint_node
from .simulator import (
    ROADS, SIGNAL_APPROACHES, SIGNAL_CYCLE_SECONDS,
    SimulationRequest, recommend, run_simulation,
)

app = FastAPI(title="Princeton Traffic Lab")
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
    return {
        **PRINCETON_NETWORK,
        "defaults": {"originId": DEFAULT_ORIGIN, "destinationId": DEFAULT_DESTINATION},
        "signalIntersections": list(SIGNAL_APPROACHES),
        "signalApproaches": SIGNAL_APPROACHES, "signalCycleSeconds": SIGNAL_CYCLE_SECONDS,
        "streetStretches": STRETCHES,
        "streetPicks": STREET_PICKS,
        "pickRoads": PICK_ROADS,
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
        for stretch in request.laneStretches:
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
    return {
        "baseline": run_simulation(SimulationRequest(originId=request.originId, destinationId=request.destinationId)),
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


@app.post("/api/lane-preview")
def preview_lane(request: LanePreview):
    if set(request.closedRoadIds) - ROADS.keys():
        raise HTTPException(status_code=422, detail="Unknown closed road ID")
    try:
        start, end = lane_nodes(request)
        return {"options": lane_options(start, end, frozenset(request.closedRoadIds))}
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
