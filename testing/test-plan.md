# Princeton Traffic Lab — Test Plan (`testing/test-plan.md`)

**Branch:** `testing-demo`  
**Network Reference:** `testing/road-network.md` (Draft v2: **10 roads**, **9 unique intersections**)  
**Endpoints Tested:** `GET /api/network`, `POST /api/simulate`  

> **Scope note (Nov 14, 2026):** this plan covers the Python backend's 10-road core network (`?api=real`). The default page now runs the in-browser simulator on 308 intersections and 441 roads, where `wash_mid` is split into `wash_mid_1` and `wash_mid_2` and the numbers differ. Automated checks now exist for both: `frontend/tests.html` (12 checks, in-browser simulator) and `python -m unittest backend.test_main` (6 checks, backend). The signal and bus test cases below don't apply to the backend on `main`, which rejects those requests with a 422.

---

## Backend Coordination Flags (For Sizar)
Before automated verification can assert every invariant without manual inspection, confirm these response fields with Sizar on `GET /api/network` and `POST /api/simulate`:
1. **Trip-Conservation Field (`completedCarTrips` or `totalCarTrips`):**
   - The shared API spec guarantees `avgCarTravelMinutes`, `unservedCarTrips`, `carTripsShiftedToBus`, and `roads` inside `baseline` and `scenario`.
   - **Flag for TC-01 through TC-07:** Because road segment counts sum *segment traversals* (a single trip across 5 roads counts on all 5 roads), verifying $\text{Completed Car Trips} + \text{unservedCarTrips} + \text{carTripsShiftedToBus} = \text{Original Car Trips}$ requires Sizar to either expose `completedCarTrips` (or `totalCarTrips`) at the top level of `baseline`/`scenario` **or** confirm how origin-to-destination completed trips are derived from `roads`.
2. **Per-Road Trip Field Name (`roads`):**
   - Confirm exact field key on each road object in `scenario.roads` (e.g., `carTrips` vs. `volume`) and whether `roads` is returned as a list of objects (`[{"id": "wash_mid", ...}]`) or a dictionary keyed by road ID (`{"wash_mid": {...}}`).
3. **Prospect Avenue Demand (`TC-05`):**
   - `TC-05` (signal timing at `int_wash_prospect`) is marked **PENDING — Blocked on Backend Demand** until Sizar's demand table includes baseline trips entering or exiting `prospect_ave` (`int_wash_prospect` ↔ `int_prospect_olden`); otherwise `mainGreenShare` changes on `prospect_ave` will have zero cross-street traffic to affect.

---

## Phase 1: Core Routing & Reset Tests (Run First)

### TC-01: Network Load & Single-Road Closure That Reroutes Trips
- **Goal:** Verify `GET /api/network` returns all 10 roads and 9 intersections, and closing `wash_mid` reroutes trips onto Route B (`nassau_west` → `nassau_mercer` → `alex_north`).
- **Steps:**
  1. Call `GET /api/network` and verify the response contains **10 road IDs** and **9 intersection IDs** matching `testing/road-network.md`.
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
  - `GET /api/network` lists 10 roads and 9 intersections.
  - `scenario.roads` shows `0` car trips on `wash_mid`.
  - Car trips on Route B (`nassau_west`, `nassau_mercer`, `alex_north`) increase compared to `baseline`.
  - `scenario.avgCarTravelMinutes` is a positive number (greater than `baseline.avgCarTravelMinutes` due to detour travel time/congestion).
  - `completedCarTrips + unservedCarTrips + carTripsShiftedToBus == Original Car Trips` *(Flagged: requires `completedCarTrips` or `totalCarTrips` from Sizar)*.
- **Actual Result:** _Pending execution against live `/api/network` and `/api/simulate`._

---

### TC-02: Multi-Road Closure That Leaves No Route (`null` Average)
- **Goal:** Verify severing both Route A and Route B records affected trips as `unservedCarTrips` and returns `null` for `avgCarTravelMinutes` when zero car trips complete.
- **Steps:**
  1. Call `POST /api/simulate` closing both Route A (`wash_mid`) and Route B (`nassau_west`)—plus `univ_place` if modeled in backend graph:
     ```json
     {
       "closedRoadIds": ["wash_mid", "nassau_west", "univ_place"],
       "extraLanesByRoadId": {},
       "signals": [],
       "busShiftPercent": 0
     }
     ```
- **Expected Result:**
  - Each closed road (`wash_mid`, `nassau_west`, `univ_place`) reports `0` car trips in `scenario.roads`.
  - All origin-to-destination trips requiring those corridors move to `scenario.unservedCarTrips`.
  - When `0` car trips complete across the network, `scenario.avgCarTravelMinutes` is `null` (not `0` or `NaN`).
  - `0 + unservedCarTrips + 0 == Original Car Trips` *(Flagged: requires `completedCarTrips` or `totalCarTrips` from Sizar)*.
- **Actual Result:** _Pending execution against live `/api/simulate`._

---

