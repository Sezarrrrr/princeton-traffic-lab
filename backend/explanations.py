"""Short, deterministic explanations of measured scenario comparisons."""
from .simulator import ROADS, run_simulation
from .princeton_network import ROAD_SPLITS


def explain(before_request, after_request, road_id=None, incremental=False):
    report = {road_id} if road_id else set()
    for request in (before_request, after_request):
        report.update(request.extraLanesByRoadId)
        report.update(request.closedRoadIds)
        report.update(id for stretch in [*request.laneStretches, *request.speedStretches]
                      for id in stretch.roadIds)
    before = run_simulation(before_request, report_roads=report)
    after = run_simulation(after_request, report_roads=report)
    # Keep reporting boundaries identical when a bus or endpoint splits a road.
    splits = {ROADS[r['id']]['parentId'] for result in (before, after) for r in result['roads']
              if ROADS[r['id']].get('parentId')}
    if splits:
        report = {piece for id in report for piece in (ROAD_SPLITS[id] if id in splits else [id])}
        before = run_simulation(before_request, report_roads=report, report_splits=splits)
        after = run_simulation(after_request, report_roads=report, report_splits=splits)
    old = {r['id']: r for r in before['roads']}
    new = {r['id']: r for r in after['roads']}
    selected_piece = road_id in splits
    if selected_piece:
        pieces = [id for id in ROAD_SPLITS[road_id] if id in old and id in new]
        road_id = max(pieces, key=lambda id: abs((old[id]['travelMinutes'] or 0) -
                                                (new[id]['travelMinutes'] or 0)), default=road_id)
    if road_id is None:
        changed = sorted(id for id in old.keys() & new.keys() if old[id] != new[id])
        road_id = max(changed, key=lambda id: abs((old[id]['travelMinutes'] or 0) -
                                                (new[id]['travelMinutes'] or 0)), default=None)
    sentences = []
    a, b = old.get(road_id), new.get(road_id)
    if a and b:
        name = ROADS[road_id]['name'].split(' (')[0]
        if selected_piece: name = "part of " + name
        if a['closed'] != b['closed']:
            sentences.append(f"{name} is now {'closed' if b['closed'] else 'open'}; its car volume changed from {a['carTrips']} to {b['carTrips']} trips.")
        else:
            if a['capacity'] != b['capacity']:
                change = f"capacity changed from {a['capacity']} to {b['capacity']} trips"
            elif a['speedLimitMph'] != b['speedLimitMph']:
                change = f"the speed limit changed from {a['speedLimitMph']:g} to {b['speedLimitMph']:g} mph"
            else:
                change = f"car volume changed from {a['carTrips']} to {b['carTrips']} trips"
            if a['travelMinutes'] is not None and b['travelMinutes'] is not None:
                sentences.append(f"On {name}, {change}; segment travel time went from {a['travelMinutes'] * 60:.2f} to {b['travelMinutes'] * 60:.2f} seconds.")
            else:
                sentences.append(f"On {name}, {change}; the road is closed to this trip.")
    bus_changed = any(before[k] != after[k] for k in ('carTripsShiftedToBus', 'partialBusTrips'))
    if bus_changed:
        sentences.append(f"Whole trips replaced by bus changed from {before['carTripsShiftedToBus']} to {after['carTripsShiftedToBus']}; trips using bus for only part of the route changed from {before['partialBusTrips']} to {after['partialBusTrips']}.")
    elif before['avgCarSignalWaitMinutes'] != after['avgCarSignalWaitMinutes']:
        def wait(value):
            return 'unavailable' if value is None else f'{value * 60:.2f} seconds'
        sentences.append(f"Average signal wait per car trip changed from {wait(before['avgCarSignalWaitMinutes'])} to {wait(after['avgCarSignalWaitMinutes'])}.")
    elif a and b and a['congestionRatio'] is not None and b['congestionRatio'] is not None and a['congestionRatio'] != b['congestionRatio']:
        sentences.append(f"Traffic used {a['congestionRatio'] * 100:.1f}% of capacity before and {b['congestionRatio'] * 100:.1f}% after; the model adds congestion delay above 100%.")
    x, y = before['avgCarTravelMinutes'], after['avgCarTravelMinutes']
    if y is None:
        trip = f"No car trips completed; {after['unservedCarTrips']} trips are unserved and {after['carTripsShiftedToBus']} switched entirely to bus."
    elif x is None:
        trip = f"Cars can now complete the trip in an average of {y:.2f} minutes."
    elif x == y:
        unused = b and not b['carTrips'] and a and not a['carTrips']
        trip = (f"This road carries no cars from the selected trip; the trip average stays at {y:.2f} minutes." if unused else
                f"The full-trip average remains {y:.2f} minutes at the displayed precision.")
    else:
        trip = f"The full-trip average changed from {x:.2f} to {y:.2f} minutes."
    sentences.append(trip)
    if len(sentences) == 1:
        sentences.insert(0, 'No road travel-time change was measured for this comparison.')
    return {'text': ' '.join(sentences[:3]), 'roadId': road_id,
            'comparison': 'Before and after the latest change; other settings retained.' if incremental else
                          'Original versus current scenario; all active edits combined.'}
