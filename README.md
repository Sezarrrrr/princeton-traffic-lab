# princeton-traffic-lab

## Run on Windows

Install Git for Windows and Python 3.14, then open PowerShell. Confirm that `git --version` and `python --version` work before running the setup.

```powershell
git clone --branch expand-traffic-network https://github.com/Sezarrrrr/princeton-traffic-lab.git
cd princeton-traffic-lab
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Start FastAPI from the repository root in the first PowerShell window.

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

In a second PowerShell window, change to the same repository folder and start the frontend.

```powershell
.\.venv\Scripts\python.exe -m http.server 5501 --bind 127.0.0.1 --directory frontend
```

Open [the real-backend demo](http://127.0.0.1:5501/?api=real). The status should show **13,944 intersections and 18,017 roads**. The checkout includes the five-mile road snapshot, so startup needs no OpenStreetMap import. The street basemap uses online tiles. The **Schematic** view uses the local network.

Search for an intersection or landmark in **From** and **To**, or use **Pick on map** to choose marked junctions. Pin A marks From and pin B marks To. Outside endpoint selection, click an intersection to edit its signal. **Reset** clears changes for the current pair. **Demo: HackPrinceton Let-Out** restores Nassau & Washington → Princeton Station and closes `wash_mid`.

## Expand the network

Edit [backend/network.json](backend/network.json), rerun the import to merge your edits into the offline snapshot, restart FastAPI, and reload the page.

- `intersections` defines graph nodes with stable IDs, schematic `x` and `y`, and `latLng` in latitude, longitude order.
- `roads` references intersection IDs through `from` and `to`. Its `geometry` must include both endpoint coordinates in traversal order. Set `twoWay` to false for one-way travel and `carAccess` to false for car restrictions. Shuttle access inherits car access unless `busAccess` explicitly overrides it.
- `locations` and `busStops` attach a name to the graph through `nodeId`. Use optional `latLng` for a separate marker. Intersection, location and stop IDs share an endpoint namespace.
- `busRoutes` starts at `startNodeId`, follows `roadIds` in traversal order, and lists `stopIds` in boarding-to-alighting order. A shuttle serves a trip when it stops at both endpoint nodes in that order. A closure on any modeled shuttle segment suspends the route.
- `mainApproaches` optionally assigns inbound roads to a node's main green phase. Other inbound car approaches get the remaining green. At nodes without an entry, all inbound car approaches use the main phase.

### Copy-paste example

Run this PowerShell block from the repository root. It adds the mapped continuation of Murray Place north of Aiken, names its endpoint, and extends the East Campus shuttle to a new stop there.

```powershell
@'
import json
from pathlib import Path
from backend.princeton_network import validate_network

path = Path("backend/network.json")
data = json.loads(path.read_text(encoding="utf-8"))
node_id = "int_murray_north"
road_id = "murray_north"
stop_id = "east_campus_murray_north"
if any(node["id"] == node_id for node in data["intersections"]):
    raise SystemExit("The example has already been added.")

start = next(node for node in data["intersections"] if node["id"] == "int_murray_aiken")
end = [40.352679, -74.649754]
data["intersections"].append({
    "id": node_id, "name": "Murray Place north end",
    "x": 895, "y": 45, "latLng": end,
})
data["roads"].append({
    "id": road_id, "name": "Murray Place (north of Aiken)",
    "from": start["id"], "to": node_id, "twoWay": True,
    "geometry": [start["latLng"], [40.351539, -74.648998], [40.352615, -74.649711], end],
})
data["locations"].append({
    "id": "upper_murray", "name": "Upper Murray Place", "nodeId": node_id,
    "latLng": [40.352677, -74.649820],
})
data["busStops"].append({
    "id": stop_id, "name": "East Campus shuttle stop at Upper Murray Place",
    "nodeId": node_id,
})
route = next(route for route in data["busRoutes"] if route["id"] == "east_campus_shuttle")
route["roadIds"].append(road_id)
route["stopIds"].append(stop_id)

