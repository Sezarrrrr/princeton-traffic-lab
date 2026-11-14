// MOCK of POST /api/simulate. Same request and response shape as the shared API contract.
// The real numbers come from Sizar's backend. Everything here is a SIMULATION ASSUMPTION
// so the frontend can be built and tested before the backend supports each feature:
//   - 100 trips by default from Nassau & Washington to Princeton Station (Dinky)
//   - Route A / Route B road lists from testing/road-network.md (Draft v2)
//   - both routes open: 60% of trips on A, 40% on B; one closed: all on the other
//   - every road: capacity 100 cars per lane, free-flow time 2 minutes
//   - congestion applies only above capacity
//   - a signal adds up to 1.5 min: main roads wait (1 - mainGreenShare) * 1.5,
//     cross roads wait mainGreenShare * 1.5. Main roads = the busiest roads at that
//     intersection in the original scenario.
//   - bus: busShiftPercent of demand rides the bus if every bus road is open
const MOCK_ROUTES = {
  A: ["wash_north", "wash_mid", "wash_south", "faculty_rd", "alex_station"],
  B: ["nassau_west", "nassau_mercer", "alex_north"]
};
const MOCK_CAPACITY_PER_LANE = 100;
const MOCK_FREE_FLOW_MINUTES = 2;
const MOCK_MAX_SIGNAL_WAIT = 1.5;

const round2 = n => Math.round(n * 100) / 100;

// Which roads are "main" at each signal intersection: the busiest ones with no changes.
function mockMainRoadsAt(intersectionId, baselineTrips) {
  const touching = MOCK_NETWORK.roads.filter(r => r.from === intersectionId || r.to === intersectionId);
  const most = Math.max(...touching.map(r => baselineTrips[r.id] || 0));
  return new Set(touching.filter(r => (baselineTrips[r.id] || 0) === most && most > 0).map(r => r.id));
}

function mockRunScenario(req, baselineTrips) {
  const closed = new Set(req.closedRoadIds);
  const lanes = req.extraLanesByRoadId || {};
  const demand = req.tripDemand ?? 100;
  const isOpen = route => route.every(id => !closed.has(id));

  // Bus: only runs if every bus road is open.
  const busRoads = MOCK_NETWORK.busRoute ? MOCK_NETWORK.busRoute.roadIds : [];
  const busRuns = busRoads.length > 0 && isOpen(busRoads);
  const shifted = busRuns ? Math.round(demand * (req.busShiftPercent || 0) / 100) : 0;
  const carTrips = demand - shifted;

  const aOpen = isOpen(MOCK_ROUTES.A), bOpen = isOpen(MOCK_ROUTES.B);
  let tripsA = 0, tripsB = 0;
  if (aOpen && bOpen) { tripsA = Math.round(carTrips * 0.6); tripsB = carTrips - tripsA; }
  else if (aOpen) tripsA = carTrips;
  else if (bOpen) tripsB = carTrips;

  // Car trips on each road.
  const tripsOn = {};
  for (const road of MOCK_NETWORK.roads) tripsOn[road.id] = 0;
  for (const id of MOCK_ROUTES.A) tripsOn[id] += tripsA;
  for (const id of MOCK_ROUTES.B) tripsOn[id] += tripsB;

  // Extra signal wait on each road.
  const signalWait = {};
  for (const sig of req.signals || []) {
    const main = mockMainRoadsAt(sig.intersectionId, baselineTrips || tripsOn);
    for (const road of MOCK_NETWORK.roads) {
      if (road.from !== sig.intersectionId && road.to !== sig.intersectionId) continue;
      const share = main.has(road.id) ? 1 - sig.mainGreenShare : sig.mainGreenShare;
      signalWait[road.id] = (signalWait[road.id] || 0) + share * MOCK_MAX_SIGNAL_WAIT;
    }
  }

  let totalMinutes = 0;
  const roads = MOCK_NETWORK.roads.map(road => {
    if (closed.has(road.id)) {
      return { id: road.id, carTrips: 0, travelMinutes: null, congestionRatio: null, closed: true };
    }
    const trips = tripsOn[road.id];
    const capacity = MOCK_CAPACITY_PER_LANE * (1 + (lanes[road.id] || 0));
    const ratio = trips / capacity;
    const minutes = MOCK_FREE_FLOW_MINUTES * (1 + 0.15 * Math.max(0, ratio ** 4 - 1)) + (signalWait[road.id] || 0);
    totalMinutes += trips * minutes; // each trip pays this road's time once
    return { id: road.id, carTrips: trips, capacity, speedLimitMph: 25,
      freeFlowMinutes: MOCK_FREE_FLOW_MINUTES, travelMinutes: round2(minutes), congestionRatio: round2(ratio), closed: false };
  });

  const completed = tripsA + tripsB + prospectTrips;
  return {
    totalCarTrips: demand,
    completedCarTrips: completed,
    avgCarTravelMinutes: completed ? round2(totalMinutes / completed) : null,
    unservedCarTrips: demand - completed - shifted,
    carTripsShiftedToBus: shifted,
    roads
  };
}

// Pretends to be the server: takes the scenario object, returns { baseline, scenario }.
function mockSimulate(req) {
  const roadIds = new Set(MOCK_NETWORK.roads.map(r => r.id));
  const badRoads = [...req.closedRoadIds, ...Object.keys(req.extraLanesByRoadId)].filter(id => !roadIds.has(id));
  if (badRoads.length) throw new Error(`Unknown road ID: ${badRoads.join(", ")}`);
  const signalIds = new Set(MOCK_NETWORK.signalIntersections);
  const badSignals = req.signals.filter(s => !signalIds.has(s.intersectionId));
  if (badSignals.length) throw new Error("Signal not supported at that intersection");

  const empty = { closedRoadIds: [], extraLanesByRoadId: {}, signals: [], busShiftPercent: 0, tripDemand: req.tripDemand };
  const baseline = mockRunScenario(empty, null);
  const baselineTrips = Object.fromEntries(baseline.roads.map(r => [r.id, r.carTrips]));
  return { baseline, scenario: mockRunScenario(req, baselineTrips) };
}
