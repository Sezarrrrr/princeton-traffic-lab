# Traffix Lab — Judge Demo Script (`demo/demo-script.md`)

**Target runtime:** 1:45 to 2:00 (strict 2:00 HackPrinceton judging cap)
**Presenter:** Map Research, Testing & Demo Lead (Sizar and Ben standing by)
**Version:** `main`, in-browser simulator (308 intersections, 441 roads). Every number below was checked on this version on Nov 14, 2026. Re-check them if the simulator changes.

**Pre-demo checklist:**
- Page open at `http://127.0.0.1:5501/` (or the hosted site), **Map** view, no changes.
- Status line reads "In-browser simulator · 308 intersections · 441 roads".
- Headline tile "Avg. trip" shows **7.8 min**.
- Open `tests.html` once beforehand and confirm "All 12 checks passed".
- No Wi-Fi? Click **Schematic**. Every control works the same there.

---

## 0:00 – 0:25 | Hook and orientation ("We're right here")
> **[Point to the "You are here" marker on Washington Road]**
>
> "Hi! We're **Traffix Lab**, and **we're right here**, on Washington Road between Nassau Street and Princeton Station.
>
> Every road and intersection on this map is real, from OpenStreetMap: about 440 road segments across Princeton. The traffic is simulated. Our volumes, capacities and signal timings are labeled assumptions. Right now 200 cars are leaving this building for the station, on top of normal background traffic."

---

## 0:25 – 0:55 | Run "Demo: Let-Out" (original vs. closure)
> **[Click "Demo: Let-Out"]**
>
> "Now imagine Washington Road right outside is closed for event safety while everyone leaves.
>
> The closed stretch drops to **zero** cars. Traffic reroutes west along **Nassau Street** and down **Alexander Street**, and some of it finds Faculty Road and Elm Drive. The average trip goes from **7.8 to 8.5 minutes**, and Alexander Street is now carrying about twice its capacity. Every trip is still counted: you can see the check mark here."
>
> **[Point to the red roads, then the "Avg. trip" tile and the "all trips counted" badge]**

---

## 0:55 – 1:35 | Judge's choice (live fix)
> "Now you're the traffic planner. Pick one:
> 1. **Add a lane** on the worst bottleneck,
> 2. **Change an intersection**: swap a stop sign for a signal, or retime a light, or
> 3. **See it in 3D.**"

**If they pick 1:** click **Alexander St (College Rd to University Pl)**, press **+** on extra lanes.
> "One extra lane on that block brings the average back down to **8.3 minutes**. It helps, but it doesn't undo the closure, because the next block becomes the bottleneck."

**If they pick 2:** click an intersection on Alexander Street or Nassau Street, change its control or drag the green split.
> "Each control type has its own delay formula. Watch the junction wait and the approach table update as I change it."
> *(Don't promise a direction. Read the number that appears.)*

**If they pick 3:** click **3D**.
> "Same simulation, on a 3D map with real building shapes. Roads are colored by congestion and the cars move at the simulated speed."

**Don't offer the bus during the closure.** The bus route runs on Washington Road, so it is suspended while that road is closed, and the page says so.

---

## 1:35 – 1:55 | Reset and close
> **[Click Reset]**
>
> "**Reset** clears every change so you can test another idea. You can also add your own trip between any two places, change speed limits, or close enough roads that trips can't be completed, in which case we report them as unserved instead of hiding them. Thanks! Happy to take questions."

---

## Judge Q&A quick notes
- **What did each teammate build?** Sizar built the Python/FastAPI backend (`/api/network`, `/api/simulate`). Ben built the frontend: the map views, the in-browser simulator, and the controls and panels. I researched the Princeton corridors, wrote the test plan (`testing/test-plan.md`) and designed the demo.
- **Which simulator is running?** The in-browser one (`frontend/sim/engine.js`). The Python backend is a smaller 10-road model, available with `?api=real`.
- **How do you check the math?** `tests.html` runs 12 automated checks on the in-browser simulator, and the backend has 6 unit tests. For example: completed + unserved + bus trips always equals total trips, closed roads carry zero cars, and closing every road gives no average instead of a misleading 0.
- **Is the traffic data real?** No. Roads and mapped signals, stop signs and roundabouts are from OpenStreetMap. Volumes, capacities and timings are assumptions, and the model isn't calibrated against real counts.
- **What doesn't it model?** One 15-minute period only: no queues building over time, no turn restrictions, no pedestrians or bikes, and bus travel time isn't simulated.
- **What libraries did you use?** Leaflet (2D map), MapLibre GL JS with OpenFreeMap tiles (3D), OpenStreetMap data, and FastAPI for the backend. Everything else was written this weekend.
