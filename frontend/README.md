# Princeton Traffic Lab: Frontend

Plain HTML, CSS, and vanilla JavaScript. No libraries or build step.

## Run it

Open `frontend/index.html` in a browser, or serve the folder:

```bash
py -m http.server 5500 --directory frontend
```

Then go to http://localhost:5500.

- **Mock mode (default):** uses `mock/network.js` and `mock/simulate.js`, which follow the shared API format.
- **Backend mode:** open `http://localhost:5500/?api=real` to call the FastAPI server at `http://localhost:8000` (set in `api.js`).

## What it does (milestone 1)

- Draws every intersection and road from `GET /api/network`, using the `x`/`y` coordinates. No street names or IDs are hard-coded, so the network can be swapped.
- Click a road to see its name and car trips, then **Close road** / **Reopen road**.
- Closed road IDs are kept and sent as `closedRoadIds` to `POST /api/simulate`, together with `extraLanesByRoadId: {}`, `signals: []`, and `busShiftPercent: 0`.
- Roads are colored by the backend's `congestionRatio`. Closed roads are dashed with an ✕.
- The panel compares the original and modified scenarios: average car trip time ("No completed trips." when null), unserved car trips, trips shifted to bus, and which roads gained or lost trips.
- **Reset** reopens every road.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page layout |
| `styles.css` | Styling and road colors |
| `app.js` | Draws the map, handles clicks, shows results |
| `api.js` | Calls the backend, or the mock when `useMock` is on |
| `mock/network.js` | Mock `GET /api/network` |
| `mock/simulate.js` | Mock `POST /api/simulate` |

## Data notes

- Road and intersection IDs/names come from `testing/road-network.md` (Draft v2). Sources: [map.princeton.edu](https://map.princeton.edu/) and [facilities.princeton.edu/maps](https://facilities.princeton.edu/maps).
- Mock `x`/`y` values are a schematic layout, not real coordinates.
- All mock traffic numbers (200 trips, 120/80 split, capacity 100, 2-minute free-flow time) are **simulation assumptions**. The real results come from the backend.

## Tested (mock mode, 2026-11-14)

- Page loads with 9 intersections and 10 roads.
- Closing Washington Road (Mid): average trip goes from 10.4 to 20.4 min, and all 200 trips move to the Nassau / Mercer / Alexander route.
- Also closing Alexander Street (North): "No completed trips.", 200 unserved.
- Reopening a road and Reset return to the original numbers.
