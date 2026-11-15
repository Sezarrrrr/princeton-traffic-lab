# Traffix Lab (Princeton Traffic Lab)

An interactive traffic "what if" map of Princeton, built at HackPrinceton Fall 2026. Close a road, add a lane, change a traffic light or add your own trip, and see how car trips reroute and how travel times change compared with the original scenario.

**Roads are real. Traffic is simulated.** Street shapes, intersections and mapped traffic controls come from OpenStreetMap. All traffic volumes, road capacities, travel times, signal timings and bus numbers are simulation assumptions, not measurements.

## Run it

You need Python 3 for the local web server. No build step.

```powershell
py -m http.server 5501 --bind 127.0.0.1 --directory frontend
```

Open http://127.0.0.1:5501/. The status line should read **In-browser simulator · 308 intersections · 441 roads**.

The page has three views: **Map** (2D), **3D** and **Schematic**. The 2D and 3D maps need internet for map tiles. Without it the page switches to the schematic, which works offline.

### Optional: the Python backend

The default page runs its simulator in the browser and needs no backend. The FastAPI backend in `backend/` covers a 10-road core network with road closures and extra lanes.

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Then open http://127.0.0.1:5501/?api=real. The backend only accepts pages served from port 5501.

## What you can do

- **Close roads and add lanes** by clicking a road.
- **Change intersections:** traffic signal, all-way stop, two-way stop, roundabout or no control, plus signal cycle length, green split, lost time and walk phase.
- **Change a road's** speed limit, direction and car access.
- **Add your own trips** between any two places or map points, with a number of cars.
- **Run the bus** and choose what share of let-out trips switch to it.
- **Compare** original and modified results: average trip time, junction wait, completed and unserved trips, and which roads gained or lost cars.
- **Demo: Let-Out** closes Washington Rd outside the venue in one click.

Details, the file list and browser test results are in [frontend/README.md](frontend/README.md).

## How the simulation works

- **Demand:** 200 cars leave Nassau & Washington for Alexander & University Place (the let-out), plus 466 background cars on 232 routes entering from 15 points on the edge of the map. All of it is in one 15-minute period.
- **Road speed:** travel time rises with cars per lane (the BPR formula), with 100 cars per lane per 15 minutes as the default capacity.
- **Intersections:** each control type adds wait time with standard traffic-engineering formulas (Webster delay for signals, gap acceptance for stop signs, an entry-capacity curve for roundabouts).
- **Route choice:** drivers settle on routes where no one can save time by switching (user equilibrium, 30 iterations).
- **Starting controls:** 28 signals, 41 stop-sign junctions and 4 roundabouts come from OpenStreetMap. 151 junctions with nothing mapped get an assumed two-way stop. All signal timings are assumed.

## Known limits

- Traffic numbers are assumptions. The model has not been calibrated against real counts.
- One 15-minute period, with no queues carried over time and no spillback from one road into the next.
- No turn restrictions, pedestrians or cyclists. The walk phase only takes green time from cars.
- Bus riders are removed from car traffic. Bus travel time is not simulated, and the bus is suspended when a road on its route is closed.
- The average trip time covers completed car trips only, so moving short trips to the bus can raise the average.
- The Python backend is a smaller, separate model (10 roads). It does not support signals, bus service or custom trips.

## Checks

- **In-browser simulator:** open http://127.0.0.1:5501/tests.html. It runs 12 checks, for example that trips are conserved, closed roads carry no cars, and closing the demo road makes trips slower.
- **Backend:** `.\.venv\Scripts\python.exe -m unittest backend.test_main -v` runs 6 checks.
- **Manual test plan:** [testing/test-plan.md](testing/test-plan.md).

## Publish the site

`.github/workflows/pages.yml` publishes the `frontend/` folder to GitHub Pages. It only runs when someone starts it by hand.

1. In the repo, go to **Settings → Pages → Source** and choose **GitHub Actions**.
2. Go to **Actions → Deploy frontend to GitHub Pages → Run workflow**.
3. For a custom domain, enter it under **Settings → Pages → Custom domain** and point the domain's DNS at GitHub Pages.

The published site uses the in-browser simulator. The Python backend does not run on GitHub Pages.

## Credits

Everything not listed here was written by our team during HackPrinceton Fall 2026.

| What | Used for | License |
|---|---|---|
| [Leaflet](https://leafletjs.com) 1.9.4 | 2D street map | BSD-2-Clause |
| [MapLibre GL JS](https://maplibre.org) 4.7.1 | 3D map view | BSD-3-Clause |
| [OpenFreeMap](https://openfreemap.org) tiles, built on [OpenMapTiles](https://openmaptiles.org) | 3D basemap and buildings | Free public instance; data ODbL |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) tiles and data, fetched with the [Overpass API](https://overpass-api.de) | 2D basemap, street shapes, road network, mapped traffic controls, places | © OpenStreetMap contributors, ODbL |
| [FastAPI](https://fastapi.tiangolo.com), [Uvicorn](https://www.uvicorn.org), [Pydantic](https://docs.pydantic.dev) | Python backend | MIT, BSD-3-Clause, MIT |
| [GitHub Pages](https://pages.github.com) | Hosting | n/a |

Map sources for the original 10-road core network are recorded in [testing/road-network.md](testing/road-network.md).

## Team

- **Sizar Ishak:** Python/FastAPI backend.
- **Ben Chuquiruna:** frontend (map views, in-browser simulator, controls and panels).
- **Gabriel Cupo:** Road research, testing and demo lead:** corridor research, the test plan and the demo script.
