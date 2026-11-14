# Princeton Traffic Lab — Test Plan (`testing/test-plan.md`)

**Branch:** `testing-demo`  
**Network Reference:** `testing/road-network.md` (Draft v2: **10 roads**, **9 unique intersections**)  
**Endpoints Tested:** `GET /api/network`, `POST /api/simulate`  

---

## Confirmed API Schema & Core Invariant
Sizar confirmed the response structure returned inside both `baseline` and `scenario`:
- **Top-level trip counters:** `totalCarTrips`, `completedCarTrips`, `unservedCarTrips`, `carTripsShiftedToBus`, and `avgCarTravelMinutes`.
- **Per-road list (`roads`):** A list of road objects, each containing `id` and `carTrips` (plus travel time/congestion fields).
- **Trip-Conservation Formula:** Because a single trip traverses multiple road segments (so summing `roads[*].carTrips` counts segment traversals, not unique vehicles), trip conservation is checked strictly using the top-level trip counters:
  $$\text{completedCarTrips} + \text{unservedCarTrips} + \text{carTripsShiftedToBus} == \text{totalCarTrips}$$

---

## Backend Coordination Flags (For Sizar)

### Confirmed by Sizar
- **Top-level trip counters:** `baseline` and `scenario` both include `totalCarTrips` and `completedCarTrips` (alongside `unservedCarTrips`, `carTripsShiftedToBus`, and `avgCarTravelMinutes`).
- **`roads` list structure:** `roads` in `baseline` and `scenario` is a list of objects containing `id` and `carTrips`.

### Still Open (Pending Backend Confirmation)
1. **Reverse-Direction Traversal on `alex_station` (Route A):** In `testing/road-network.md`, `alex_station` is defined with `from: int_alex_univ` and `to: int_alex_faculty` (two-way). Route A traverses `alex_station` in reverse (`int_alex_faculty` → `int_alex_univ`) to reach `int_alex_univ`. Confirm the backend graph builder registers two-way roads in both directions.
2. **Prospect Avenue Demand (`TC-05`):** Confirm whether Draft v2 baseline demand includes trips using `prospect_ave` (`int_wash_prospect` ↔ `int_prospect_olden`); `TC-05` stays **PENDING** until cross-street trips exist on `prospect_ave`.
3. **`GET /api/network` ID Schema (`TC-01`):** Confirm that `GET /api/network` returns all 10 road IDs and 9 intersection IDs using `id` fields matching `testing/road-network.md` once the Draft v2 network replaces the 4-road prototype.

---

## Temporary Prototype Tests (4-Road Test Network — Verified via Swagger)
*Executed by Sizar in FastAPI Swagger UI on the initial 4-road prototype network (`road-1` / `road-2` north route, `road-3` / `road-4` south route; 200 total trips).*

### PROTO-01: Single-Road Closure Reroutes Trips
- **Steps:** Close `road-1` via `POST /api/simulate` (`closedRoadIds: ["road-1"]`).
- **Expected Result:** `road-1` has `0` car trips; all 200 trips reroute onto the south path (`road-3`, `road-4`); average travel time increases; `completedCarTrips + unservedCarTrips + carTripsShiftedToBus == 200`.
- **Actual Result (Verified):** Closing `road-1` sent all **200** trips down the south route. Both `road-3` and `road-4` showed **200** trips, and `avgCarTravelMinutes` rose from **4.84** to **13.6** minutes (`200 + 0 + 0 == 200`).

### PROTO-02: Dual-Route Closure Leaves No Route (`null` Average)
- **Steps:** Close both `road-1` and `road-3` (`closedRoadIds: ["road-1", "road-3"]`).
- **Expected Result:** `0` completed trips, `200` unserved trips, and `avgCarTravelMinutes: null`.
- **Actual Result (Verified):** Closing `road-1` and `road-3` returned **200** `totalCarTrips`, **0** `completedCarTrips`, **200** `unservedCarTrips`, and `avgCarTravelMinutes: null` (`0 + 200 + 0 == 200`).

### PROTO-03: Reset Restores Prototype Baseline
- **Steps:** Send Reset payload (`closedRoadIds: []`, `extraLanesByRoadId: {}`, `signals: []`, `busShiftPercent: 0`).
- **Expected Result:** Scenario road counts and metrics match baseline split (120 north / 80 south).
- **Actual Result (Verified):** Reset restored **120** trips on the north route and **80** trips on the south route.

---

## Princeton Network Tests (Draft v2: 10 Roads, 9 Intersections)
*All Princeton-specific tests below remain **PENDING** until Sizar loads the Draft v2 10-road, 9-intersection network into the backend.*

### TC-01: Network Load & Single-Road Closure Reroutes Trips onto Mercer Detour `[PENDING]`
- **Status:** **PENDING** — waiting for Draft v2 Princeton network in backend.
- **Goal:** Verify `GET /api/network` returns all 10 roads and 9 intersections, and closing `wash_mid` reroutes trips through Route B (`nassau_west` → `nassau_mercer` → `alex_north`).
- **Steps:**
  1. Call `GET /api/network` and verify **10 road IDs** and **9 intersection IDs** matching `testing/road-network.md`.
  2. Call `POST /api/simulate` with:
     ```json
     {
       "closedRoadIds": ["wash_mid"],
       "extraLanesByRoadId": {},
       "signals": [],
       "busShiftPercent": 0
     }
     ```
- **Expected Result:**
  - `GET /api/network` returns 10 roads and 9 intersections.
  - `scenario.roads` shows `carTrips: 0` on `wash_mid`.
  - `carTrips` increases on `nassau_west`, `nassau_mercer`, and `alex_north` compared to `baseline`.
  - `scenario.avgCarTravelMinutes` increases over `baseline.avgCarTravelMinutes`.
  - `completedCarTrips + unservedCarTrips + carTripsShiftedToBus == totalCarTrips`.
