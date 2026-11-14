# Build the EXPANDED road network for the in-browser simulator from OpenStreetMap data.
#   py build_network.py osm_expanded.json ../princeton-geo.js ../princeton-network.js
#
# How it works:
#   1. Keep the OSM ways of the streets listed in STREETS.
#   2. A junction is an OSM node shared by two different chosen streets (or two street ends
#      less than 20 m apart, e.g. across a roundabout). Junction nodes closer than 40 m are one
#      intersection. The 9 intersections of the shared core network are always kept, with their IDs.
#   3. Each road segment is the path along one street between two neighbouring intersections.
#      Two one-way carriageways between the same intersections become one two-way road.
#   4. Segments that lie along a core road keep its ID (or get core_id_1, core_id_2, ... if the
#      new junctions split it). Lanes, one-way and speed come from OSM tags where present.
#   5. Only the largest connected part of the network is kept.
# Output: road geometry is merged into princeton-geo.js (core roads keep their existing shapes);
# topology, lanes, speeds, default intersection controls and landmarks go to princeton-network.js.
import json, sys, math, heapq, re
from collections import defaultdict

OSM, GEO_JS, NET_JS = sys.argv[1:4]
STREETS = {
    "Nassau Street", "Washington Road", "Mercer Street", "Alexander Street", "University Place",
    "Faculty Road", "Prospect Avenue", "Olden Street", "Witherspoon Street", "Vandeventer Avenue",
    "Harrison Street", "South Harrison Street", "North Harrison Street", "William Street",
    "Chambers Street", "Palmer Square West", "Palmer Square East", "Wiggins Street",
    "Paul Robeson Place", "Elm Drive", "Charlton Street", "Moore Street", "Hulfish Street",
}
FAMILY = {"South Harrison Street": "Harrison Street", "North Harrison Street": "Harrison Street"}
SHORT = {"Street": "St", "Road": "Rd", "Avenue": "Ave", "Place": "Pl", "Drive": "Dr", "Square": "Sq", "Lane": "Ln"}
CLASS_RANK = {"primary": 5, "secondary": 4, "tertiary": 3, "unclassified": 2, "residential": 2, "living_street": 1, "service": 1}
DEFAULT_MPH = {"service": 15, "living_street": 15}
LANDMARKS = {  # key -> OSM name (railway station matched separately)
    "jrr": "Julis Romo Rabinowitz Building", "nassau_hall": "Nassau Hall", "firestone": "Firestone Library",
    "chapel": "Princeton University Chapel", "frist": "Frist Campus Center", "art_museum": "Princeton University Art Museum",
    "palmer_square": "Palmer Square", "library": "Princeton Public Library", "jadwin": "Jadwin Gymnasium",
    "friend_center": "Friend Center", "lewis_library": "Lewis Library", "seminary": "Princeton Theological Seminary",
}

def dist(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))

def short(name):
    return " ".join(SHORT.get(w, w) for w in name.split())

def slug(name):
    words = [w for w in re.sub(r"[^a-z ]", "", name.lower()).split() if w not in ("street", "road", "avenue", "place", "drive", "square", "lane", "north", "south")]
    return "_".join(words) or "road"

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

# ---- 1. Street graph ----
coords = {}
edges = defaultdict(list)          # node -> [(other, meters, street, way_id, forward_allowed)]
way_tags = {}
node_streets = defaultdict(set)
way_ends = []
for el in osm["elements"]:
    t = el.get("tags", {})
    if el["type"] != "way" or "highway" not in t or t.get("name") not in STREETS:
        continue
    street = FAMILY.get(t["name"], t["name"])
    way_tags[el["id"]] = t
    ids = el["nodes"]
    for nid, g in zip(ids, el["geometry"]):
        coords[nid] = (g["lat"], g["lon"])
        node_streets[nid].add(street)
    oneway = t.get("oneway") in ("yes", "1", "true") or t.get("junction") == "roundabout"
    reverse = t.get("oneway") == "-1"
    for a, b in zip(ids, ids[1:]):
        d = dist(coords[a], coords[b])
        edges[a].append((b, d, street, el["id"], not reverse))
        edges[b].append((a, d, street, el["id"], not oneway))
    way_ends.append((ids[0], street)); way_ends.append((ids[-1], street))

