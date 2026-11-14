// MOCK of POST /api/simulate. Same request and response shape as the shared API contract.
// The real numbers come from Sizar's backend. Everything here is a SIMULATION ASSUMPTION
// so the frontend can be built and tested before the backend is ready:
//   - 200 car trips from Nassau & Washington to Princeton Station (Dinky)
//   - Route A / Route B road lists from testing/road-network.md (Draft v2)
//   - both routes open: 120 trips on A, 80 on B; one closed: all 200 on the other
//   - every road: capacity 100 cars, free-flow time 2 minutes
//   - travel time uses the BPR formula: 2 * (1 + 0.15 * (trips / capacity)^4)
const MOCK_ROUTES = {
  A: ["wash_north", "wash_mid", "wash_south", "faculty_rd", "alex_station"],
  B: ["nassau_west", "nassau_mercer", "alex_north"]
};
const MOCK_TOTAL_TRIPS = 200;
const MOCK_CAPACITY = 100;
const MOCK_FREE_FLOW_MINUTES = 2;

function mockRunScenario(closedSet) {
  const aOpen = MOCK_ROUTES.A.every(id => !closedSet.has(id));
  const bOpen = MOCK_ROUTES.B.every(id => !closedSet.has(id));

  let tripsA = aOpen ? 120 : 0;
  let tripsB = bOpen ? 80 : 0;
  if (aOpen && !bOpen) tripsA = MOCK_TOTAL_TRIPS;
  if (bOpen && !aOpen) tripsB = MOCK_TOTAL_TRIPS;

  let totalMinutes = 0;
  const roads = MOCK_NETWORK.roads.map(road => {
    const closed = closedSet.has(road.id);
    if (closed) {
      return { id: road.id, carTrips: 0, travelMinutes: null, congestionRatio: null, closed: true };
    }
    let trips = 0;
    if (MOCK_ROUTES.A.includes(road.id)) trips += tripsA;
    if (MOCK_ROUTES.B.includes(road.id)) trips += tripsB;
    const ratio = trips / MOCK_CAPACITY;
    const minutes = MOCK_FREE_FLOW_MINUTES * (1 + 0.15 * Math.pow(ratio, 4));
    totalMinutes += trips * minutes; // each trip pays this road's time once
    return {
      id: road.id,
      carTrips: trips,
      travelMinutes: Math.round(minutes * 100) / 100,
      congestionRatio: ratio,
      closed: false
    };
  });

  const completed = tripsA + tripsB;
  return {
    avgCarTravelMinutes: completed ? Math.round((totalMinutes / completed) * 100) / 100 : null,
    unservedCarTrips: MOCK_TOTAL_TRIPS - completed,
    carTripsShiftedToBus: 0,
    roads
  };
}

// Pretends to be the server: takes the scenario object, returns { baseline, scenario }.
function mockSimulate(request) {
  const knownIds = new Set(MOCK_NETWORK.roads.map(r => r.id));
  const unknown = request.closedRoadIds.filter(id => !knownIds.has(id));
  if (unknown.length) {
    throw new Error(`Unknown road ID: ${unknown.join(", ")}`);
  }
  return {
    baseline: mockRunScenario(new Set()),
    scenario: mockRunScenario(new Set(request.closedRoadIds))
  };
}
