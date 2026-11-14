# Build the EXPANDED road network for the in-browser simulator from OpenStreetMap data.
#   py build_network.py osm_expanded.json ../princeton-geo.js ../princeton-network.js
#
# How it works:
#   1. Keep every primary / secondary / tertiary street in BBOX, plus the downtown streets in
#      NAMED_STREETS. Streets are cut at the BBOX edge; the cut points become "gateways" where
#      background traffic enters and leaves.
#   2. A junction is an OSM node shared by two different kept streets (or two street ends less than
#      20 m apart). Junction nodes closer than 40 m are one intersection, and every OSM roundabout
#      that joins two kept streets is one intersection. The 9 core intersections keep their IDs.
#   3. Each road segment is the path along one street between two neighbouring intersections,
#      following one-way rules; two carriageways between the same intersections make one two-way road.
#   4. Segments that lie along a core road keep its ID (or core_id_1, core_id_2, ... if split).
#      Lanes, one-way and speed come from OSM tags where present.
#   5. Intersection controls come from OSM where mapped (traffic_signals, stop, give_way nodes and
#      junction=roundabout ways). Unmapped junctions get an ASSUMED two-way stop for the smaller street.
#   6. Only the largest connected part of the network is kept.
import json, sys, math, heapq, re
from collections import defaultdict

OSM, GEO_JS, NET_JS = sys.argv[1:4]
BBOX = (40.322, -74.700, 40.372, -74.615)  # south, west, north, east
# In the town core (downtown, campus and the neighbourhoods around them) side streets are kept too.
TOWN_BOX = (40.334, -74.682, 40.362, -74.640)
MAJOR = {"primary", "secondary", "tertiary"}
LOCAL = {"unclassified", "residential", "living_street"}
NAMED_STREETS = {
    "Nassau Street", "Washington Road", "Mercer Street", "Alexander Street", "University Place",
    "Faculty Road", "Prospect Avenue", "Olden Street", "Witherspoon Street", "Vandeventer Avenue",
    "Harrison Street", "South Harrison Street", "North Harrison Street", "William Street",
    "Chambers Street", "Palmer Square West", "Palmer Square East", "Wiggins Street",
    "Paul Robeson Place", "Elm Drive", "Charlton Street", "Moore Street", "Hulfish Street",
}
FAMILY = {"South Harrison Street": "Harrison Street", "North Harrison Street": "Harrison Street"}
SHORT = {"Street": "St", "Road": "Rd", "Avenue": "Ave", "Place": "Pl", "Drive": "Dr", "Square": "Sq", "Lane": "Ln", "Boulevard": "Blvd", "Pike": "Pk"}
CLASS_RANK = {"primary": 5, "secondary": 4, "tertiary": 3, "unclassified": 2, "residential": 2, "living_street": 1, "service": 1}
GATEWAY_WEIGHT = {"primary": 3, "secondary": 2, "tertiary": 1}
DEFAULT_MPH = {"service": 15, "living_street": 15}
LANDMARKS = {
    "jrr": "Julis Romo Rabinowitz Building", "nassau_hall": "Nassau Hall", "firestone": "Firestone Library",
    "chapel": "Princeton University Chapel", "frist": "Frist Campus Center", "art_museum": "Princeton University Art Museum",
    "palmer_square": "Palmer Square", "library": "Princeton Public Library", "jadwin": "Jadwin Gymnasium",
    "friend_center": "Friend Center", "lewis_library": "Lewis Library", "seminary": "Princeton Theological Seminary",
    "shopping_center": "Princeton Shopping Center", "ias": "Institute for Advanced Study", "high_school": "Princeton High School",
    "battlefield": "Princeton Battlefield State Park", "stadium": "Powers Field at Princeton Stadium", "marquand": "Marquand Park",
    "cemetery": "Princeton Cemetery", "dillon": "Dillon Gymnasium", "westminster": "Westminster Choir College",
}

def dist(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))

def inside(p):
    return BBOX[0] <= p[0] <= BBOX[2] and BBOX[1] <= p[1] <= BBOX[3]

def short(name):
    return " ".join(SHORT.get(w, w) for w in name.split())

