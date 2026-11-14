# Download Princeton street geometry and the JRR building from OpenStreetMap (Overpass API).
import json, sys, urllib.request, urllib.parse

OUT = sys.argv[1]
BBOX = "40.330,-74.675,40.356,-74.640"  # south, west, north, east
NAMES = "Washington Road|Nassau Street|Mercer Street|Alexander Street|Alexander Road|Faculty Road|Prospect Avenue|University Place|Olden Street|Stockton Street"
QUERY = f"""
[out:json][timeout:60];
(
  way["highway"]["name"~"^({NAMES})$"]({BBOX});
  way["building"]["name"~"Rabinowitz"]({BBOX});
  relation["building"]["name"~"Rabinowitz"]({BBOX});
  way["name"~"Rabinowitz"]({BBOX});
);
out body geom;
"""
import time
data = None
for url in ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
            "https://overpass-api.de/api/interpreter"]:
    try:
        req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": QUERY}).encode(),
                                     headers={"User-Agent": "traffic-sim-hackathon/0.1"})
        with urllib.request.urlopen(req, timeout=90) as res:
            data = json.load(res)
        print("source:", url)
        break
    except Exception as e:
        print("failed:", url, e)
        time.sleep(3)
if data is None:
    sys.exit("all Overpass mirrors failed")
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(data, f)
names = {}
for el in data["elements"]:
    n = el.get("tags", {}).get("name")
    names[n] = names.get(n, 0) + 1
print(len(data["elements"]), "elements")
for n, c in sorted(names.items()):
    print(f"  {c:3d}  {n}")
