# Princeton Traffic Lab: Frontend

Plain HTML, CSS, and vanilla JavaScript. No libraries, frameworks, or build step.

## Run it

Serve the folder from the repo root:

```bash
py -m http.server 5500 --directory frontend
```

Then open http://localhost:5500. You can also double-click `frontend/index.html`.

- **Mock mode (default):** uses `mock/network.js` and `mock/simulate.js`, which follow the shared API format.
- **Backend mode:** open `http://localhost:5500/?api=real` to call the FastAPI server at `http://localhost:8000` (set in `api.js`). The backend must allow CORS for the page to reach it.

## Features

- **Map from data.** Every intersection and road comes from `GET /api/network` and is placed by its `x`/`y`, scaled to fit. Street names and IDs aren't hard-coded, so the network can be swapped.
- **Roads.** Click a road to see its car trips, travel time, and volume/capacity, original vs. modified. You can then:
  - **Close road** / **Reopen road** (sent as `closedRoadIds`)
  - add or remove **extra lanes**, 0–3 (sent as `extraLanesByRoadId`; wider lines show added lanes)
- **Signals.** Intersections listed in `signalIntersections` have an orange ring. Click one to **Add signal** and set the **main road green time**, 20–80% (sent as `signals[].mainGreenShare`, a fraction). A traffic-light icon marks active signals.
- **Bus.** If `busRoute` isn't null, you can turn on the bus route and choose the **% of car trips switching to bus**, 0–50% (sent as `busShiftPercent`). The route is drawn as a blue dotted line. If `busRoute` is null, the panel says "No bus route available yet."
- **Combine changes.** "Your changes" lists every active change, each with **Undo**. **Reset** sends `[]`, `{}`, `[]`, `0`.
- **Original vs. modified.** Shows average car trip time ("No completed trips." when null), unserved car trips, and trips shifted to bus. When the backend sends them, it also shows completed and total trips, plus a trip-conservation check: completed + unserved + bus = total.
- **Where the trips went.** Lists the roads whose car trips changed, ordered from biggest gain to biggest loss.
- **Road colors.** Colors come from the backend's `congestionRatio`: green < 0.8, yellow 0.8–1.0, red > 1.0. Closed roads are dashed grey with an ✕.
- **Animated cars (optional).** Purely visual. More dots appear on roads with more car trips, and they move slower when travel time is longer. They can be turned off, and are off by default for users who prefer reduced motion.
- **Demo preset.** "Demo: HackPrinceton Let-Out" resets everything and closes `wash_mid`, following `demo/demo-script.md`. It only appears if that road exists.
- **Errors.** If the backend rejects a change (for example, a feature it doesn't support yet), the change is undone and the error is shown at the top.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page layout |
| `styles.css` | Styling, road colors, map symbols |
| `app.js` | Draws the map, handles clicks and controls, shows results, animates cars |
| `api.js` | Calls the backend, or the mock when `useMock` is on |
| `mock/network.js` | Mock `GET /api/network` |
| `mock/simulate.js` | Mock `POST /api/simulate` |

## Data notes

- Road and intersection IDs/names come from `testing/road-network.md` (Draft v2). Sources: [map.princeton.edu](https://map.princeton.edu/) and [facilities.princeton.edu/maps](https://facilities.princeton.edu/maps).
- Mock signal intersections and the bus route follow `testing/test-plan.md` (TC-05 to TC-07).
- Mock `x`/`y` values are a schematic layout, not real coordinates.
- **All mock traffic numbers are simulation assumptions:** 200 main trips plus 20 Prospect Ave trips, a 60/40 route split, 100 cars per lane, a 2-minute free-flow time, up to 1.5 minutes of signal wait, and a bus that runs only when all its roads are open. The real results come from the backend.

## Tested (mock mode, 2026-11-14, in the browser)

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

Backend: `backend` branch at `ae6a142` ("Connect Princeton network to simulation"), run locally with Uvicorn. CORS was added in a local test wrapper only, because the backend doesn't enable it yet.

| Test plan case | Result |
|---|---|
| Load | 9 intersections and 10 roads drawn from `GET /api/network`, 200 trips, 10.4 min, conservation ✓ |
| TC-01 close `wash_mid` (demo preset) | 10.4 → 20.4 min; Route B roads 80 → 200 trips; Route A roads 120 → 0 |
| TC-02 also close `nassau_west` | "No completed trips.", 0 completed + 200 unserved = 200 ✓ |
| TC-03 Reset | Back to 10.4 min, no changes |
| TC-04 +1 lane on `wash_mid` | Road 2.6 → 2.0 min (volume/capacity 1.20 → 0.60), average 10.4 → 10.1 min |
| Signals / bus | Backend sends no signal intersections and `busRoute: null`, so the UI shows no signal rings and "No bus route available yet." |
