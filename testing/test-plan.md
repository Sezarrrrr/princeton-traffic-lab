# Princeton Traffic Lab — Test Plan (`testing/test-plan.md`)

**Branch:** `testing-demo`  
**Endpoints Tested:** `GET /api/network`, `POST /api/simulate`  
**Core Invariant (Trip Conservation):**  
For every simulation run, the sum of completed car trips, `unservedCarTrips`, and `carTripsShiftedToBus` must equal the baseline car-trip count:
$$\text{Completed Car Trips} + \text{unservedCarTrips} + \text{carTripsShiftedToBus} = \text{Original Car Trips}$$

---

## Phase 1: Core Routing & Reset Tests (Run First)

### TC-01: Single-Road Closure That Reroutes Trips
- **Goal:** Verify closing the primary corridor forces trips onto the valid detour (`nassau_west` → `univ_place`) with zero trips on the closed road.
- **Steps:**
  1. Call `GET /api/network` and confirm all 9 road IDs and 6 intersection IDs load.
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
  - `scenario.roads` shows `0` car trips on `wash_mid`.
  - Car trips on `nassau_west` and `univ_place` increase compared to `baseline`.
  - `scenario.avgCarTravelMinutes` is a positive number (greater than `baseline.avgCarTravelMinutes` due to detour congestion).
  - `scenario.unservedCarTrips` remains `0` (or matches baseline if no trips are stranded), and trip conservation holds.
- **Actual Result:** _Pending execution against live `/api/simulate`._

---

### TC-02: Multi-Road Closure That Leaves No Route (`null` Average)
- **Goal:** Verify severed origin-to-destination paths record all affected trips as unserved and return `null` for `avgCarTravelMinutes` when zero car trips complete.
- **Steps:**
  1. Call `POST /api/simulate` closing both Route A and Route B corridors:
     ```json
     {
       "closedRoadIds": ["wash_north", "wash_mid", "nassau_west", "univ_place"],
       "extraLanesByRoadId": {},
       "signals": [],
       "busShiftPercent": 0
     }
     ```
- **Expected Result:**
  - Closed roads (`wash_north`, `wash_mid`, `nassau_west`, `univ_place`) each report `0` car trips.
  - All car trips requiring those corridors move to `scenario.unservedCarTrips`.
  - If `0` car trips complete across the network, `scenario.avgCarTravelMinutes` is `null` (not `0` or `NaN`).
  - `0 + unservedCarTrips + 0 == Original Car Trips`.
- **Actual Result:** _Pending execution against live `/api/simulate`._

---

### TC-03: Reset to Baseline State
- **Goal:** Verify Reset clears all closures, lanes, signals, and bus shifts so `scenario` matches `baseline`.
- **Steps:**
  1. Run TC-01 or TC-02 so the UI/client holds non-default scenario state.
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
  - Every road's volume and travel time in `scenario.roads` matches `baseline.roads`.
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
  - Trip conservation holds with `carTripsShiftedToBus == 0`.
- **Actual Result:** _Pending execution against live `/api/simulate`._

---

### TC-05: Add Traffic Signal and Adjust `mainGreenShare`
- **Goal:** Verify adding a signal at `int_wash_prospect` changes main-street vs. cross-street delay as `mainGreenShare` varies.
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
  - Both runs preserve total trip conservation.
- **Actual Result:** _Pending execution against live `/api/simulate`._

---

### TC-06: Enable Predefined TigerTransit Bus Route (`busShiftPercent`)
- **Goal:** Verify shifting car trips onto the predefined bus route removes car volume and increments `carTripsShiftedToBus`.
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
  - `Completed Car Trips + unservedCarTrips + carTripsShiftedToBus == Original Car Trips`.
- **Actual Result:** _Pending execution against live `/api/simulate`._

---

### TC-07: Combined Scenario ("HackPrinceton Let-Out" Stress Test + Mitigation)
- **Goal:** Verify multiple simultaneous interventions (closure + extra lane + signal + bus shift) compute cleanly without conflicts.
- **Steps:**
  1. Call `POST /api/simulate` with:
     ```json
     {
       "closedRoadIds": ["wash_mid"],
       "extraLanesByRoadId": { "univ_place": 1 },
       "signals": [{ "intersectionId": "int_nassau_univ", "mainGreenShare": 0.65 }],
       "busShiftPercent": 20
     }
     ```
- **Expected Result:**
  - `wash_mid` has `0` car trips; `univ_place` absorbs rerouted traffic with added lane capacity; `carTripsShiftedToBus` is positive; `avgCarTravelMinutes` is non-null; trip conservation holds.
- **Actual Result:** _Pending execution against live `/api/simulate`._
