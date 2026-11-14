# Princeton Traffic Lab — Judge Demo Script (`demo/demo-script.md`)

**Target Runtime:** 1 minute 45 seconds – 2 minutes 00 seconds (Strict 2:00 HackPrinceton judging cap)  
**Presenter:** Map Research, Testing & Demo Lead (with Sizar & Frontend Teammate standing by)  
**Pre-Demo Setup Checklist:**
- Browser open to Princeton Traffic Lab at default **Baseline** view (no closures, 0 extra lanes, 0 signals, 0% bus shift).
- Map centered on Nassau Street, Washington Road, Julis Romo Rabinowitz Building (JRR), Mercer/Alexander Streets, and Princeton Station.

---

## 0:00 – 0:25 | Hook & Map Orientation ("We're right here")
> **[Point to the Julis Romo Rabinowitz Building / Washington Road on the screen]**
>
> "Hi! We're **Princeton Traffic Lab**, and **we're right here**—outside the Julis Romo Rabinowitz Building on Washington Road, between Nassau Street and Princeton Station.
>
> All 10 road segments and 9 intersections on this map are real Princeton corridors—and we explicitly excluded the restricted northern stretch of University Place from our car detour in favor of confirmed public two-way streets—while our baseline volumes, capacities, and travel times are clearly labeled simulation assumptions."

---

## 0:25 – 0:55 | Run "HackPrinceton Let-Out" (Baseline vs. Closure)
> **[Trigger the "HackPrinceton Let-Out" scenario / close `wash_mid` outside JRR]**
>
> "Now imagine **HackPrinceton Let-Out**—hundreds of people leaving this building at once while Washington Road right outside (`wash_mid`) is closed for event safety.
>
> Look at the map: car trips on that closed Washington Road segment drop to **zero**, and traffic immediately reroutes west along **Nassau Street**, onto **Mercer Street**, and south down **Alexander Street** toward Princeton Station. In the summary panel, you can see our before-and-after comparison—average car travel time rises as that public detour absorbs the extra volume, while total trips stay conserved."

---

## 0:55 – 1:35 | Interactive Judge Choice (Live Mitigation)
> **[Gesture to the control panel]**
>
> "Now you're the traffic planner—pick one change to relieve this bottleneck:
> 1. **Add a lane** on Alexander Street (`alex_north`) to widen the detour corridor,
> 2. **Add a traffic signal** at Nassau & University (`int_nassau_univ`) or Washington & Prospect (`int_wash_prospect`) and tune its green-light share, or
> 3. **Enable the TigerTransit bus shift** to move a percentage of drivers onto the campus shuttle to Princeton Station."
>
> **[Apply the judge's chosen change and point to the updated map + metrics]**
>
> "Look at what changed: [point to the highlighted road segment where congestion eased]—traffic volume shifted off the bottleneck, `carTripsShiftedToBus` and `avgCarTravelMinutes` updated immediately against the baseline, and every single trip is still accounted for between completed, shifted, and unserved trips."

---

## 1:35 – 1:55 | Reset & Close
> **[Click Reset to return all controls to `[]`, `{}`, `[]`, `0`]**
>
> "One click on **Reset** clears every closure, lane, signal, and bus shift back to baseline so planners can test another combination—or even cut both corridors to verify that disconnected routes return `null` travel time instead of a misleading zero. Thanks—happy to answer any questions!"

---

## Judge Q&A Quick Notes (Keep Handy)
- **What did each teammate build?** Sizar built the Python/FastAPI simulation engine (`GET /api/network`, `POST /api/simulate`); our frontend teammate built the interactive HTML/CSS/JS map and before/after dashboard; I verified the Princeton corridors on `map.princeton.edu`, wrote the test plan and Python verification script (`testing/test-plan.md`, `testing/run_tests.py`), and designed this demo.
- **How do we verify the math?** Every scenario is checked so that completed car trips, `unservedCarTrips`, and `carTripsShiftedToBus` sum to the original trip count, closed roads carry `0` trips, and completely severed routes return `null`.
