from fastapi import FastAPI

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