def slug(name):
    words = [w for w in re.sub(r"[^a-z ]", "", name.lower()).split() if w not in ("street", "road", "avenue", "place", "drive", "square", "lane", "north", "south", "boulevard")]
    return "_".join(words) or "road"

def near_pairs(items, radius):
    """items: list of (key, (lat, lon)). Yields pairs closer than radius (meters), using a grid."""
    cell = radius / 111000 * 1.5
    grid = defaultdict(list)
    for k, p in items:
        grid[(int(p[0] / cell), int(p[1] / cell))].append((k, p))
    for (gx, gy), lst in grid.items():
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                other = grid.get((gx + dx, gy + dy))
                if not other:
                    continue
                for k1, p1 in lst:
                    for k2, p2 in other:
                        if k1 < k2 and dist(p1, p2) < radius:
                            yield k1, k2

osm = json.load(open(OSM, encoding="utf-8"))
geo_text = open(GEO_JS, encoding="utf-8").read()
geo_header = geo_text[:geo_text.index("const ROAD_GEOMETRY")]
GEO = json.loads(geo_text[geo_text.index("{"):geo_text.rindex("}") + 1])
CORE_NAMES = {
    "nassau_west": "Nassau Street (West)", "nassau_mercer": "Nassau / Mercer Connector",
    "alex_north": "Alexander Street (North)", "alex_station": "Alexander Street (Station Front)",
    "univ_place": "University Place", "wash_north": "Washington Road (North)",
    "wash_mid": "Washington Road (Mid / JRR)", "wash_south": "Washington Road (South)",
    "faculty_rd": "Faculty Road", "prospect_ave": "Prospect Avenue",
}
CORE_INTER_NAMES = {
    "int_nassau_wash": "Nassau St & Washington Rd", "int_nassau_univ": "Nassau St & University Pl",
    "int_mercer_alex": "Mercer St & Alexander St", "int_alex_univ": "Alexander St & University Pl",
    "int_alex_faculty": "Alexander St & Faculty Rd", "int_wash_prospect": "Washington Rd & Prospect Ave",
    "int_wash_goheen": "Washington Rd & Goheen Walk", "int_wash_faculty": "Washington Rd & Faculty Rd",
    "int_prospect_olden": "Prospect Ave & Olden St",
}
# Only the 10 shared core roads count as "core", even when re-running on an already expanded file.
CORE_INTER = {k: GEO["intersections"][k] for k in CORE_INTER_NAMES}
CORE_ROADS = {k: GEO["roads"][k] for k in CORE_NAMES}
GEO["intersections"] = dict(CORE_INTER)
GEO["roads"] = dict(CORE_ROADS)
GEO["landmarks"] = {"jrr": GEO["landmarks"]["jrr"]}

# ---- 1. Street graph (clipped to BBOX) ----
coords, way_tags = {}, {}
edges = defaultdict(list)          # node -> [(other, meters, street, way_id, allowed_in_this_direction)]
node_streets = defaultdict(set)
way_ends, boundary = [], {}        # boundary: node -> highway class of the street that leaves BBOX there
roundabouts, control_nodes = [], []
for el in osm["elements"]:
    t = el.get("tags", {})
    if el["type"] == "node" and t.get("highway") in ("traffic_signals", "stop", "give_way"):
        control_nodes.append((t["highway"], t.get("stop"), (el["lat"], el["lon"]), el["id"]))
        continue
    if el["type"] != "way":
        continue
    if t.get("junction") == "roundabout":
        roundabouts.append(el)
    name, hw = t.get("name"), t.get("highway")
    in_town = any(TOWN_BOX[0] <= g["lat"] <= TOWN_BOX[2] and TOWN_BOX[1] <= g["lon"] <= TOWN_BOX[3] for g in el.get("geometry", []))
    if not name or not hw or not (name in NAMED_STREETS or hw in MAJOR or (hw in LOCAL and in_town)):
        continue
    street = FAMILY.get(name, name)
    way_tags[el["id"]] = t
    ids = el["nodes"]
    pts = [(g["lat"], g["lon"]) for g in el["geometry"]]
    for nid, p in zip(ids, pts):
        if inside(p):
            coords[nid] = p
            node_streets[nid].add(street)
    oneway = t.get("oneway") in ("yes", "1", "true") or t.get("junction") == "roundabout"
    reverse = t.get("oneway") == "-1"
    for (a, pa), (b, pb) in zip(zip(ids, pts), zip(ids[1:], pts[1:])):
        ia, ib = inside(pa), inside(pb)
        if ia and ib:
            d = dist(pa, pb)
            edges[a].append((b, d, street, el["id"], not reverse))
            edges[b].append((a, d, street, el["id"], not oneway))
        elif (ia or ib) and hw in MAJOR:
            boundary[a if ia else b] = hw
    inside_ids = [n for n, p in zip(ids, pts) if inside(p)]
    if inside_ids:
        way_ends.append((inside_ids[0], street)); way_ends.append((inside_ids[-1], street))

