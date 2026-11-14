"""Sources and unit conversion for regular passenger-vehicle speed limits."""
import re

KM_PER_MILE = 1.609344
FALLBACK_MPH = 25

# Exact OSM ways on streets covered for their full length by § B19-14.
# The ordinance applies to all permitted directions.
MUNICIPAL_LIMITS = {
    15: {"11642113", "11644522", "11645199"},
    20: {"11640344", "11642972", "11647020", "11642187", "278740718",
         "917267740", "11643172", "1018454105", "1445690230", "1274765208",
         "1274765209", "365793301"},
}
MUNICIPAL_SOURCE = "https://ecode360.com/36793363"

# Downtown NJ 27 ways wholly inside the Bayard Lane–Linden Lane 25 mph zone.
NASSAU_25_WAYS = {
    "591759598", "427933552", "365764188", "591759602", "427933557", "581731351",
    "1384262780", "1383694870", "1383694869", "1364705919", "428105900", "1382319405",
    "1386036026", "488532422", "627037051", "1467129763",
}
NJDOT_SOURCE = "https://www.nj.gov/transportation/refdata/traffic_orders/speed/rt27.shtm"


def parse_maxspeed(value):
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*(mph|km/h|kmh|kph)?\s*", value or "", re.I)
    if not match:
        return None
    number = float(match[1])
    mph = number if (match[2] or "").lower() == "mph" else number / KM_PER_MILE
    return round(mph, 4) if 1 <= mph <= 100 else None


def speed_records(way_id, tags, orientation=1):
    """Return static limits indexed by direction relative to stored geometry."""
    for mph, ways in MUNICIPAL_LIMITS.items():
        if way_id in ways:
            record = {"mph": mph, "source": "Princeton municipal code § B19-14", "url": MUNICIPAL_SOURCE}
            return {"forward": record, "backward": record}
    if way_id in NASSAU_25_WAYS:
        record = {"mph": 25, "source": "NJDOT · NJ 27 traffic order", "url": NJDOT_SOURCE}
        return {"forward": record, "backward": record}

    records = {}
    for direction, name in ((1, "forward"), (-1, "backward")):
        suffix = "forward" if direction == orientation else "backward"
        raw = tags.get(f"maxspeed:{suffix}") if orientation else None
        if raw is None:
            raw = tags.get("maxspeed")
        mph = parse_maxspeed(raw)
        if mph is not None:
            records[name] = {"mph": mph, "source": "OpenStreetMap maxspeed",
                             "url": f"https://www.openstreetmap.org/way/{way_id}"}
    return records


def speed_record(road, direction):
    return road.get("speedLimits", {}).get("forward" if direction == 1 else "backward") or {
        "mph": FALLBACK_MPH, "source": "Simulation assumption",
    }


def free_flow_minutes(distance_meters, mph):
    return distance_meters * .06 / (mph * KM_PER_MILE)
