# Download Goheen Walk / Shapiro Walk (footpaths) to locate where they cross Washington Road.
import json, sys, urllib.request, urllib.parse, time

OUT = sys.argv[1]
QUERY = """
[out:json][timeout:60];
way["name"~"Goheen|Shapiro"](40.335,-74.665,40.352,-74.645);
out body geom;
"""
for url in ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]:
    try:
        req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": QUERY}).encode(),
                                     headers={"User-Agent": "traffic-sim-hackathon/0.1"})
        with urllib.request.urlopen(req, timeout=90) as res:
            data = json.load(res)
        break
    except Exception as e:
        print("failed:", url, e); time.sleep(3)
json.dump(data, open(OUT, "w", encoding="utf-8"))
for el in data["elements"]:
    g = el["geometry"]
    print(el["id"], el["tags"].get("name"), el["tags"].get("highway"), "from", (round(g[0]["lat"], 6), round(g[0]["lon"], 6)), "to", (round(g[-1]["lat"], 6), round(g[-1]["lon"], 6)))