- **Actual Result:** _Pending — waiting for Draft v2 Princeton network in backend._

---

### TC-02: Multi-Road Closure That Leaves No Route (`null` Average) `[PENDING]`
- **Status:** **PENDING** — waiting for Draft v2 Princeton network in backend.
- **Goal:** Verify severing both Route A and Route B moves all affected trips to `unservedCarTrips` and sets `avgCarTravelMinutes` to `null` when `completedCarTrips == 0`.
- **Steps:**
  1. Call `POST /api/simulate` with:
     ```json
     {
       "closedRoadIds": ["wash_mid", "nassau_west", "univ_place"],
       "extraLanesByRoadId": {},
       "signals": [],
       "busShiftPercent": 0
     }
     ```
- **Expected Result:**
  - Closed roads (`wash_mid`, `nassau_west`, `univ_place`) each report `carTrips: 0` in `scenario.roads`.
  - If `completedCarTrips == 0`, `scenario.avgCarTravelMinutes` is `null` (not `0` or `NaN`).
  - `completedCarTrips + unservedCarTrips + carTripsShiftedToBus == totalCarTrips`.
- **Actual Result:** _Pending — waiting for Draft v2 Princeton network in backend._

---

### TC-03: Reset to Princeton Baseline State `[PENDING]`
- **Status:** **PENDING** — waiting for Draft v2 Princeton network in backend.
- **Goal:** Verify Reset clears all overrides and restores baseline metrics and per-road `carTrips`.
- **Steps:**
  1. Run TC-01 or TC-02 so the client holds non-default scenario state.
  2. Send Reset (`closedRoadIds: []`, `extraLanesByRoadId: {}`, `signals: []`, `busShiftPercent: 0`).
- **Expected Result:**
  - `scenario.avgCarTravelMinutes == baseline.avgCarTravelMinutes`.
  - `scenario.completedCarTrips == baseline.completedCarTrips`, `scenario.unservedCarTrips == baseline.unservedCarTrips`, and `scenario.carTripsShiftedToBus == 0`.
  - Every road's `carTrips` in `scenario.roads` matches `baseline.roads`.
- **Actual Result:** _Pending — waiting for Draft v2 Princeton network in backend._

---

### TC-04: Add Extra Lane on Detour / Bottleneck Road `[PENDING]`
- **Status:** **PENDING** — waiting for Draft v2 Princeton network in backend.
- **Goal:** Verify adding capacity reduces travel time on a congested road.
- **Steps:**
  1. Call `POST /api/simulate` with `extraLanesByRoadId: { "alex_north": 1 }` (and/or `"wash_mid": 1`).
- **Expected Result:**
  - Added-lane road shows lower travel time than in `baseline`.
  - `completedCarTrips + unservedCarTrips + carTripsShiftedToBus == totalCarTrips`.
- **Actual Result:** _Pending — waiting for Draft v2 Princeton network in backend._

---

### TC-05: Add Traffic Signal and Adjust `mainGreenShare` at `int_wash_prospect` `[PENDING]`
- **Status:** **PENDING** — waiting for Draft v2 Princeton network AND backend baseline trips using `prospect_ave`.
- **Goal:** Verify signal timing at `int_wash_prospect` shifts delay between Washington Road and Prospect Avenue as `mainGreenShare` changes (`0.3` vs `0.8`).
- **Steps:**
  1. Call `POST /api/simulate` with `signals: [{ "intersectionId": "int_wash_prospect", "mainGreenShare": 0.3 }]`, then repeat with `0.8`.
- **Expected Result:**
  - Lower `mainGreenShare` increases Washington Road delay relative to `prospect_ave`; higher `mainGreenShare` reverses the split.
  - `completedCarTrips + unservedCarTrips + carTripsShiftedToBus == totalCarTrips`.
- **Actual Result:** _Pending — waiting for Draft v2 network and `prospect_ave` demand in backend._

---

### TC-06: Enable Predefined TigerTransit Bus Route (`busShiftPercent`) `[PENDING]`
- **Status:** **PENDING** — waiting for Draft v2 Princeton network in backend.
- **Goal:** Verify shifting car trips onto the predefined bus route (`["wash_north", "wash_mid", "wash_south", "faculty_rd", "alex_station"]`) reduces car trips and increments `carTripsShiftedToBus`.
- **Steps:**
  1. Call `POST /api/simulate` with `busShiftPercent: 25`.
- **Expected Result:**
  - `scenario.carTripsShiftedToBus > 0` and car volumes along the bus corridor decrease proportionally.
  - `completedCarTrips + unservedCarTrips + carTripsShiftedToBus == totalCarTrips`.
- **Actual Result:** _Pending — waiting for Draft v2 Princeton network in backend._

---

### TC-07: Combined Scenario ("HackPrinceton Let-Out" Closure + Verified Mitigation) `[PENDING]`
- **Status:** **PENDING** — waiting for Draft v2 Princeton network in backend.
- **Goal:** Verify simultaneous closure + mitigation controls compute cleanly without conflicts.
- **Steps:**
  1. Call `POST /api/simulate` with `closedRoadIds: ["wash_mid"]`, `extraLanesByRoadId: { "alex_north": 1 }`, `signals: [{ "intersectionId": "int_nassau_univ", "mainGreenShare": 0.65 }]`, `busShiftPercent: 20`.
- **Expected Result:**
  - `wash_mid` has `carTrips: 0`; `alex_north` absorbs detour volume; `completedCarTrips + unservedCarTrips + carTripsShiftedToBus == totalCarTrips`.
- **Actual Result:** _Pending — waiting for Draft v2 Princeton network in backend._