street_nodes = defaultdict(set)
for n, ss in node_streets.items():
    for s in ss:
        street_nodes[s].add(n)

# ---- 2. Junctions and intersection clusters ----
junction = {n for n, ss in node_streets.items() if len(ss) >= 2}
for i, (a, sa) in enumerate(way_ends):
    for b, sb in way_ends[i + 1:]:
        if sa != sb and dist(coords[a], coords[b]) < 20:
            junction.update((a, b))
forced = {}
for cid, ll in CORE_INTER.items():
    n = min(coords, key=lambda k: dist(coords[k], ll))
    forced[cid] = n
    junction.add(n)

parent = {n: n for n in junction}
def find(n):
    while parent[n] != n:
        parent[n] = parent[parent[n]]
        n = parent[n]
    return n
jl = list(junction)
for i, a in enumerate(jl):
    for b in jl[i + 1:]:
        if dist(coords[a], coords[b]) < 40:
            parent[find(a)] = find(b)
clusters = defaultdict(set)
for n in junction:
    clusters[find(n)].add(n)
cluster_of = {n: root for root, ns in clusters.items() for n in ns}

def cluster_streets(root):
    return set().union(*(node_streets[n] for n in clusters[root]))

# ---- 3. Segments along each street ----
def bridges_for(street):
    # Close small gaps between the ENDS of OSM ways (e.g. unnamed roundabout pieces). Only way ends,
    # so a bridge can't hop around an intersection in the middle of a way.
    out = defaultdict(list)
    ends = sorted({n for n, s in way_ends if s == street})
    for i, a in enumerate(ends):
        for b in ends[i + 1:]:
            d = dist(coords[a], coords[b])
            if 0 < d < 35:
                out[a].append((b, 3 * d)); out[b].append((a, 3 * d))
    return out