street_nodes = defaultdict(set)
for n, ss in node_streets.items():
    for s in ss:
        street_nodes[s].add(n)

# ---- 2. Junctions and intersection clusters ----
junction = {n for n, ss in node_streets.items() if len(ss) >= 2}
end_items = [(f"{n}|{s}", coords[n]) for n, s in way_ends]
for k1, k2 in near_pairs(end_items, 20):
    (a, sa), (b, sb) = k1.split("|", 1), k2.split("|", 1)
    if sa != sb:
        junction.update((int(a), int(b)))
junction.update(boundary)
forced = {}
for cid, ll in CORE_INTER.items():
    n = min(coords, key=lambda k: dist(coords[k], ll))
    forced[cid] = n
    junction.add(n)

parent = {}
def find(n):
    parent.setdefault(n, n)
    while parent[n] != n:
        parent[n] = parent[parent[n]]
        n = parent[n]
    return n
def union(a, b):
    parent[find(a)] = find(b)

# Roundabouts: every kept-street node on (or within 20 m of) the ring becomes one intersection.
roundabout_roots = set()
for ra in roundabouts:
    ring = [(g["lat"], g["lon"]) for g in ra["geometry"]]
    if not any(inside(p) for p in ring):
        continue
    touching = [n for n in coords if min(dist(coords[n], p) for p in ring[::2] + ring[-1:]) < 20] if len(ring) < 80 else []
    if len({s for n in touching for s in node_streets[n]}) >= 2 or len(touching) >= 3:
        for n in touching:
            junction.add(n)
            union(n, touching[0])
        roundabout_roots.add(touching[0])
for n in junction:
    find(n)
for a, b in near_pairs([(n, coords[n]) for n in junction], 40):
    union(a, b)
clusters = defaultdict(set)
for n in junction:
    clusters[find(n)].add(n)
cluster_of = {n: root for root, ns in clusters.items() for n in ns}
roundabout_clusters = {find(n) for n in roundabout_roots}

def cluster_streets(root):
    return set().union(*(node_streets[n] for n in clusters[root]))

# ---- 3. Segments along each street ----
ends_by_street = defaultdict(set)
for n, s in way_ends:
    ends_by_street[s].add(n)
def bridges_for(street):
    # Close small gaps between the ENDS of OSM ways (e.g. unnamed roundabout pieces). Only way ends,
    # so a bridge can't hop around an intersection in the middle of a way.
    out = defaultdict(list)
    for a, b in near_pairs([(n, coords[n]) for n in ends_by_street[street]], 35):
        d = dist(coords[a], coords[b])
        if d > 0:
            out[a].append((b, 3 * d)); out[b].append((a, 3 * d))
    return out

