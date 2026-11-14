# Princeton Traffic Lab — Judge Demo Script (`demo/demo-script.md`)

**Target Runtime:** 1 minute 45 seconds – 2 minutes 00 seconds (Strict 2:00 HackPrinceton judging cap)  
**Presenter:** Map Research, Testing & Demo Lead (with Sizar & Frontend Teammate standing by)  
**Pre-Demo Setup Checklist:**
- Browser open to Princeton Traffic Lab at default **Baseline** view (no closures, 0 extra lanes, 0 signals, 0% bus shift).
- Map centered on Nassau Street, Washington Road, Julis Romo Rabinowitz Building (JRR), and Princeton Station.

---

## 0:00 – 0:25 | Hook & Map Orientation ("We're right here")
> **[Point to the Julis Romo Rabinowitz Building / Washington Road on the screen]**
>
> "Hi! We're **Princeton Traffic Lab**, and **we're right here**—outside the Julis Romo Rabinowitz Building on Washington Road, between Nassau Street and Princeton Station.
>
> All the roads and intersections on this map are real Princeton corridors, while our baseline volumes, capacities, and travel times are clearly labeled simulation assumptions. Right now, you're seeing normal baseline traffic flow across 9 connected road segments."

---

## 0:25 – 0:55 | Run "HackPrinceton Let-Out" (Baseline vs. Closure)
> **[Trigger the "HackPrinceton Let-Out" scenario / close `wash_mid` outside JRR]**
>
> "Now imagine **HackPrinceton Let-Out**—hundreds of people leaving this building at once while Washington Road right outside (`wash_mid`) is closed for event safety.
>
> Look at the map: car trips on that closed Washington Road segment drop to **zero**, and traffic immediately reroutes west along **Nassau Street** and down **University Place** toward Princeton Station. In the summary panel, you can see our before-and-after comparison—average car travel time rises because that detour corridor absorbs the extra volume, while total trips stay conserved."

---

## 0:55 – 1:35 | Interactive Judge Choice (Live Mitigation)
> **[Gesture to the control panel]**
>
> "Now you're the traffic planner—pick one change to relieve this bottleneck:
> 1. **Add a lane** on University Place (`univ_place`) to widen the detour,
> 2. **Add a traffic signal** at Washington & Prospect or Nassau & University and tune its green-light share, or
> 3. **Enable the TigerTransit bus shift** to move a percentage of drivers onto the campus shuttle to Princeton Station."
>
> **[Apply the judge's chosen change and point to the updated map + metrics]**
>
> "Look at what changed: [point to the highlighted road segment where congestion eased]—traffic volume shifted off the bottleneck, `carTripsShiftedToBus` / `avgCarTravelMinutes` updated immediately against the baseline, and every single trip is still accounted for between completed, shifted, and unserved trips."

---

## 1:35 – 1:55 | Reset & Close
> **[Click Reset to return all controls to `[]`, `{}`, `[]`, `0`]**
>
> "One click on **Reset** clears every closure, lane, signal, and bus shift back to baseline so planners can test another combination—or even see what happens when every route is cut and average travel time becomes `null`. Thanks—happy to answer any questions!"

---

## Judge Q&A Quick Notes (Keep Handy)
- **What did each teammate build?** Sizar built the Python/FastAPI simulation engine (`/api/network`, `/api/simulate`); our frontend teammate built the interactive HTML/CSS/JS map and before/after dashboard; I researched the Princeton campus corridors, wrote the test suite (`testing/test-plan.md`), and designed the demo.
- **How do we verify the math?** Every scenario is tested to ensure `completed car trips + unservedCarTrips + carTripsShiftedToBus == original car trips`, closed roads always carry `0` trips, and completely disconnected routes return `null` instead of a misleading `0` travel time.
