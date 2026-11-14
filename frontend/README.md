# Princeton Traffic Lab: Frontend

Plain HTML, CSS, and vanilla JavaScript, plus **Leaflet** for the street map. No build step.

## Credits

| What | Used for | License |
|---|---|---|
| [Leaflet](https://leafletjs.com) 1.9.4, loaded from unpkg | Interactive street map: panning, zooming, drawing road overlays and markers | BSD-2-Clause |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) tiles (`tile.openstreetmap.org`) | Basemap under the roads. Attribution "© OpenStreetMap contributors" is always shown on the map | Tiles: OSMF tile usage policy |
| OpenStreetMap data via the [Overpass API](https://overpass-api.de) | Real street shapes for each simulation road, intersection points, and the Julis Romo Rabinowitz Building location (`geo/princeton-geo.js`) | © OpenStreetMap contributors, ODbL |

Everything else in `frontend/` was written by our team during HackPrinceton Fall 2026: the map overlays, car animation, controls, and panels.

## Run it

Serve the folder from the repo root:

```bash
py -m http.server 5500 --directory frontend
```

Then open http://localhost:5500. You can also double-click `frontend/index.html`.

- **In-browser simulator (default):** `sim/engine.js` runs the expanded network (`geo/princeton-network.js`, 27 intersections and 39 roads) with custom trips, intersection controls and road settings. It replaced the old `mock/` files and uses the same request and response format, plus extra fields.
- **Backend mode:** open `http://localhost:5500/?api=real` to call the FastAPI server at `http://localhost:8000` (set in `api.js`). The backend must allow CORS for the page to reach it. The backend covers the 10-road core network with closures and extra lanes, so the trip, control and assumption panels say they need the in-browser simulator.

- **Views:** the street map is the default. Add `?view=schematic` to start in the schematic view, or `?tiles=test-fail` to rehearse what happens when map tiles can't load.

## Features

### In-browser simulator (`ben-test` branch)

- **Expanded road network.** 27 intersections and 39 road segments around downtown and campus, built from OpenStreetMap by `geo/tools/build_network.py`. It adds Witherspoon St, Vandeventer Ave, Wiggins St, Moore St, Chambers St, Paul Robeson Pl, Hulfish St, Palmer Square East/West, William St, Charlton St, Olden St, Harrison St, Elm Dr, Nassau St east to Harrison St, and Prospect Ave east to Harrison St.
  - Core road IDs are kept where a segment matches a core road (`wash_mid`, `wash_south`, `alex_north`, `alex_station`, `nassau_mercer`, `prospect_ave`, `univ_place`). Where new junctions split a core road, the pieces are `nassau_west_1..3`, `wash_north_1..2` and `faculty_rd_1..2`.
  - Lanes, one-way streets and speed limits come from OSM tags where present. Otherwise the defaults are 25 mph and 1 lane each way.
- **Custom trips between two points.** In the **Trips** card:
  - Choose a start (A) and an end (B) from 13 OSM places, your own places, or any intersection, or click **Pick on map** and then click anywhere on the street map.
  - Points snap to the nearest intersection, and a dashed line shows the snap.
  - Set the number of cars and an optional name. Tick "only in the modified scenario" to test new traffic.
  - Each trip shows its original → modified time. Selecting a trip draws the modified route in solid purple and the original route dashed, and lists the roads it uses.
  - Pins you drop appear under **Your places**, where you can rename or delete them.
- **Intersection controls.** Click any intersection and choose **No control, Two-way stop, All-way stop, Traffic signal or Roundabout**. The map shows a signal, stop-sign or roundabout icon.
  - Signals have:
    - **cycle length** (40–180 s)
    - **main-street green share** (20–80%)
    - **main street** (which street gets the main green)
    - **yellow + all-red per phase** (2–8 s)
    - an optional **pedestrian walk phase** (0–40 s, all cars stop)
  - A phase bar shows the split.
  - Two-way stops let you choose which street doesn't stop.
  - The panel shows the cars and the average wait for each road entering the intersection, original → modified.
- **Road settings.** Besides closing a road and adding lanes, you can:
  - change the **speed limit** (10–45 mph)
  - make the road **one-way** in either direction
  - **allow cars** on University Place, which has no car access in the shared network.
  
  The panel also shows cars and travel time for each direction.
- **Assumptions card.** Applies to both columns:
  - let-out size (0–600 cars)
  - background traffic (0–200%)
  - lane capacity
  - seconds per car at all-way stops
  
  **Reset** clears road, intersection and bus changes, but keeps trips and assumptions. Each of those has its own remove or restore button.
- **Results.** "Original vs. modified" adds the average time spent waiting at junctions. Cars on the street map now drive in both directions on the right-hand side, each direction at its own simulated speed.

### Shared with backend mode

- **Street map (default).** A Leaflet map with OpenStreetMap tiles, centered on Princeton University and downtown. It fills most of the screen, and the "Original vs. modified" results stay pinned at the top of the side panel.
  - **"You are here"** marker at the Julis Romo Rabinowitz Building, the HackPrinceton venue.
  - **Road overlays follow the real streets.** Each road ID in `GET /api/network` is drawn using `geo/princeton-geo.js`, which holds `[lat, lon]` points keyed by the same road IDs. Connectors are drawn in full with their turns; for example, `nassau_mercer` goes west on Nassau St, then south on Mercer St. Click a road overlay or intersection to select it. Hovering shows the name.
  - **Top-down car icons** drive along the road curves and turn with the street. They move slower on congested roads (speed follows `travelMinutes`), disappear from closed roads, and get fewer or more with `carTrips`. They're only a visualization: every number comes from the simulation. Cars shrink when you zoom out.
  - The API's `x`/`y` values are schematic and are only used by the schematic view.
- **Schematic view (demo fallback).** The original SVG diagram, drawn from the API's `x`/`y`. Use the "Street map / Schematic" switch above the map. If Leaflet or the map tiles can't load (for example, no Wi-Fi at the venue), the page switches to the schematic automatically and says why. All controls work the same in both views.
- **Map from data.** Every intersection and road comes from `GET /api/network`. Street names and IDs aren't hard-coded, so the network can be swapped. A road with no street geometry still appears in the schematic view, and the page says so.
- **Roads.** Click a road to see its car trips, travel time, and volume/capacity, original vs. modified. You can then:
  - **Close road** / **Reopen road** (sent as `closedRoadIds`)
  - add or remove **extra lanes**, 0–3 (sent as `extraLanesByRoadId`; wider lines show added lanes)
- **Signals.** Intersections listed in `signalIntersections` have an orange ring. Click one to **Add signal** and set the **main road green time**, 20–80% (sent as `signals[].mainGreenShare`, a fraction). A traffic-light icon marks active signals.
- **Bus.** If `busRoute` isn't null, you can turn on the bus route and choose the **% of car trips switching to bus**, 0–50% (sent as `busShiftPercent`). The route is drawn as a blue dotted line. If `busRoute` is null, the panel says "No bus route available yet."
- **Combine changes.** "Your changes" lists every active change, each with **Undo**. **Reset** sends `[]`, `{}`, `[]`, `0`.
- **Original vs. modified.** Shows average car trip time ("No completed trips." when null), unserved car trips, and trips shifted to bus. When the backend sends them, it also shows completed and total trips, plus a trip-conservation check: completed + unserved + bus = total.
- **Where the trips went.** Lists the roads whose car trips changed, ordered from biggest gain to biggest loss.
- **Road colors.** Colors come from the backend's `congestionRatio`: green < 0.8, yellow 0.8–1.0, red > 1.0. Closed roads are dashed grey with an ✕.
- **Animated cars (optional).** Purely visual: car icons on the street map, dots on the schematic. They can be turned off, and are off by default for users who prefer reduced motion.
- **Demo preset.** "Demo: HackPrinceton Let-Out" resets everything and closes `wash_mid`, following `demo/demo-script.md`. It only appears if that road exists.
- **Errors.** If the backend rejects a change (for example, a feature it doesn't support yet), the change is undone and the error is shown at the top.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page layout, loads Leaflet |
| `styles.css` | Styling, layout, road colors, map symbols, car and venue icons |
| `app.js` | Controls, panels, schematic SVG view, view switching and fallback |
| `street-map.js` | Leaflet street map: tiles, road overlays, venue marker, car icons |
| `geo/princeton-geo.js` | Real `[lat, lon]` street geometry keyed by road and intersection IDs |
| `geo/princeton-network.js` | Expanded network for the in-browser simulator: intersections, roads (lanes, one-way, speed, length), default controls |
| `geo/tools/*.py` | Scripts that downloaded the OSM data and built the geo files: `fetch_osm.py`, `fetch_walks.py`, `build_geo.py` (core roads), `fetch_osm_expanded.py`, `build_network.py` (expanded network and places) |
| `sim/engine.js` | In-browser simulator: route choice, road congestion, intersection waits, bus |
| `lab-ui.js` | Trips, places and map picking, intersection controls, road settings, Assumptions card |
| `api.js` | Calls the backend (`?api=real`), or the in-browser simulator |

## Data notes

- Road and intersection IDs/names come from `testing/road-network.md` (Draft v2). Sources: [map.princeton.edu](https://map.princeton.edu/) and [facilities.princeton.edu/maps](https://facilities.princeton.edu/maps).
- Mock signal intersections and the bus route follow `testing/test-plan.md` (TC-05 to TC-07).
- Mock `x`/`y` values are a schematic layout, not real coordinates.
- **Street geometry** (`geo/princeton-geo.js`) comes from OpenStreetMap, downloaded 2026-11-14. Each intersection is the OSM node where the two streets meet. Each road is the shortest path along the named streets between its two intersections:

  | Road | Streets | Length |
  |---|---|---|
  | `nassau_west` | Nassau St | 537 m |
  | `nassau_mercer` | Nassau St → Mercer St | 294 m |
  | `alex_north` | Alexander St | 487 m |
  | `alex_station` | Alexander St | 735 m |
  | `univ_place` | University Pl → Alexander St | 786 m |
  | `wash_north` | Washington Rd | 336 m |
  | `wash_mid` | Washington Rd | 311 m |
  | `wash_south` | Washington Rd | 552 m |
  | `faculty_rd` | Faculty Rd | 761 m |
  | `prospect_ave` | Prospect Ave | 352 m |

  - `int_wash_goheen` is where Goheen Walk (a footpath) meets Washington Rd.
  - `int_alex_univ` is on Alexander St at the University Pl roundabout. OSM has a small unnamed gap there, so the build script bridges gaps under 35 m.
  - Lengths are for drawing only; the simulation's travel times come from the backend.
- **Venue location check:** in OSM, the Julis Romo Rabinowitz Building (40.34914, -74.65555) sits beside `wash_north`, between Nassau St and Prospect Ave. `testing/road-network.md` and the demo script say it's on `wash_mid`. Our map research teammate should confirm which segment to close for the "Let-Out" demo.
- **In-browser simulator assumptions (not measurements):**
  - **Demand:** one 15-minute let-out period. 200 let-out cars go from Nassau & Washington to Alexander & University Pl (station), the same as the backend. Another 245 background cars run on 9 routes through town (listed in `sim/engine.js`).
  - **Roads:** free-flow time = length / speed limit. Congestion uses BPR, `t0 × (1 + 0.15 × (cars / capacity)^4)`, with 100 cars per lane per 15 min for each direction.
  - **Junction waits** use textbook Highway Capacity Manual-style formulas, not local counts:
    - signals: Webster uniform delay plus HCM overflow delay, with a saturation flow of 1800 cars per hour of green per lane
    - all-way stops: one car every 4 s, plus 5 s for the stop
    - two-way stops: 6.5 s critical gap and 3.3 s follow-up time
    - roundabouts: entry capacity 1380·e^(−0.00102·circulating cars per hour)
  - **Route choice:** drivers pick the fastest route given everyone else's choices (user equilibrium, method of successive averages, 60 rounds). Turns aren't modelled.
  - **Default controls are guesses, not surveyed:**
    - Nassau St junctions with bigger streets: signals (90 s cycle, 60% for Nassau)
    - Alexander & University Pl: roundabout
    - other junctions of two bigger streets: all-way stops
    - the rest: two-way stops
  
  Our road research teammate should check the default controls against the real intersections.
- **Places** (`ROAD_GEOMETRY.landmarks`) are OSM building or station centers: Princeton Station (Dinky), Nassau Hall, Firestone Library, the Chapel, Frist, the Art Museum, Palmer Square, Princeton Public Library, Jadwin Gym, Friend Center, Lewis Library, Princeton Theological Seminary, and JRR.

## Tested: in-browser simulator (`ben-test`, 2026-11-14, in the browser)

| Check | Result |
|---|---|
| Load | 27 intersections, 39 roads, places and control icons on the street map; 445 trips, 3.5 min average, conservation ✓ |
| Signal at Nassau & Witherspoon + 30 s walk phase (slider clicked) | Average wait there 16 s → 38 s; 22 cars re-route away from that approach |
| Same intersection → All-way stop (dropdown) | Listed under "Your changes"; wait 16 s → 35 s |
| Pick on map (two clicks on the street map) → Add trip, 50 cars | Pins snap to Chambers & Paul Robeson and Washington & Faculty; A/B markers, purple route, 7-road route list; 495 trips |
| Allow cars on University Pl | 118 cars use it; let-out trip 4.7 → 4.0 min |
| University Pl one-way toward Alexander St, 15 mph | 30 cars, 2.0 min; both changes listed with Undo |
| Let-out 400 cars (Assumptions) | 695 trips in both columns |
| Reset | Changes cleared; trip and assumption kept |
| Roundabout at Nassau & Washington | 3.5 → 3.4 min |
| Trip only in modified scenario, then close `moore_1` and `wiggins_2` | Trip shows "No route"; 30 unserved |
| Bus 25% | 50 let-out trips by bus; 425 + 0 + 50 = 475 ✓ |
| Demo preset (close `wash_mid`) | 3.5 → 5.0 min; custom trip kept |
| Schematic view | 39 roads; 15 stop and 3 signal icons; names shown on hover |
| Phone width (375 px) | No sideways scrolling |
| Core road shapes | The 10 core roads and 9 core intersections in `princeton-geo.js` are unchanged |

**Backend mode, same branch:** `?api=real` against `main`'s backend (`uvicorn backend.main:app --port 8000`):
- Load: 9 intersections and 10 roads, 10.4 min.
- Close `wash_mid`: 20.4 min, 200 completed.
- Add 1 lane on `alex_north`: 15.9 min, 200 completed, 0 unserved.
- Reset: 10.4 min, no changes.

The Trips card explains that custom trips need the in-browser simulator, and the lab controls are hidden. No console errors.

## Tested (old mock mode, 2026-11-14, in the browser; the mock was replaced by `sim/engine.js`)

| Check | Result |
|---|---|
| Original scenario | 10.2 min average, 220 completed, conservation ✓ |
| Demo preset (close `wash_mid`) | 18.9 min, 220 completed |
| + 1 lane on `alex_north` | 14.8 min, line drawn wider |
| + signal at `int_nassau_univ` (65% main green) | 15.8 min, signal icon shown |
| + bus 20% while `wash_mid` is closed | 0 shifted, with a note that the bus road is closed |
| Undo the closure (lane + signal + bus stay) | 9.2 min, 180 completed + 40 by bus = 220 ✓ |
| Close `wash_mid` and `nassau_west` | 200 unserved, 20 completed (Prospect trips) ✓ |
| Signal at `int_wash_prospect`, 30% vs. 80% main green | Washington Rd N 4.2 → 3.5 min, Prospect Ave 2.5 → 3.2 min |
| Non-signal intersection | Explains that a signal isn't supported there |
| Reset | Back to the original numbers, bus off, no changes listed |
| `?api=real` with no backend running | Clear "can't reach the backend" message |

## Tested against the real backend (2026-11-14)

### Run 3: street map (`map-upgrade` branch)

Backend: `main` at `7e56b68` (includes `backend/` from `a1350d0`), run unchanged with `uvicorn backend.main:app --port 8000`. Frontend: `http://127.0.0.1:5501/?api=real`.

| Test | Expected | Street map | Schematic fallback (`&tiles=test-fail`) |
|---|---|---|---|
| Load | Map tiles, "You are here" at JRR, OSM attribution | ✓ Tiles loaded; marker and label shown; "Leaflet \| © OpenStreetMap contributors" visible | ✓ Note shown, schematic view switched on automatically |
| Close `wash_mid` (clicked on the map overlay) | 20.4 min, 200 completed | ✓ 20.4 min, 200 completed, 0 unserved; ✕ on the road; no cars on Route A | ✓ 20.4 min |
| + 1 lane on `alex_north` (mouse click on the overlay) | 15.9 min, 200 completed, 0 unserved | ✓ 15.9 min, 200 completed, 0 unserved | ✓ 15.9 min |
| Reset | 10.4 min, changes cleared | ✓ 10.4 min, no changes, cars back on both routes | ✓ 10.4 min |

Mock mode on the street map: the bus route overlay (5 roads) and the signal icon at Washington Rd & Prospect Ave both appear, and the trip check holds (180 completed + 40 by bus = 220). No console errors.

### Run 2: backend with CORS

Backend: `backend` branch at `a1350d0` ("Allow local frontend to call API"), run unchanged with `uvicorn backend.main:app --port 8000`. Frontend: `http://127.0.0.1:5501/?api=real`. All steps were clicked in the UI.

| Test | Request sent | Expected | Actual | Result |
|---|---|---|---|---|
| Close `wash_mid` | `closedRoadIds: ["wash_mid"]` | 20.4 min, 200 completed | 20.4 min, 200 completed, 0 unserved | ✓ Pass |
| Close `wash_mid` + 1 lane on `alex_north` | `closedRoadIds: ["wash_mid"]`, `extraLanesByRoadId: {"alex_north": 1}` | 15.9 min, 200 completed, 0 unserved | 15.9 min, 200 completed, 0 unserved; `alex_north` 200 trips, 2.3 min, volume/capacity 1.00; line drawn wider | ✓ Pass |
| Reset | `[]`, `{}`, `[]`, `0` | Closure and lane cleared, 10.4 min | No changes listed, no closed roads, `alex_north` back to normal width, 10.4 min (backend value 10.41), 200 completed | ✓ Pass |

The trip check showed "200 completed + 0 unserved + 0 by bus = 200" in every case.

### Run 1: before CORS

Backend: `backend` branch at `ae6a142` ("Connect Princeton network to simulation"), run locally with Uvicorn. CORS was added in a local test wrapper only, because the backend didn't enable it yet.

| Test plan case | Result |
|---|---|
| Load | 9 intersections and 10 roads drawn from `GET /api/network`, 200 trips, 10.4 min, conservation ✓ |
| TC-01 close `wash_mid` (demo preset) | 10.4 → 20.4 min; Route B roads 80 → 200 trips; Route A roads 120 → 0 |
| TC-02 also close `nassau_west` | "No completed trips.", 0 completed + 200 unserved = 200 ✓ |
| TC-03 Reset | Back to 10.4 min, no changes |
| TC-04 +1 lane on `wash_mid` | Road 2.6 → 2.0 min (volume/capacity 1.20 → 0.60), average 10.4 → 10.1 min |
| Signals / bus | Backend sends no signal intersections and `busRoute: null`, so the UI shows no signal rings and "No bus route available yet." |
