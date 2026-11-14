
# Princeton Traffic Lab — Road Network Specification

**Status:** Draft v1 (Shared Baseline for Backend & Frontend)  
**Primary Map Source:** [Princeton University Campus Map (`map.princeton.edu`)](https://map.princeton.edu/) & [Princeton Facilities Maps (`facilities.princeton.edu/maps`)](https://facilities.princeton.edu/maps)  
**Modeling Note:** Road geometry, connectivity, and landmarks reflect real Princeton roads. All baseline traffic volumes, road capacities, and free-flow travel times in the simulator are **labeled modeling assumptions** for HackPrinceton 2026.

---

## Verified Route Pair (Primary vs. Detour)
- **Origin (`int_nassau_wash`):** Nassau Street & Washington Road
- **Destination (`int_alex_univ`):** Alexander Street & University Place (Princeton Station / Dinky)
- **Route A (Primary Corridor):** `nassau_wash` → `wash_north` → `wash_mid` → `wash_south` → `faculty_rd` → `alex_station`
- **Route B (West-Side Detour):** `nassau_wash` → `nassau_west` → `univ_place` → `alex_station`

---

## Proposed Road Segments (9 Connected Segments)

| Road ID | Street Name | Start Intersection (`from`) | End Intersection (`to`) | Verified Direction | Source | Uncertain Directions / Access Restrictions Flag |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `nassau_west` | Nassau Street (West) | `int_nassau_wash` (Nassau St & Washington Rd) | `int_nassau_univ` (Nassau St & University Pl) | Two-way (East / West) | `map.princeton.edu` | Public state route (NJ-27); heavy pedestrian crosswalk congestion near campus gates. |
| `univ_place` | University Place | `int_nassau_univ` (Nassau St & University Pl) | `int_alex_univ` (Alexander St & University Pl) | Assumed Two-way (North / South) | `map.princeton.edu` | **FLAG:** Central campus stretch near Blair Arch / McCosh Walk has restricted vehicular/bus-only access; modeled as open detour corridor for simulation continuity. |
| `alex_north` | Alexander Street (North) | `int_nassau_alex` (Nassau St & Alexander St) | `int_alex_univ` (Alexander St & University Pl) | Two-way (North / South) | `map.princeton.edu` | Public arterial road; connects downtown Princeton to Princeton Station. |
| `alex_station` | Alexander Street (Station Front) | `int_alex_univ` (Alexander St & University Pl) | `int_alex_faculty` (Alexander St & Faculty Rd) | Two-way (North / South) | `map.princeton.edu` | Adjacent to **Princeton Station (Dinky)** and TigerTransit bus turnaround; frequent bus/drop-off conflict. |
| `wash_north` | Washington Road (North) | `int_nassau_wash` (Nassau St & Washington Rd) | `int_wash_prospect` (Washington Rd & Prospect Ave) | Two-way (North / South) | `map.princeton.edu` | Public through-street; high pedestrian volume at Firestone Library / Robertson Hall crosswalks. |
| `wash_mid` | Washington Road (Mid / JRR) | `int_wash_prospect` (Washington Rd & Prospect Ave) | `int_wash_goheen` (Washington Rd & Goheen Walk / Shapiro Walk) | Two-way (North / South) | `map.princeton.edu` | Runs directly past **Julis Romo Rabinowitz Building (JRR)**; primary target for event let-out congestion and closure testing. |
| `wash_south` | Washington Road (South) | `int_wash_goheen` (Washington Rd & Goheen Walk) | `int_wash_faculty` (Washington Rd & Faculty Rd) | Two-way (North / South) | `map.princeton.edu` | Connects central campus to southern perimeter road; includes Fountain of Freedom / Woodrow Wilson plaza crossings. |
| `faculty_rd` | Faculty Road | `int_wash_faculty` (Washington Rd & Faculty Rd) | `int_alex_faculty` (Alexander St & Faculty Rd) | Two-way (East / West) | `map.princeton.edu` | Southern campus perimeter arterial linking Washington Rd to Alexander St / Princeton Station. |
| `prospect_ave` | Prospect Avenue | `int_wash_prospect` (Washington Rd & Prospect Ave) | `int_prospect_olden` (Prospect Ave & Olden St) | Two-way (East / West) | `map.princeton.edu` | **FLAG:** Local street with heavy event/foot traffic and limited eastbound outlet capacity; included as an east-side feeder/spillover branch. |

---

## Key Intersections (For `signals` Payload)

| Intersection ID | Cross Streets | Adjacent Landmark |
| :--- | :--- | :--- |
| `int_nassau_wash` | Nassau Street & Washington Road | Firestone Library / North Campus Entrance |
| `int_nassau_univ` | Nassau Street & University Place | FitzRandolph Gate / West Campus Edge |
| `int_wash_prospect` | Washington Road & Prospect Avenue | Julis Romo Rabinowitz Building (North) |
| `int_wash_faculty` | Washington Road & Faculty Road | South Campus / Streicker Bridge Area |
| `int_alex_univ` | Alexander Street & University Place | Princeton Station (Dinky) |
| `int_alex_faculty` | Alexander Street & Faculty Rd | South Station Approach |

---

## Predefined Bus Route (TigerTransit / Station Connector)
- **Route Path:** `wash_north` → `wash_mid` → `wash_south` → `faculty_rd` → `alex_station`
- **Purpose:** Models shifting a percentage (`busShiftPercent`) of Julis Romo Rabinowitz / Washington Road car trips onto campus shuttle service toward Princeton Station.
