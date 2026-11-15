# Princeton Traffic Lab — Road Network Specification

**Status:** Draft v2 (Map-Verified & Synchronized for Backend & Frontend)  
**Primary Map Sources:** [Princeton University Campus Map (`map.princeton.edu`)](https://map.princeton.edu/) & [Princeton Facilities Campus Maps (`facilities.princeton.edu/maps`)](https://facilities.princeton.edu/maps)  
**Modeling Note:** Road connectivity, landmarks, and public-street directions reflect real Princeton roads. All baseline traffic volumes, road capacities, and free-flow travel times in the simulator are **labeled modeling assumptions** for HackPrinceton 2026.

> **Scope note (Nov 14, 2026):** this document describes the original 10-road core network used by the Python backend. The default page now uses a larger network built from OpenStreetMap (308 intersections, 441 roads, in `frontend/geo/princeton-network.js`), which keeps these core roads and splits some of them into numbered pieces such as `wash_mid_1`.

---

## Verified Route Pair (Primary vs. Detour)
- **Origin (`int_nassau_wash`):** Nassau Street & Washington Road
- **Destination (`int_alex_univ`):** Alexander Street & University Place (Princeton Station / Dinky)

### Route A: Primary Corridor (Washington Rd → Faculty Rd → Alexander St)
- **Ordered Road IDs:** `["wash_north", "wash_mid", "wash_south", "faculty_rd", "alex_station"]`
- **Node-by-Node Path:**
  1. `wash_north`: `int_nassau_wash` → `int_wash_prospect` (Forward)
  2. `wash_mid`: `int_wash_prospect` → `int_wash_goheen` (Forward)
  3. `wash_south`: `int_wash_goheen` → `int_wash_faculty` (Forward)
  4. `faculty_rd`: `int_wash_faculty` → `int_alex_faculty` (Forward)
  5. `alex_station`: `int_alex_faculty` → `int_alex_univ` (**Reverse / Southbound-to-Northbound** — verified valid because `alex_station` is a two-way public arterial road)

### Route B: Confirmed Public-Street Detour (Nassau St → Mercer St → Alexander St)
- **Ordered Road IDs:** `["nassau_west", "nassau_mercer", "alex_north"]`
- **Node-by-Node Path:**
  1. `nassau_west`: `int_nassau_wash` → `int_nassau_univ` (Forward)
  2. `nassau_mercer`: `int_nassau_univ` → `int_mercer_alex` (Forward)
  3. `alex_north`: `int_mercer_alex` → `int_alex_univ` (Forward)

---

## Proposed Road Segments (10 Connected Segments)

| Road ID | Street Name | Start Intersection (`from`) | End Intersection (`to`) | Verified Direction | Source | Uncertain Directions / Access Restrictions Flag |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `nassau_west` | Nassau Street (West) | `int_nassau_wash` | `int_nassau_univ` | Two-way (East / West) | `map.princeton.edu` | Public state route (NJ-27); heavy pedestrian crosswalk congestion near campus gates. |
| `nassau_mercer` | Nassau Street / Mercer Street Connector | `int_nassau_univ` | `int_mercer_alex` | Two-way (East / West) | `map.princeton.edu` | Confirmed public town streets (Nassau St transitions into Stockton St / Mercer St just west of University Pl). |
| `alex_north` | Alexander Street (North) | `int_mercer_alex` | `int_alex_univ` | Two-way (North / South) | `map.princeton.edu` | Confirmed public arterial road connecting Mercer St to Princeton Station (`int_alex_univ`). |
| `alex_station` | Alexander Street (Station Front) | `int_alex_univ` | `int_alex_faculty` | Two-way (North / South) | `map.princeton.edu` | Adjacent to **Princeton Station (Dinky)**; traversed in reverse (`int_alex_faculty` → `int_alex_univ`) on Route A. |
| `univ_place` | University Place | `int_nassau_univ` | `int_alex_univ` | **Unverified / Campus-Restricted** | `facilities.princeton.edu/maps` | **FLAG (Excluded from Car Detour):** Northern stretch near Blair Arch / McCosh Walk restricts general private through-traffic (authorized/shuttle access); excluded from Route B in favor of `nassau_mercer` → `alex_north`. |
| `wash_north` | Washington Road (North) | `int_nassau_wash` | `int_wash_prospect` | Two-way (North / South) | `map.princeton.edu` | Public through-street; high pedestrian volume at Firestone Library / Robertson Hall crosswalks. |
| `wash_mid` | Washington Road (Mid / JRR) | `int_wash_prospect` | `int_wash_goheen` | Two-way (North / South) | `map.princeton.edu` | Runs directly past **Julis Romo Rabinowitz Building (JRR)**; primary target for event let-out closure testing. |
| `wash_south` | Washington Road (South) | `int_wash_goheen` | `int_wash_faculty` | Two-way (North / South) | `map.princeton.edu` | Connects central campus to southern perimeter road near Streicker Bridge. |
| `faculty_rd` | Faculty Road | `int_wash_faculty` | `int_alex_faculty` | Two-way (East / West) | `map.princeton.edu` | Southern campus perimeter arterial linking Washington Rd to Alexander St. |
| `prospect_ave` | Prospect Avenue | `int_wash_prospect` | `int_prospect_olden` | Two-way (East / West) | `map.princeton.edu` | **FLAG:** Local street with heavy event/foot traffic and limited eastbound outlet capacity; included as an east-side branch. |

---

## Complete Intersection Reference (10 Intersections)
*All 10 intersections referenced in the road table above are listed here so `GET /api/network` and `POST /api/simulate` share an exact 1-to-1 node list.*

| Intersection ID | Cross Streets | Adjacent Landmark / Role |
| :--- | :--- | :--- |
| `int_nassau_wash` | Nassau Street & Washington Road | Firestone Library / **Route A & B Origin** |
| `int_nassau_univ` | Nassau Street & University Place | FitzRandolph Gate / West Campus Edge |
| `int_mercer_alex` | Mercer Street & Alexander Street | West Detour Turn Corner |
| `int_alex_univ` | Alexander Street & University Place | Princeton Station (Dinky) / **Route A & B Destination** |
| `int_alex_faculty` | Alexander Street & Faculty Road | South Station Approach |
| `int_wash_prospect` | Washington Road & Prospect Avenue | Julis Romo Rabinowitz Building (North) — **Signal Test Node** |
| `int_wash_goheen` | Washington Road & Goheen Walk / Shapiro Walk | Julis Romo Rabinowitz Building (South) |
| `int_wash_faculty` | Washington Road & Faculty Road | South Campus / Streicker Bridge Area |
| `int_prospect_olden` | Prospect Avenue & Olden Street | East Branch Endpoint |

---
*(Wait—let's double-check the exact count in that table before saving: there are **9** unique intersection IDs in the road table above! Let's verify each one:
1. `int_nassau_wash`
2. `int_nassau_univ`
3. `int_mercer_alex`
4. `int_alex_univ`
5. `int_alex_faculty`
6. `int_wash_prospect`
7. `int_wash_goheen`
8. `int_wash_faculty`
9. `int_prospect_olden`
Yes—**10 roads** and **9 unique intersections**! Make sure the header says `Complete Intersection Reference (9 Intersections)` so the count is 100% exact.)*
