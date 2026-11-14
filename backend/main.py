from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .princeton_network import PRINCETON_NETWORK

app = FastAPI(title="Traffix Lab")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5501", "http://localhost:5501"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
ROUTE_A = ("wash_north", "wash_mid", "wash_south", "faculty_rd", "alex_station")
ROUTE_B = ("nassau_west", "nassau_mercer", "alex_north")
BASELINE_TRIPS = {ROUTE_A: 120, ROUTE_B: 80}
TOTAL_TRIPS = sum(BASELINE_TRIPS.values())


class SimulationRequest(BaseModel):
    closedRoadIds: list[str] = Field(default_factory=list)
    extraLanesByRoadId: dict[str, int] = Field(default_factory=dict)
    signals: list[dict] = Field(default_factory=list)
    busShiftPercent: int = 0


@app.get("/api/health")
def health_check():
    return {"status": "ok"}


@app.get("/api/network")
def get_network():
    return PRINCETON_NETWORK


def run_simulation(closed_roads, extra_lanes):
    open_routes = [
        route for route in BASELINE_TRIPS if closed_roads.isdisjoint(route)
    ]
    trips_by_road = {road["id"]: 0 for road in PRINCETON_NETWORK["roads"]}
    completed_trips = 0

    for route in open_routes:
        trips = TOTAL_TRIPS if len(open_routes) == 1 else BASELINE_TRIPS[route]
        completed_trips += trips
        for road_id in route:
            trips_by_road[road_id] += trips

    roads = []
    total_travel_minutes = 0.0
    for road in PRINCETON_NETWORK["roads"]:
        road_id = road["id"]
        closed = road_id in closed_roads
        trips = trips_by_road[road_id]
        capacity = 100 * (1 + extra_lanes.get(road_id, 0))
        ratio = None if closed else trips / capacity
        minutes = None if ratio is None else 2 * (1 + 0.15 * ratio**4)

        if minutes is not None:
            total_travel_minutes += trips * minutes

        roads.append({
            "id": road_id,
            "carTrips": trips,
            "travelMinutes": None if minutes is None else round(minutes, 2),
            "congestionRatio": ratio,
            "closed": closed,
        })

    return {
        "totalCarTrips": TOTAL_TRIPS,
        "completedCarTrips": completed_trips,
        "avgCarTravelMinutes": (
            round(total_travel_minutes / completed_trips, 2)
            if completed_trips else None
        ),
        "unservedCarTrips": TOTAL_TRIPS - completed_trips,
        "carTripsShiftedToBus": 0,
        "roads": roads,
    }


@app.post("/api/simulate")
def simulate(request: SimulationRequest):
    closed_roads = set(request.closedRoadIds)
    extra_lanes = request.extraLanesByRoadId
    known_roads = {road["id"] for road in PRINCETON_NETWORK["roads"]}

    if (closed_roads | set(extra_lanes)) - known_roads:
        raise HTTPException(status_code=422, detail="Unknown road ID")
    if any(lanes < 0 for lanes in extra_lanes.values()):
        raise HTTPException(status_code=422, detail="Extra lanes must be zero or more")
    if request.signals or request.busShiftPercent:
        raise HTTPException(status_code=422, detail="Signals and bus service are not supported yet")

    return {
        "baseline": run_simulation(set(), {}),
        "scenario": run_simulation(closed_roads, extra_lanes),
    }