def lanes_on(a, b):
    for x in edges[a]:
        if x[0] == b:
            t = way_tags[x[3]]
            m = re.match(r"\d+", t.get("lanes", ""))
            one = t.get("oneway") in ("yes", "1", "-1", "true") or t.get("junction") == "roundabout"
            if m:
                return max(1, int(m.group()) if one else int(m.group()) // 2)
            return 1
    return None

found = defaultdict(dict)  # (rootA, rootB, street) sorted -> {+1: (path a->b, m), -1: (path b->a, m)}
for street in sorted(street_nodes):
    br = bridges_for(street)
    roots = {cluster_of[n] for n in street_nodes[street] if n in cluster_of}
    for ra in roots:
        sources = [n for n in clusters[ra] if street in node_streets[n]]
        best = {n: 0 for n in sources}
        prev = {}
        heap = [(0, n) for n in sources]
        heapq.heapify(heap)
        reached = {}
        while heap:
            d, n = heapq.heappop(heap)
            if d > best.get(n, float("inf")):
                continue
            rc = cluster_of.get(n)
            if rc is not None and rc != ra:
                reached.setdefault(rc, n)
                continue
            nxt = [(m, w) for m, w, s, _, ok in edges[n] if s == street and ok] + br[n]
            for m, w in nxt:
                if d + w < best.get(m, float("inf")):
                    best[m], prev[m] = d + w, n
                    heapq.heappush(heap, (d + w, m))
        for rb, end in reached.items():
            path = [end]
            while path[-1] in prev:
                path.append(prev[path[-1]])
            path.reverse()
            key = tuple(sorted((ra, rb))) + (street,)
            sign = 1 if ra == key[0] else -1
            old = found[key].get(sign)
            if old is None or old[1] > best[end]:
                found[key][sign] = (path, best[end])

segments = {}
for key, dirs in found.items():
    a, b, street = key
    fw, bw = dirs.get(1), dirs.get(-1)
    path, meters = fw if fw else (bw[0][::-1], bw[1])
    if meters < 5:
        continue
    oneway = 0 if fw and bw else (1 if fw else -1)
    travel = fw[0] if fw else bw[0]
    lane_vals = [v for v in (lanes_on(x, y) for x, y in zip(travel, travel[1:])) if v]
    lanes = max(set(lane_vals), key=lane_vals.count) if lane_vals else 1
    segments[key] = {"street": street, "a": a, "b": b, "nodes": path, "meters": meters, "oneway": oneway, "lanes": lanes}

# Drop segments that run straight through another intersection (a shortcut around it).
cluster_pts = {r: [coords[n] for n in ns] for r, ns in clusters.items()}
def passes_other(s):
    pts = [coords[n] for n in s["nodes"]]
    lo = (min(p[0] for p in pts) - 0.0003, min(p[1] for p in pts) - 0.0004)
    hi = (max(p[0] for p in pts) + 0.0003, max(p[1] for p in pts) + 0.0004)
    ends = cluster_pts[s["a"]] + cluster_pts[s["b"]]
    for r, cps in cluster_pts.items():
        if r in (s["a"], s["b"]) or not any(lo[0] <= c[0] <= hi[0] and lo[1] <= c[1] <= hi[1] for c in cps):
            continue
        if not any(s["street"] in node_streets[n] for n in clusters[r]):
            continue
        for c in cps:
            for p in pts:
                if dist(p, c) < 15 and min(dist(p, e) for e in ends) > 30:
                    return True
    return False
segments = {k: s for k, s in segments.items() if not passes_other(s)}

def way_tag_mode(nodes, key):
    vals = []
    for a, b in zip(nodes, nodes[1:]):
        for x in edges[a]:
            if x[0] == b:
                vals.append(way_tags[x[3]].get(key)); break
    vals = [v for v in vals if v]
    return max(set(vals), key=vals.count) if vals else None

# ---- 6. Largest connected part ----
adj = defaultdict(set)
for s in segments.values():
    adj[s["a"]].add(s["b"]); adj[s["b"]].add(s["a"])
seen, best_comp, comps = set(), set(), []
for r in adj:
    if r in seen:
        continue
    comp, stack = set(), [r]
    while stack:
        x = stack.pop()
        if x in comp:
            continue
        comp.add(x); stack.extend(adj[x])
    seen |= comp
    comps.append(comp)
    if len(comp) > len(best_comp):
        best_comp = comp
print("segments:", len(segments), "components (intersections):", sorted((len(c) for c in comps), reverse=True)[:12])
for c in sorted(comps, key=len, reverse=True)[1:6]:
    print("   dropped part:", sorted({s for r in c for s in cluster_streets(r)})[:6])
segments = {k: s for k, s in segments.items() if s["a"] in best_comp}

# ---- Intersection IDs, names, positions ----
def street_class(root, street):
    return max((CLASS_RANK.get(way_tags[x[3]].get("highway"), 1) for n in clusters[root] for x in edges[n] if x[2] == street), default=1)
root_id, inter = {}, {}
for cid, n in forced.items():
    root_id[cluster_of[n]] = cid
used = set(root_id.values())
for r in sorted(best_comp, key=lambda r: coords[r]):
    if r in root_id:
        continue
    ss = sorted(cluster_streets(r), key=lambda s: (-street_class(r, s), s))
    base = "int_" + "_".join(slug(s) for s in ss[:2])
    if r in boundary or any(n in boundary for n in clusters[r]):
        if len(ss) == 1:
            base += "_edge"
    rid, k = base, 2
    while rid in used:
        rid, k = f"{base}_{k}", k + 1
    used.add(rid); root_id[r] = rid
for r in best_comp:
    rid = root_id[r]
    pts = cluster_pts[r]
    ll = CORE_INTER.get(rid) or [round(sum(p[0] for p in pts) / len(pts), 6), round(sum(p[1] for p in pts) / len(pts), 6)]
    ss = sorted(cluster_streets(r), key=lambda s: (-street_class(r, s), s))
    is_edge = any(n in boundary for n in clusters[r])
    name = CORE_INTER_NAMES.get(rid) or (" & ".join(short(s) for s in ss[:3]) if len(ss) > 1 else f"{short(ss[0])} (edge of map)" if is_edge else short(ss[0]))
    inter[rid] = {"id": rid, "name": name, "latLng": ll, "streets": sorted(ss), "root": r, "edge": is_edge}

# ---- Roads: keep core IDs where the segment follows a core road ----
CORE_STREETS = {
    "nassau_west": {"Nassau Street"}, "nassau_mercer": {"Nassau Street", "Mercer Street"},
    "alex_north": {"Alexander Street"}, "alex_station": {"Alexander Street"}, "univ_place": {"University Place"},
    "wash_north": {"Washington Road"}, "wash_mid": {"Washington Road"}, "wash_south": {"Washington Road"},
    "faculty_rd": {"Faculty Road"}, "prospect_ave": {"Prospect Avenue"},
}
def on_core(nodes, core_pts, street=None, cid=None):
    if cid and street not in CORE_STREETS[cid]:
        return False
    pts = [coords[n] for n in nodes]
    return sum(min(dist(p, q) for q in core_pts) < 10 for p in pts) / len(pts) >= 0.8

roads, core_parts = [], defaultdict(list)
for key, s in sorted(segments.items(), key=lambda kv: (kv[1]["street"], coords[kv[1]["a"]])):
    a_id, b_id = root_id[s["a"]], root_id[s["b"]]
    pts = [list(inter[a_id]["latLng"])] + [[round(coords[n][0], 6), round(coords[n][1], 6)] for n in s["nodes"]] + [list(inter[b_id]["latLng"])]
    clean = [pts[0]]
    for p in pts[1:]:
        if dist(p, clean[-1]) > 1:
            clean.append(p)
    length = sum(dist(p, q) for p, q in zip(clean, clean[1:]))
    hw = way_tag_mode(s["nodes"], "highway") or "residential"
    ms = way_tag_mode(s["nodes"], "maxspeed")
    mph = int(re.match(r"\d+", ms).group()) if ms and re.match(r"\d+", ms) else DEFAULT_MPH.get(hw, 25)
    road = {"from": a_id, "to": b_id, "street": s["street"], "highway": hw, "lanes": s["lanes"], "oneway": s["oneway"],
            "speedMph": mph, "lengthM": round(length), "points": clean}
    for cid, cpts in CORE_ROADS.items():
        if on_core(s["nodes"], cpts, s["street"], cid):
            core_parts[cid].append(road)
            road["core"] = cid
            break
    roads.append(road)

for cid, parts in core_parts.items():
    cpts = CORE_ROADS[cid]
    if len(parts) == 1 and {parts[0]["from"], parts[0]["to"]} == {k for k, v in CORE_INTER.items() if v in (cpts[0], cpts[-1])}:
        r = parts[0]
        r["id"], r["name"] = cid, CORE_NAMES[cid]
        if CORE_INTER[r["from"]] != cpts[0]:  # keep the core road's from -> to order
            r["from"], r["to"], r["oneway"] = r["to"], r["from"], -r["oneway"]
        r["points"] = cpts
        continue
    parts.sort(key=lambda r: min(range(len(cpts)), key=lambda i: dist(cpts[i], r["points"][len(r["points"]) // 2])))
    for i, r in enumerate(parts, 1):
        r["id"] = f"{cid}_{i}"

counters = defaultdict(int)
for r in roads:
    names = lambda iid: [p for p in inter[iid]["name"].split(" & ") if p != short(r["street"])] or [inter[iid]["name"]]
    if "name" not in r:
        a, b = names(r["from"])[0], names(r["to"])[0]
        r["name"] = f"{short(r['street'])} ({a} to {b})" if a != b else f"{short(r['street'])} (near {a})"
    if "id" not in r:
        base = slug(r["street"])
        counters[base] += 1
        r["id"] = f"{base}_{counters[base]}"

# University Pl has no car access in the shared core network (backend assumption), so it starts
# closed to cars here too. Everything else is open.
for r in roads:
    r["carAccess"] = r.get("core") != "univ_place"

# ---- Intersection controls: OSM where mapped, otherwise assumed ----
degree = defaultdict(int)
for r in roads:
    degree[r["from"]] += 1; degree[r["to"]] += 1
ctl_at = defaultdict(list)
all_junction_items = [(n, coords[n]) for r in best_comp for n in clusters[r]]
for kind, stop_tag, p, nid in control_nodes:
    best, bd = None, 40
    for n, q in all_junction_items:
        if abs(q[0] - p[0]) < 0.0005 and abs(q[1] - p[1]) < 0.0007:
            d = dist(p, q)
            if d < bd:
                best, bd = n, d
    if best is not None:
        ctl_at[cluster_of[best]].append((kind, stop_tag, nid))
for iid, it in inter.items():
    r = it["root"]
    streets = it["streets"]
    rank = {s: street_class(r, s) for s in streets}
    major = max(streets, key=lambda s: (rank[s], s))
    found_ctl = ctl_at.get(r, [])
    kinds = [k for k, _, _ in found_ctl]
    stop_streets = {s for k, _, nid in found_ctl if k in ("stop", "give_way") for s in node_streets.get(nid, ())}
    src = "osm"
    if iid == "int_alex_univ" or r in roundabout_clusters:
        ctl = {"type": "roundabout"}
    elif degree[iid] <= 2 and "traffic_signals" not in kinds:
        ctl, src = {"type": "none"}, ("osm" if not found_ctl else "osm")
    elif "traffic_signals" in kinds:
        ctl = {"type": "signal", "cycle": 90, "greenShare": 0.6, "lost": 4, "ped": 0, "major": major}
    elif any(t == "all" for _, t, _ in found_ctl) or (stop_streets and set(streets) <= stop_streets):
        ctl = {"type": "stop_all"}
    elif stop_streets:
        free = [s for s in streets if s not in stop_streets]
        ctl = {"type": "stop_minor", "major": max(free, key=lambda s: (rank[s], s)) if free else major}
    elif "stop" in kinds or "give_way" in kinds:
        ctl = {"type": "stop_minor", "major": major}
    else:
        ctl, src = {"type": "stop_minor", "major": major}, "assumed"
    if degree[iid] <= 2 and ctl["type"] == "stop_minor":
        ctl = {"type": "none"}
    if len(streets) == 1 and ctl["type"] == "stop_minor":
        ctl = {"type": "none"}
    it["control"], it["controlSource"], it["degree"] = ctl, src, degree[iid]

# ---- Gateways: where kept streets leave the map area ----
gateways = []
for iid, it in inter.items():
    if it["edge"] and degree[iid] >= 1:
        hw = max((boundary[n] for n in clusters[it["root"]] if n in boundary), key=lambda h: GATEWAY_WEIGHT[h])
        gateways.append({"id": iid, "weight": GATEWAY_WEIGHT[hw]})

# ---- Landmarks ----
places = {}
for el in osm["elements"]:
    t = el.get("tags", {})
    if "highway" in t or t.get("junction"):
        continue
    pts = el.get("geometry") or ([{"lat": el["lat"], "lon": el["lon"]}] if "lat" in el else [])
    if el["type"] == "relation":
        pts = [g for m in el.get("members", []) for g in m.get("geometry", []) if m.get("role") in ("outer", "")] or \
              [g for m in el.get("members", []) for g in m.get("geometry", [])]
    if not pts:
        continue
    ll = [round(sum(p["lat"] for p in pts) / len(pts), 6), round(sum(p["lon"] for p in pts) / len(pts), 6)]
    if t.get("railway") == "station" and t.get("name", "") == "Princeton":
        places["station"] = {"name": "Princeton Station (Dinky)", "latLng": ll}
    for k, n in LANDMARKS.items():
        if t.get("name") == n and k not in places:
            places[k] = {"name": n.replace("Powers Field at ", ""), "latLng": ll}

# ---- Write ----
for r in roads:
    if r["id"] not in CORE_ROADS:
        GEO["roads"][r["id"]] = r["points"]
for iid, it in inter.items():
    GEO["intersections"].setdefault(iid, it["latLng"])
GEO["landmarks"].update({k: v for k, v in places.items() if k != "jrr"})
with open(GEO_JS, "w", encoding="utf-8") as f:
    f.write(geo_header)
    f.write("const ROAD_GEOMETRY = " + json.dumps(GEO, separators=(",", ":")).replace("],[", "],\n  [") + ";\n")

lat0 = sum(it["latLng"][0] for it in inter.values()) / len(inter)
net = {
    "bbox": BBOX,
    "intersections": [{"id": i["id"], "name": i["name"], "streets": i["streets"], "control": i["control"], "controlSource": i["controlSource"],
                       "x": round((i["latLng"][1] - BBOX[1]) * 111320 * math.cos(math.radians(lat0))),
                       "y": round((BBOX[2] - i["latLng"][0]) * 110540)} for i in sorted(inter.values(), key=lambda i: i["id"])],
    "roads": [{k: r[k] for k in ("id", "name", "street", "from", "to", "lanes", "oneway", "speedMph", "lengthM", "carAccess", "highway")} | ({"core": r["core"]} if "core" in r else {})
              for r in sorted(roads, key=lambda r: r["id"])],
    "gateways": sorted(gateways, key=lambda g: g["id"]),
}
with open(NET_JS, "w", encoding="utf-8") as f:
    f.write("// EXPANDED road network for the in-browser simulator. Generated by geo/tools/build_network.py\n")
    f.write("// from OpenStreetMap data (c) OpenStreetMap contributors, ODbL, downloaded 2026-11-14.\n")
    f.write("// Area: most of Princeton (bbox 40.322,-74.700 to 40.372,-74.615); all primary/secondary/tertiary\n")
    f.write("// streets plus downtown streets. lanes = lanes per direction; oneway: 0 two-way, 1 only from->to,\n")
    f.write("// -1 only to->from. Lanes, one-way and speed come from OSM tags where present, otherwise 25 mph, 1 lane.\n")
    f.write("// control: from OSM traffic_signals / stop / give_way nodes and roundabouts where mapped\n")
    f.write("// (controlSource \"osm\"); unmapped junctions get an ASSUMED two-way stop (controlSource \"assumed\").\n")
    f.write("// Signal timings (90 s cycle, 60% main green) are ASSUMPTIONS. gateways = where streets leave the area.\n")
    f.write("const LOCAL_NETWORK_DATA = " + json.dumps(net, separators=(",", ":")).replace('},{"id"', '},\n{"id"') + ";\n")

types = defaultdict(int)
for it in inter.values():
    types[(it["control"]["type"], it["controlSource"])] += 1
print(len(inter), "intersections,", len(roads), "roads,", len(gateways), "gateways,", round(sum(r["lengthM"] for r in roads) / 1000, 1), "km")
print("controls:", dict(types))
print("core ids:", sorted(r["id"] for r in roads if "core" in r))
print("streets:", len({r["street"] for r in roads}))
print("places:", ", ".join(places))