validate_network(data)
path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
'@ | .venv/Scripts/python.exe -B -
```

Rerun the import, restart FastAPI, then search **Upper Murray Place** in either endpoint field or choose its marker on the map.

## Import the five-mile area

Run from the repository root in PowerShell.

```powershell
.venv/Scripts/python.exe -B tools/import_osm.py --center 40.350392 -74.657115 --radius-miles 5
```

The importer downloads tiled OpenStreetMap XML, validates the graph, and atomically replaces [backend/osm-network.json](backend/osm-network.json). The demo loads that local file on startup. You can reuse saved XML tiles with `--input PATH [PATH ...]` or use Overpass with `--overpass [URL]`. Use `--output PATH` to inspect a different import without replacing the demo's snapshot. The browser's Street map uses online basemap tiles and the schematic uses the locally imported graph.

Road IDs use the OSM way and segment endpoint IDs. Boundary IDs use the original OSM edge's node IDs and crossing side. Polylines are clipped to the radius and connections use shared OSM nodes. The importer keeps the curated IDs where possible and splits curated roads at imported junctions. A lane added on a retained original road ID applies to its pieces, which preserves the Station demo. The generated file records the source, import time, center, radius, and restriction counts.

The snapshot covers roads mapped by OSM as open to public cars or shuttles, including tagged public service roads. The routing model uses static access and direction tags, mapped barriers, node-based turn restrictions and in-graph via-way restrictions. It omits private and destination-only access, tracks without explicit motor access, and conditional schedules, vehicle dimensions and weight limits. Coverage reflects the source data and routes stay within the imported area. Attribution and license: [OpenStreetMap contributors](https://www.openstreetmap.org/copyright).

## Create a shuttle route

In **Bus routes**, click **Create Bus Route**, name the line, and click marked street junctions for its start and end stops. Use **Change** beside either stop to pick a replacement. The backend previews the drivable path with current closures. Saving enables the line and stores it in the current browser. Edit, toggle, or delete each line independently. Click a line name to zoom to its stops and highlight its path. Older saved routes with intermediate stops or waypoints load as two-stop lines using their original first and last stops.

Traffic colors compare each segment's simulated travel time with its original travel time for the same trip. Green means faster, red means slower, and slate means unchanged. Bus lines use their own dashed overlays.

Use **Add Lane on Map** under **Your changes** to pick a start and an end on the same street. Choose an alignment if the preview lists several, then confirm. The start and end are existing street junctions. Undo the entire stretch from **Your changes**, or use the existing **Add a lane** shortcut on an individual segment.

Matching bus stops can replace a whole trip. When a two-stop bus line shares a continuous section of a car route in the same direction, the shift percentage reduces car volume on the longest shared section. The modeled transfer can start or end at a shared junction along the bus path, while the line keeps its two configured stops. The same cohort counts once per car itinerary and a road section gets one reduction even if several lines cover it. Partial riders stay in the completed-trip total. The average uses the full route at the resulting road speeds, with signal wait charged to car traffic. A custom shuttle recalculates a blocked path between its stops. An unreachable line is suspended. Use **Show import area** to see the boundary and zoom in to select individual roads and junctions.

## Sources and simulation assumptions

The downtown extension links Nassau Street to Witherspoon, Spring, South and North Tulane, Wiggins, Vandeventer, Park Place and Moore. The [Princeton one-way ordinance](https://ecode360.com/36793253) confirms northbound travel on Witherspoon from Nassau to Spring and on South Tulane, and eastbound travel on Spring. The other added links allow travel in both directions. Geometry and access tags come from OpenStreetMap. [Witherspoon](https://www.openstreetmap.org/way/11643172) · [Upper Witherspoon](https://www.openstreetmap.org/way/1018454105) · [Spring](https://www.openstreetmap.org/way/11646580) · [South Tulane](https://www.openstreetmap.org/way/11645746) · [North Tulane](https://www.openstreetmap.org/way/11645785) · [Wiggins west](https://www.openstreetmap.org/way/11648343) · [Wiggins east](https://www.openstreetmap.org/way/365793300) · [Vandeventer south](https://www.openstreetmap.org/way/1577571064) · [Vandeventer north](https://www.openstreetmap.org/way/362613428) · [Park Place](https://www.openstreetmap.org/way/11644185) · [Moore](https://www.openstreetmap.org/way/11643269).

The Princeton Public Library, Spring Street Garage and Princeton Garden Theatre markers attach to nearby public intersections. The Nassau segments were split at real junctions, retaining their original IDs on the portions that start at Washington. The model divides the original free-flow time among the pieces and traverses all of them on the original Station corridor.

The geometry and access tags for the expansion come from OpenStreetMap, including [William Street](https://www.openstreetmap.org/way/11641569), [Prospect Avenue](https://www.openstreetmap.org/way/581731352), [Murray Place](https://www.openstreetmap.org/way/11644044), and [Aiken Avenue](https://www.openstreetmap.org/way/11641254). The [Princeton one-way ordinance](https://ecode360.com/36793255) specifies southbound Charlton Street from Nassau to William. The Engineering Quadrangle and Friend Center use Olden & William as their graph access point. [Princeton Engineering directions](https://engineering.princeton.edu/about/visitors) · [Friend Center directions](https://ece.princeton.edu/academics/graduate/visit-day-directions).

The model assumes 200 trips, 100 cars of capacity per modeled lane, two minutes of free-flow time per segment unless specified, and a 90-second signal cycle. The Princeton Station demo retains its 60/40 assignment while both corridors are open. Other car trips use the fewest open, car-accessible road segments in the permitted direction. Shuttle routes, stops and shift percentages are simulation assumptions. **Find the Best Fix** compares individual changes by trip coverage, then average car time.
