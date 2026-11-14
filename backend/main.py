from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="Princeton Traffic Lab")


@app.get("/api/health")
def health_check():
    return {"status": "ok"}
@app.get("/api/network")
def get_network():
    return {
        "intersections": [
            {"id": "start", "name": "Start", "x": 40, "y": 100},
            {"id": "north", "name": "North", "x": 160, "y": 40},
            {"id": "south", "name": "South", "x": 160, "y": 160},
            {"id": "end", "name": "Destination", "x": 280, "y": 100},
        ],
        "roads": [
            {"id": "road-1", "name": "North A", "from": "start", "to": "north"},
            {"id": "road-2", "name": "North B", "from": "north", "to": "end"},
            {"id": "road-3", "name": "South A", "from": "start", "to": "south"},
            {"id": "road-4", "name": "South B", "from": "south", "to": "end"},
        ],
        "signalIntersections": [],
        "busRoute": None,
    }
class SimulationRequest(BaseModel):
    closedRoadIds: list[str] = Field(default_factory=list)
    extraLanesByRoadId: dict[str, int] = Field(default_factory=dict)
    signals: list[dict] = Field(default_factory=list)
    busShiftPercent: int = 0


def simulate_closures(closed_roads):
    north_route = ("road-1", "road-2")
    south_route = ("road-3", "road-4")
    north_open = closed_roads.isdisjoint(north_route)
    south_open = closed_roads.isdisjoint(south_route)

    north_trips = 120 if north_open else 0
    south_trips = 80 if south_open else 0
    if north_open and not south_open:
        north_trips = 200
    if south_open and not north_open:
        south_trips = 200

    roads = []
    total_travel_minutes = 0.0
    for road in get_network()["roads"]:
        road_id = road["id"]
        closed = road_id in closed_roads
        trips = north_trips if road_id in north_route else south_trips
        ratio = None if closed else trips / 100
        minutes = None if closed else 2 * (1 + 0.15 * ratio**4)

        if minutes is not None:
            total_travel_minutes += trips * minutes

        roads.append({
            "id": road_id,
            "carTrips": trips,
            "travelMinutes": None if minutes is None else round(minutes, 2),
            "congestionRatio": ratio,
            "closed": closed,
        })

    completed_trips = north_trips + south_trips
    return {
        "avgCarTravelMinutes": (
            round(total_travel_minutes / completed_trips, 2)
            if completed_trips else None
        ),
        "unservedCarTrips": 200 - completed_trips,
        "carTripsShiftedToBus": 0,
        "roads": roads,
    }


@app.post("/api/simulate")
def simulate(request: SimulationRequest):
    closed_roads = set(request.closedRoadIds)
    known_roads = {road["id"] for road in get_network()["roads"]}
    if closed_roads - known_roads:
        raise HTTPException(status_code=422, detail="Unknown road ID")

    if request.extraLanesByRoadId or request.signals or request.busShiftPercent:
        raise HTTPException(
            status_code=422,
            detail="This prototype currently supports road closures only.",
        )

    return {
        "baseline": simulate_closures(set()),
        "scenario": simulate_closures(closed_roads),
    }
