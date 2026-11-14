# Build lat/lon polylines for each simulation road ID by routing along the real OSM streets.
import json, sys, math, heapq
from collections import defaultdict

osm = json.load(open(sys.argv[1], encoding="utf-8"))
OUT = sys.argv[2]

# Intersections: the OSM node nearest each of these points (picked from the junction listing).
INTERSECTIONS = {
    "int_nassau_wash":    (40.350392, -74.657115),  # Nassau St & Washington Rd
    "int_nassau_univ":    (40.348728, -74.663057),  # Nassau St & University Pl
    "int_mercer_alex":    (40.346590, -74.664668),  # Mercer St & Alexander St
    "int_alex_univ":      (40.343341, -74.661147),  # Alexander St at the University Pl junction
    "int_alex_faculty":   (40.337897, -74.656948),  # Alexander St & Faculty Rd
    "int_wash_prospect":  (40.347819, -74.655038),  # Washington Rd & Prospect Ave
    "int_wash_goheen":    (40.345405, -74.653190),  # Washington Rd at Goheen Walk
    "int_wash_faculty":   (40.341157, -74.649824),  # Washington Rd & Faculty Rd
    "int_prospect_olden": (40.348878, -74.651127),  # Prospect Ave & Olden St
}
# Simulation road -> (from, to, streets the path may use)
ROADS = {
    "nassau_west":   ("int_nassau_wash", "int_nassau_univ", {"Nassau Street"}),
    "nassau_mercer": ("int_nassau_univ", "int_mercer_alex", {"Nassau Street", "Mercer Street"}),
    "alex_north":    ("int_mercer_alex", "int_alex_univ", {"Alexander Street"}),
    "alex_station":  ("int_alex_univ", "int_alex_faculty", {"Alexander Street"}),
    "univ_place":    ("int_nassau_univ", "int_alex_univ", {"University Place", "Alexander Street"}),
    "wash_north":    ("int_nassau_wash", "int_wash_prospect", {"Washington Road"}),
    "wash_mid":      ("int_wash_prospect", "int_wash_goheen", {"Washington Road"}),
    "wash_south":    ("int_wash_goheen", "int_wash_faculty", {"Washington Road"}),
    "faculty_rd":    ("int_wash_faculty", "int_alex_faculty", {"Faculty Road"}),
    "prospect_ave":  ("int_wash_prospect", "int_prospect_olden", {"Prospect Avenue"}),
}

def dist(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))

coords, edges = {}, defaultdict(list)  # node -> [(neighbor, meters, street)]
jrr = None
for el in osm["elements"]:
    t = el.get("tags", {})
    if el["type"] == "way" and "highway" in t:
        ids = el["nodes"]
        for nid, g in zip(ids, el["geometry"]):
            coords[nid] = (g["lat"], g["lon"])
        for a, b in zip(ids, ids[1:]):
            d = dist(coords[a], coords[b])
            edges[a].append((b, d, t["name"]))
            edges[b].append((a, d, t["name"]))
    elif "Rabinowitz" in t.get("name", "") and el.get("geometry"):
        pts = el["geometry"]
        jrr = (sum(p["lat"] for p in pts) / len(pts), sum(p["lon"] for p in pts) / len(pts))

def nearest(pt):
    return min(coords, key=lambda n: dist(coords[n], pt))

node_of = {k: nearest(v) for k, v in INTERSECTIONS.items()}

street_nodes = defaultdict(set)
for n, lst in edges.items():
    for _, _, s in lst:
        street_nodes[s].add(n)

def route(a, b, streets):
    # Short "bridge" links (< 35 m) between nodes of the allowed streets cover small gaps in the
    # OSM data, e.g. unnamed roundabout pieces. They cost 3x so real street links are preferred.
    allowed = set().union(*(street_nodes[s] for s in streets))
    bridges = defaultdict(list)
    for n in allowed:
        for m in allowed:
            if n != m and dist(coords[n], coords[m]) < 35:
                bridges[n].append((m, 3 * dist(coords[n], coords[m]), "bridge"))
    best, prev, heap = {a: 0}, {}, [(0, a)]
    while heap:
        d, n = heapq.heappop(heap)
        if n == b:
            break
        if d > best[n]:
            continue
        for m, w, street in edges[n] + bridges[n]:
            if (street in streets or street == "bridge") and d + w < best.get(m, float("inf")):
                best[m], prev[m] = d + w, n
                heapq.heappush(heap, (d + w, m))
    if b not in best:
        raise SystemExit(f"no path {a} -> {b} on {streets}")
    path = [b]
    while path[-1] != a:
        path.append(prev[path[-1]])
    return path[::-1], best[b]

out = {"intersections": {}, "roads": {}}
for k, n in node_of.items():
    out["intersections"][k] = [round(coords[n][0], 6), round(coords[n][1], 6)]
    print(f"{k:20s} node {n}  {coords[n]}  ({dist(coords[n], INTERSECTIONS[k]):.0f} m from target)")
for rid, (a, b, streets) in ROADS.items():
    path, meters = route(node_of[a], node_of[b], streets)
    out["roads"][rid] = [[round(coords[n][0], 6), round(coords[n][1], 6)] for n in path]
    print(f"{rid:14s} {len(path):3d} points  {meters:6.0f} m")
out["landmarks"] = {"jrr": [round(jrr[0], 6), round(jrr[1], 6)]}
json.dump(out, open(OUT, "w", encoding="utf-8"), indent=1)
print("JRR", out["landmarks"]["jrr"])
