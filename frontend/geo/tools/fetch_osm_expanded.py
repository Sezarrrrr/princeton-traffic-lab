# Download the expanded Princeton street network and landmark places from OpenStreetMap
# (Overpass API). Output feeds build_network.py.
#   py fetch_osm_expanded.py osm_expanded.json
import json, sys, time, urllib.request, urllib.parse

OUT = sys.argv[1]
BBOX = "40.333,-74.672,40.356,-74.640"  # south, west, north, east
QUERY = f"""
[out:json][timeout:90];
(
  way["highway"~"^(primary|secondary|tertiary|unclassified|residential|living_street|service)$"]["name"]({BBOX});
  nwr["name"~"^(Nassau Hall|Palmer Square|McCarter Theatre|Princeton Public Library|Frist Campus Center|Princeton University Art Museum|Jadwin Gymnasium|Princeton Stadium|Julis Romo Rabinowitz Building|Friend Center|Firestone Library|Lewis Library|Princeton University Chapel|Princeton Theological Seminary)"]({BBOX});
  nwr["railway"="station"]({BBOX});
);
out body geom;
"""
data = None
for url in ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
            "https://overpass-api.de/api/interpreter"]:
    try:
        req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": QUERY}).encode(),
                                     headers={"User-Agent": "traffic-sim-hackathon/0.1"})
        with urllib.request.urlopen(req, timeout=120) as res:
            data = json.load(res)
        print("source:", url)
        break
    except Exception as e:
        print("failed:", url, e)
        time.sleep(3)
if data is None:
    sys.exit("all Overpass mirrors failed")
json.dump(data, open(OUT, "w", encoding="utf-8"))
streets = {}
for el in data["elements"]:
    t = el.get("tags", {})
    if el["type"] == "way" and "highway" in t:
        key = (t["name"], t["highway"])
        streets[key] = streets.get(key, 0) + 1
    else:
        print("place:", el["type"], t.get("name"), t.get("railway", ""))
for (n, h), c in sorted(streets.items()):
    print(f"  {c:3d}  {h:12s} {n}")
