# Princeton Traffic Lab — Judge Demo Script (`demo/demo-script.md`)

**Target Runtime:** 1 minute 35 seconds – 1 minute 50 seconds (Strict 2:00 HackPrinceton judging cap)  
**Presenter:** Map Research, Testing & Demo Lead (with Sizar & Frontend Teammate standing by)  
**Truthfulness & Rule Check:** Present **only** features and scenarios that have passed testing before judging. Do not demo unverified controls as working features.

---

## Pre-Demo Gate Checklist (Complete Before Judging Starts)
- [ ] App open to default **Baseline** view (`closedRoadIds: []`, `extraLanesByRoadId: {}`, `signals: []`, `busShiftPercent: 0`).
- [ ] Map centered on Nassau Street, Washington Road, Julis Romo Rabinowitz Building (JRR), Mercer/Alexander Streets, and Princeton Station (`int_alex_univ`).
- [ ] Check `testing/test-plan.md` status before walking up to judges:
  - **Core Verified Path (Ready):** Closure (`wash_mid`), reroute onto Route B (`nassau_west` → `nassau_mercer` → `alex_north`), total-closure `null` check, and **Reset**.
  - **Optional Judge Mitigation Menu (Enable ONLY if marked `PASS` in `testing/test-plan.md`):**
    - Extra Lane (`TC-04`)
    - Signal Timing (`TC-05`)
    - Predefined TigerTransit Bus Shift (`TC-06`)

---

## 0:00 – 0:25 | Hook & Map Orientation ("We're right here")
> **[Point to the Julis Romo Rabinowitz Building / Washington Road on the map]**
>
> "Hi! We're **Princeton Traffic Lab**, and **we're right here**—outside the Julis Romo Rabinowitz Building on Washington Road, between Nassau Street and Princeton Station.
>
> Our network models 10 real Princeton road segments and 9 intersections—using confirmed public two-way streets and excluding restricted campus stretches on University Place—while our baseline trip counts, capacities, and travel times are clearly labeled simulation assumptions."

---

## 0:25 – 1:00 | Core Demo: "HackPrinceton Let-Out" Closure & Reroute
> **[Trigger "HackPrinceton Let-Out" / close `wash_mid` outside JRR]**
>
> "Now imagine **HackPrinceton Let-Out**—Washington Road right outside (`wash_mid`) closes for event safety.
>
> Watch the map and before-and-after panel: car trips on `wash_mid` drop to **zero**, and trips immediately reroute west along **Nassau Street**, onto **Mercer Street**, and south down **Alexander Street** toward Princeton Station. Average car travel time rises as the detour absorbs that traffic, while our trip-conservation check holds: completed trips, unserved trips, and bus-shifted trips always sum to `totalCarTrips`."

---

## 1:00 – 1:30 | Interactive Judge Choice (Verified Controls Only)
> **[Offer ONLY controls that passed testing in `testing/test-plan.md`]**
>
> - **If `TC-04` (Lanes), `TC-05` (Signals), or `TC-06` (Bus) passed testing, say:**  
>   *"You're the traffic planner—pick one verified change to test live: [name only the passed options, e.g., add a lane on `alex_north` / adjust signal green share / shift trips to the campus shuttle]."*  
>   **[Apply the judge's choice and point to where traffic moved and how `avgCarTravelMinutes` changed.]**
>
> - **If only core closure/reroute/reset passed testing before judging, say:**  
>   *"You're the traffic planner—pick another road segment to close on the map, or let's cut both corridors to see what happens when no route exists."*  
>   **[Apply the judge's closure: show either the new detour split or `completedCarTrips: 0`, all trips moved to `unservedCarTrips`, and `avgCarTravelMinutes: null` rather than a misleading zero.]**

---

## 1:30 – 1:45 | Reset & Close
> **[Click Reset (`[]`, `{}`, `[]`, `0`)]**
>
> "One click on **Reset** restores every road and metric back to baseline so we can test another scenario cleanly. Thanks—happy to take your questions!"

---

## Judge Q&A Quick Notes
- **How was the simulator verified?** We tested core closure rerouting, total route disconnection (`avgCarTravelMinutes: null`), Reset state restoration, and exact trip conservation (`completedCarTrips + unservedCarTrips + carTripsShiftedToBus == totalCarTrips`) against FastAPI endpoints, documented in `testing/test-plan.md`.
- **Team Roles:** Sizar built the Python/FastAPI simulation backend (`GET /api/network`, `POST /api/simulate`); our frontend teammate built the interactive HTML/CSS/JS map and before/after comparison UI; I verified the Princeton map corridors, built the test plan/script, and led the demo.
