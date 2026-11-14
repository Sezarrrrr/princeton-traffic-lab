# Download the expanded Princeton street network, mapped traffic controls and landmark places from
# OpenStreetMap (Overpass API). Output feeds build_network.py.
#   py fetch_osm_expanded.py osm_expanded.json
import json, sys, time, urllib.request, urllib.parse

OUT = sys.argv[1]
BBOX = "40.322,-74.700,40.372,-74.615"  # south, west, north, east (most of Princeton)
PLACES = ("Nassau Hall|Palmer Square|McCarter Theatre|Princeton Public Library|Frist Campus Center|"
          "Princeton University Art Museum|Jadwin Gymnasium|Julis Romo Rabinowitz Building|Friend Center|"
          "Firestone Library|Lewis Library|Princeton University Chapel|Princeton Theological Seminary|"
          "Princeton Shopping Center|Institute for Advanced Study|Princeton High School|"
          "Princeton Battlefield State Park|Princeton Stadium|Powers Field at Princeton Stadium|Community Park|"
          "Marquand Park|Princeton Cemetery|Dillon Gymnasium|Morven Museum & Garden|Westminster Choir College")
QUERY = f"""
[out:json][timeout:180];
(
  way["highway"~"^(primary|secondary|tertiary|unclassified|residential|living_street|service)$"]["name"]({BBOX});
  way["junction"="roundabout"]({BBOX});
  node["highway"~"^(traffic_signals|stop|give_way)$"]({BBOX});
  nwr["name"~"^({PLACES})$"]({BBOX});
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
        with urllib.request.urlopen(req, timeout=240) as res:
            data = json.load(res)
        print("source:", url)
        break
    except Exception as e:
        print("failed:", url, e)
        time.sleep(5)
if data is None:
    sys.exit("all Overpass mirrors failed")
json.dump(data, open(OUT, "w", encoding="utf-8"))
counts = {}
for el in data["elements"]:
    t = el.get("tags", {})
    key = (el["type"], t.get("highway") if el["type"] == "node" else ("roundabout" if t.get("junction") == "roundabout" else t.get("highway", "place")))
    counts[key] = counts.get(key, 0) + 1
    if "highway" not in t and t.get("junction") != "roundabout":
        print("place:", el["type"], t.get("name"), t.get("railway", ""))
for k, v in sorted(counts.items(), key=str):
    print(f"  {v:5d}  {k}")