def lanes_on(a, b):
    # Lanes in the direction of travel a -> b on the OSM way between them.
    for x in edges[a]:
        if x[0] == b:
            t = way_tags[x[3]]
            m = re.match(r"\d+", t.get("lanes", ""))
            one = t.get("oneway") in ("yes", "1", "-1", "true") or t.get("junction") == "roundabout"
            if m:
                return max(1, int(m.group()) if one else int(m.group()) // 2)
            return 1
    return None

# Directed search: follow only links cars may drive in that direction, stop at the next intersection.
found = defaultdict(dict)  # (rootA, rootB, street) sorted -> {+1: path a->b, -1: path b->a}
for street in sorted(set(FAMILY.get(s, s) for s in STREETS)):
    if street not in street_nodes:
        continue
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
    oneway = 0 if fw and bw else (1 if fw else -1)
    travel = fw[0] if fw else bw[0]
    lane_vals = [v for v in (lanes_on(x, y) for x, y in zip(travel, travel[1:])) if v]
    lanes = max(set(lane_vals), key=lane_vals.count) if lane_vals else 1
    segments[key] = {"street": street, "a": a, "b": b, "nodes": path, "meters": meters, "oneway": oneway, "lanes": lanes}

# Drop segments that run straight through another intersection (a shortcut around it).
def passes_other(s):
    pts = [coords[n] for n in s["nodes"]]
    ends = [coords[n] for n in clusters[s["a"]] | clusters[s["b"]]]
    for r, ns in clusters.items():
        if r in (s["a"], s["b"]) or not any(s["street"] in node_streets[n] for n in ns):
            continue
        for n in ns:
            for p in pts:
                if dist(p, coords[n]) < 15 and min(dist(p, e) for e in ends) > 30:
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

# ---- 5. Largest connected part ----
adj = defaultdict(set)
for s in segments.values():
    adj[s["a"]].add(s["b"]); adj[s["b"]].add(s["a"])
seen, best_comp = set(), set()
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
    if len(comp) > len(best_comp):
        best_comp = comp
segments = {k: s for k, s in segments.items() if s["a"] in best_comp}

# ---- Intersection IDs, names, positions ----
root_id, inter = {}, {}
core_root = {cid: cluster_of[n] for cid, n in forced.items()}
for cid, r in core_root.items():
    root_id[r] = cid
used = set(root_id.values())
for r in sorted(best_comp, key=lambda r: coords[r]):
    if r in root_id:
        continue
    ss = sorted(cluster_streets(r), key=lambda s: (-max(CLASS_RANK.get(way_tags[x[3]].get("highway"), 1) for n in clusters[r] for x in edges[n] if x[2] == s), s))
    base = "int_" + "_".join(slug(s) for s in ss[:2])
    rid, k = base, 2
    while rid in used:
        rid, k = f"{base}_{k}", k + 1
    used.add(rid); root_id[r] = rid
for r in best_comp:
    rid = root_id[r]
    pts = [coords[n] for n in clusters[r]]
    ll = CORE_INTER.get(rid) or [round(sum(p[0] for p in pts) / len(pts), 6), round(sum(p[1] for p in pts) / len(pts), 6)]
    ss = sorted(cluster_streets(r))
    name = CORE_INTER_NAMES.get(rid) or " & ".join(short(s) for s in ss[:3])
    inter[rid] = {"id": rid, "name": name, "latLng": ll, "streets": ss}

# ---- Roads: keep core IDs where the segment follows a core road ----
def near_line(p, line, tol=10):
    return min(dist(p, q) for q in line) < tol
def on_core(nodes, core_pts):
    pts = [coords[n] for n in nodes]
    return sum(near_line(p, core_pts) for p in pts) / len(pts) >= 0.8

roads, core_parts = [], defaultdict(list)
for key, s in sorted(segments.items(), key=lambda kv: (kv[1]["street"], coords[kv[1]["a"]])):
    a_id, b_id = root_id[s["a"]], root_id[s["b"]]
    pts = [list(inter[a_id]["latLng"])] + [[round(coords[n][0], 6), round(coords[n][1], 6)] for n in s["nodes"]] + [list(inter[b_id]["latLng"])]
    # drop duplicates / tiny jogs
    clean = [pts[0]]
    for p in pts[1:]:
        if dist(p, clean[-1]) > 1:
            clean.append(p)
    length = sum(dist(p, q) for p, q in zip(clean, clean[1:]))
    hw = way_tag_mode(s["nodes"], "highway") or "residential"
    oneway, lanes = s["oneway"], s["lanes"]
    ms = way_tag_mode(s["nodes"], "maxspeed")
    mph = int(re.match(r"\d+", ms).group()) if ms and re.match(r"\d+", ms) else DEFAULT_MPH.get(hw, 25)
    road = {"from": a_id, "to": b_id, "street": s["street"], "highway": hw, "lanes": lanes, "oneway": oneway,
            "speedMph": mph, "lengthM": round(length), "points": clean}
    for cid, cpts in CORE_ROADS.items():
        if on_core(s["nodes"], cpts):
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
    # order the pieces from the core road's start
    parts.sort(key=lambda r: min(range(len(cpts)), key=lambda i: dist(cpts[i], r["points"][len(r["points"]) // 2])))
    for i, r in enumerate(parts, 1):
        r["id"] = f"{cid}_{i}"

counters = defaultdict(int)
for r in roads:
    # Name each end by the cross street in that intersection's name (e.g. "Nassau St & Washington Rd").
    names = lambda iid: [p for p in inter[iid]["name"].split(" & ") if p != short(r["street"])] or [inter[iid]["name"]]
    if "name" not in r:
        r["name"] = f"{short(r['street'])} ({names(r['from'])[0]} to {names(r['to'])[0]})"
    if "id" not in r:
        base = slug(r["street"])
        counters[base] += 1
        r["id"] = f"{base}_{counters[base]}"

# Same street name on both sides of a junction = that street; University Pl has no car access in the
# shared core network (backend assumption), so it starts closed to cars here too.
for r in roads:
    r["carAccess"] = r.get("core") != "univ_place"

# ---- Default intersection controls (ASSUMPTIONS, not surveyed) ----
def rank(iid):
    ranks = {}
    for r in roads:
        if iid in (r["from"], r["to"]):
            ranks[r["street"]] = max(ranks.get(r["street"], 0), CLASS_RANK.get(r["highway"], 1))
    return ranks
for iid, it in inter.items():
    rk = rank(iid)
    degree = sum(iid in (r["from"], r["to"]) for r in roads)
    major = max(rk, key=lambda s: (rk[s], s)) if rk else None
    if iid == "int_alex_univ":
        ctl = {"type": "roundabout"}
    elif degree <= 2 or len(rk) <= 1:
        ctl = {"type": "none"}
    elif "Nassau Street" in rk and max(v for s, v in rk.items() if s != "Nassau Street") >= 3:
        ctl = {"type": "signal", "cycle": 90, "greenShare": 0.6, "lost": 4, "ped": 0, "major": "Nassau Street"}
    elif sorted(rk.values())[-2] >= 3:
        ctl = {"type": "stop_all"}
    else:
        ctl = {"type": "stop_minor", "major": major}
    it["control"] = ctl
    it["degree"] = degree

# ---- Landmarks ----
places = {}
for el in osm["elements"]:
    t = el.get("tags", {})
    if "highway" in t:
        continue
    pts = el.get("geometry") or ([{"lat": el["lat"], "lon": el["lon"]}] if "lat" in el else [])
    if el["type"] == "relation":
        pts = [g for m in el.get("members", []) for g in m.get("geometry", [])]
    if not pts:
        continue
    ll = [round(sum(p["lat"] for p in pts) / len(pts), 6), round(sum(p["lon"] for p in pts) / len(pts), 6)]
    if t.get("railway") == "station" and "Princeton" in t.get("name", ""):
        places["station"] = {"name": "Princeton Station (Dinky)", "latLng": ll}
    for k, n in LANDMARKS.items():
        if t.get("name") == n and k not in places:
            places[k] = {"name": n, "latLng": ll}

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
    "intersections": [{"id": i["id"], "name": i["name"], "streets": i["streets"], "control": i["control"],
                       "x": round((i["latLng"][1] + 74.66) * 111320 * math.cos(math.radians(lat0))),
                       "y": round((40.352 - i["latLng"][0]) * 110540)} for i in sorted(inter.values(), key=lambda i: i["id"])],
    "roads": [{k: r[k] for k in ("id", "name", "street", "from", "to", "lanes", "oneway", "speedMph", "lengthM", "carAccess", "highway")} | ({"core": r["core"]} if "core" in r else {})
              for r in sorted(roads, key=lambda r: r["id"])],
}
with open(NET_JS, "w", encoding="utf-8") as f:
    f.write("// EXPANDED road network for the in-browser simulator. Generated by geo/tools/build_network.py\n")
    f.write("// from OpenStreetMap data (c) OpenStreetMap contributors, ODbL, downloaded 2026-11-14.\n")
    f.write("// lanes = lanes per direction; oneway: 0 two-way, 1 only from->to, -1 only to->from.\n")
    f.write("// Lanes, one-way and speed come from OSM tags where present, otherwise defaults (25 mph, 1 lane).\n")
    f.write("// Default intersection controls are SIMULATION ASSUMPTIONS, not surveyed: Nassau St junctions\n")
    f.write("// with bigger streets are signals, Alexander St & University Pl is a roundabout, other junctions of\n")
    f.write("// two bigger streets are all-way stops, and the rest are two-way stops (smaller street stops).\n")
    f.write("const LOCAL_NETWORK_DATA = " + json.dumps(net, indent=1) + ";\n")

print(len(inter), "intersections,", len(roads), "roads")
for it in sorted(inter.values(), key=lambda i: i["id"]):
    print(f"  {it['id']:32s} {it['name']:45s} deg {it['degree']} {it['control']['type']}")
for r in sorted(roads, key=lambda r: r["id"]):
    print(f"  {r['id']:22s} {r['from']:28s} -> {r['to']:28s} {r['lengthM']:5d} m  lanes {r['lanes']} ow {r['oneway']:2d} {r['speedMph']} mph  {r['name']}")
print("places:", ", ".join(places))