### TC-03: Reset to Baseline State
- **Goal:** Verify Reset clears all closures, lanes, signals, and bus shifts so `scenario` matches `baseline`.
- **Steps:**
  1. Run TC-01 or TC-02 so the client holds non-default scenario state.
  2. Trigger **Reset**, sending:
     ```json
     {
       "closedRoadIds": [],
       "extraLanesByRoadId": {},
       "signals": [],
       "busShiftPercent": 0
     }
     ```
- **Expected Result:**
  - `scenario.avgCarTravelMinutes` equals `baseline.avgCarTravelMinutes`.
  - `scenario.unservedCarTrips` equals `baseline.unservedCarTrips`.
  - `scenario.carTripsShiftedToBus` equals `0`.
  - Every road's trip volume and travel time in `scenario.roads` matches `baseline.roads`.
- **Actual Result:** _Pending execution against live `/api/simulate`._

---

## Phase 2: Capacity, Signal, Bus & Combined Scenario Tests

### TC-04: Add Extra Lane to Bottleneck Road
- **Goal:** Verify adding capacity reduces travel time on a congested corridor.
- **Steps:**
  1. Call `POST /api/simulate` with:
     ```json
     {
       "closedRoadIds": [],
       "extraLanesByRoadId": { "wash_mid": 1 },
       "signals": [],
       "busShiftPercent": 0
     }
     ```
- **Expected Result:**
  - `wash_mid` shows lower congestion/travel time than in `baseline`.
  - `scenario.avgCarTravelMinutes` is less than or equal to `baseline.avgCarTravelMinutes`.
  - Trip conservation holds with `carTripsShiftedToBus == 0` *(Flagged: requires `completedCarTrips` or `totalCarTrips` from Sizar)*.
- **Actual Result:** _Pending execution against live `/api/simulate`._

---

### TC-05: Add Traffic Signal and Adjust `mainGreenShare` `[PENDING — Blocked on Backend Demand]`
- **Status:** **PENDING** until Sizar confirms backend baseline demand includes trips using `prospect_ave`.
- **Goal:** Verify adding a signal at `int_wash_prospect` trades off Washington Road delay against Prospect Avenue delay as `mainGreenShare` changes.
- **Steps:**
  1. Call `POST /api/simulate` with low main-road green share (`0.3`):
     ```json
     {
       "closedRoadIds": [],
       "extraLanesByRoadId": {},
       "signals": [{ "intersectionId": "int_wash_prospect", "mainGreenShare": 0.3 }],
       "busShiftPercent": 0
     }
     ```
  2. Repeat with high main-road green share (`0.8`).
- **Expected Result:**
  - At `mainGreenShare: 0.3`, Washington Road (`wash_north` / `wash_mid`) experiences higher delay than at `0.8`, while `prospect_ave` experiences lower delay.
  - Both runs preserve total trip conservation *(Flagged: requires `completedCarTrips` or `totalCarTrips` from Sizar)*.
- **Actual Result:** _Pending — waiting for backend trips on `prospect_ave`._

---

### TC-06: Enable Predefined TigerTransit Bus Route (`busShiftPercent`)
- **Goal:** Verify shifting car trips onto the predefined bus route (`["wash_north", "wash_mid", "wash_south", "faculty_rd", "alex_station"]`) removes car volume and increments `carTripsShiftedToBus`.
- **Steps:**
  1. Call `POST /api/simulate` with:
     ```json
     {
       "closedRoadIds": [],
       "extraLanesByRoadId": {},
       "signals": [],
       "busShiftPercent": 25
     }
     ```
- **Expected Result:**
  - `scenario.carTripsShiftedToBus` reflects ~25% of eligible corridor car trips.
  - Car volumes on `wash_north`, `wash_mid`, `wash_south`, `faculty_rd`, and `alex_station` decrease proportionally.
  - `completedCarTrips + unservedCarTrips + carTripsShiftedToBus == Original Car Trips` *(Flagged: requires `completedCarTrips` or `totalCarTrips` from Sizar)*.
- **Actual Result:** _Pending execution against live `/api/simulate`._

---

### TC-07: Combined Scenario ("HackPrinceton Let-Out" Stress Test + Mitigation)
- **Goal:** Verify multiple simultaneous interventions (closure + extra lane + signal + bus shift) compute cleanly without conflicts.
- **Steps:**
  1. Call `POST /api/simulate` with:
     ```json
     {
       "closedRoadIds": ["wash_mid"],
       "extraLanesByRoadId": { "alex_north": 1 },
       "signals": [{ "intersectionId": "int_nassau_univ", "mainGreenShare": 0.65 }],
       "busShiftPercent": 20
     }
     ```
- **Expected Result:**
  - `wash_mid` has `0` car trips; `alex_north` absorbs rerouted Route B traffic with added lane capacity; `carTripsShiftedToBus` is positive; `avgCarTravelMinutes` is non-null; trip conservation holds *(Flagged: requires `completedCarTrips` or `totalCarTrips` from Sizar)*.
- **Actual Result:** _Pending execution against live `/api/simulate`._
