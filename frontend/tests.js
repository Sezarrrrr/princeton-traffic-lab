// Checks for the in-browser simulator. Open tests.html to run them.
// Each check runs LocalSim on a fixed scenario and compares the result with a rule that must
// always hold (trips are conserved, closed roads carry no cars, and so on).

(function () {
  const net = LocalSim.network();
  const EMPTY = { closedRoadIds: [], extraLanesByRoadId: {}, signals: [], busShiftPercent: 0 };
  const run = changes => LocalSim.simulate({ ...EMPTY, ...changes });
  const conserved = c => c.completedCarTrips + c.unservedCarTrips + c.carTripsShiftedToBus === c.totalCarTrips;
  const roadsById = column => new Map(column.roads.map(road => [road.id, road]));
  // The demo closure: every piece of Washington Rd between Prospect Ave and Goheen Walk.
  const washMid = net.roads.filter(road => road.core === "wash_mid" || road.id === "wash_mid").map(road => road.id);

  function check(condition, message) {
    if (!condition) throw new Error(message);
  }

  const tests = [
    ["Network: every road joins two known intersections", () => {
      const nodes = new Set(net.intersections.map(node => node.id));
      check(net.roads.length > 0 && nodes.size > 0, "the network is empty");
      const bad = net.roads.filter(road => !nodes.has(road.from) || !nodes.has(road.to));
      check(bad.length === 0, `${bad.length} roads point at missing intersections`);
      return `${nodes.size} intersections, ${net.roads.length} roads`;
    }],

    ["Network: road IDs are unique and every road has a drawn shape", () => {
      const ids = new Set(net.roads.map(road => road.id));
      check(ids.size === net.roads.length, "duplicate road IDs");
      const missing = net.roads.filter(road => !ROAD_GEOMETRY.roads[road.id]);
      check(missing.length === 0, `${missing.length} roads have no shape in princeton-geo.js`);
      return `${ids.size} unique road IDs`;
    }],

    ["No changes: modified equals original", () => {
      const { baseline, scenario } = run({});
      check(baseline.avgCarTravelMinutes === scenario.avgCarTravelMinutes, "averages differ with no changes");
      check(baseline.completedCarTrips === baseline.totalCarTrips, "some baseline trips are unserved");
      check(conserved(baseline) && conserved(scenario), "trips are not conserved");
      return `${baseline.avgCarTravelMinutes} min, ${baseline.totalCarTrips} trips`;
    }],

    ["Same request twice gives the same answer", () => {
      const first = run({ closedRoadIds: washMid }).scenario.avgCarTravelMinutes;
      const second = run({ closedRoadIds: washMid }).scenario.avgCarTravelMinutes;
      check(first === second, `${first} then ${second}`);
      return `${first} min both times`;
    }],

    ["Demo closure: closed roads carry no cars and trips get slower", () => {
      check(washMid.length > 0, "no wash_mid roads found");
      const { baseline, scenario } = run({ closedRoadIds: washMid });
      const roads = roadsById(scenario);
      for (const id of washMid) {
        check(roads.get(id).closed, `${id} is not marked closed`);
        check(roads.get(id).carTrips === 0, `${id} still carries ${roads.get(id).carTrips} cars`);
      }
      check(scenario.avgCarTravelMinutes > baseline.avgCarTravelMinutes,
        `closing a road made trips faster (${baseline.avgCarTravelMinutes} → ${scenario.avgCarTravelMinutes})`);
      check(conserved(scenario), "trips are not conserved");
      return `${baseline.avgCarTravelMinutes} → ${scenario.avgCarTravelMinutes} min`;
    }],

    ["Extra lane on the busiest detour road does not make trips slower", () => {
      const closed = run({ closedRoadIds: washMid }).scenario;
      const busiest = closed.roads.filter(road => !road.closed)
        .sort((a, b) => (b.congestionRatio || 0) - (a.congestionRatio || 0))[0];
      const widened = run({ closedRoadIds: washMid, extraLanesByRoadId: { [busiest.id]: 1 } }).scenario;
      check(widened.avgCarTravelMinutes <= closed.avgCarTravelMinutes,
        `adding a lane on ${busiest.id} made trips slower (${closed.avgCarTravelMinutes} → ${widened.avgCarTravelMinutes})`);
      check(conserved(widened), "trips are not conserved");
      return `${busiest.id}: ${closed.avgCarTravelMinutes} → ${widened.avgCarTravelMinutes} min`;
    }],

    ["Bus shift moves let-out trips to the bus and conserves trips", () => {
      const { scenario } = run({ busShiftPercent: 20 });
      const expected = Math.round(net.settingsDefaults.eventCars * 0.2);
      check(scenario.carTripsShiftedToBus === expected, `expected ${expected} bus trips, got ${scenario.carTripsShiftedToBus}`);
      check(conserved(scenario), "trips are not conserved");
      return `${scenario.carTripsShiftedToBus} trips by bus`;
    }],

    ["Bus is suspended when its route is closed", () => {
      const { scenario } = run({ closedRoadIds: [net.busRoute.roadIds[0]], busShiftPercent: 20 });
      check(scenario.carTripsShiftedToBus === 0, `${scenario.carTripsShiftedToBus} trips rode a bus on a closed route`);
      check(conserved(scenario), "trips are not conserved");
      return "0 trips by bus";
    }],

    ["Every road closed: no completed trips and no average", () => {
      const { scenario } = run({ closedRoadIds: net.roads.map(road => road.id) });
      check(scenario.completedCarTrips === 0, `${scenario.completedCarTrips} trips completed`);
      check(scenario.unservedCarTrips === scenario.totalCarTrips, "unserved trips don't match the total");
      check(scenario.avgCarTravelMinutes === null, `average is ${scenario.avgCarTravelMinutes}, expected none`);
      return `${scenario.unservedCarTrips} unserved, average shown as none`;
    }],

    ["Custom trip adds its cars to the total", () => {
      const from = net.places[0].nodeId || LocalSim.nearestNode(net.places[0].latLng), to = net.eventTrip.to;
      const base = run({}).scenario.totalCarTrips;
      const { scenario } = run({ trips: [{ id: "t1", name: "Test trip", fromNodeId: from, toNodeId: to, cars: 50, onlyModified: true }] });
      check(scenario.totalCarTrips === base + 50, `total went from ${base} to ${scenario.totalCarTrips}`);
      check(conserved(scenario), "trips are not conserved");
      const trip = scenario.trips.find(item => item.id === "t1");
      check(trip, "the custom trip is missing from the results");
      return `${base} → ${scenario.totalCarTrips} trips`;
    }],

    ["More let-out cars never shortens the average trip", () => {
      const light = run({ settings: { eventCars: 100 } }).scenario.avgCarTravelMinutes;
      const heavy = run({ settings: { eventCars: 400 } }).scenario.avgCarTravelMinutes;
      check(heavy >= light, `100 cars: ${light} min, 400 cars: ${heavy} min`);
      return `100 cars: ${light} min, 400 cars: ${heavy} min`;
    }],

    ["Unknown road ID is rejected", () => {
      let rejected = false;
      try { run({ closedRoadIds: ["not_a_road"] }); } catch (err) { rejected = true; }
      check(rejected, "an unknown road ID was accepted");
      return "rejected";
    }]
  ];

  const list = document.getElementById("results");
  let failed = 0;
  for (const [name, body] of tests) {
    const item = document.createElement("li");
    try {
      const detail = body();
      item.textContent = `✓ ${name}`;
      item.append(Object.assign(document.createElement("small"), { textContent: detail }));
    } catch (err) {
      failed += 1;
      item.className = "fail";
      item.textContent = `✗ ${name}`;
      item.append(Object.assign(document.createElement("small"), { textContent: err.message }));
    }
    list.append(item);
  }
  const summary = document.getElementById("summary");
  summary.textContent = failed ? `${failed} of ${tests.length} checks failed` : `All ${tests.length} checks passed`;
  summary.className = failed ? "fail" : "pass";
  window.TEST_RESULT = { total: tests.length, failed };
})();
