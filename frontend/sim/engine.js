// In-browser traffic simulator for the EXPANDED Princeton network (geo/princeton-network.js).
// Used when the page is opened without ?api=real. The real backend (Sizar's FastAPI server) only
// covers the 10-road core network and does closures + extra lanes; this simulator adds custom trips,
// intersection controls, speed limits and one-way changes so the frontend can show them.
//
// Every number here is a SIMULATION ASSUMPTION, not a measurement:
//   - One 15-minute let-out period. Trips are cars that start in that period.
//   - Roads: free-flow time = length / speed limit. Congestion uses the BPR formula
//     t = t0 * (1 + 0.15 * (cars / capacity)^4), capacity = lanes * lane capacity (default 100
//     cars per lane per 15 min, same as the backend), counted separately for each direction.
//   - Intersections add a wait for cars entering from each road (Highway Capacity Manual style):
//       signal      Webster uniform delay + HCM overflow delay, saturation flow 1800 cars/h/lane,
//                   green split between the main street and the cross street (or a walk phase)
//       all-way stop  one car every `stopHeadway` seconds through the whole intersection, + 5 s stop
//       two-way stop  side street waits for gaps in main-street traffic (critical gap 6.5 s,
//                   follow-up 3.3 s), + 5 s stop; main street doesn't stop
//       roundabout  entry capacity 1380 * e^(-0.00102 * circulating cars/h)
//       none        no wait
//   - Drivers pick routes that are fastest for them given everyone else's choices (user
//     equilibrium, method of successive averages, 30 rounds). Turning movements aren't modelled.
//   - Background traffic enters and leaves where main streets cross the edge of the map
//     ("gateways", weighted 3 primary / 2 secondary / 1 tertiary): BG_THROUGH x weight x weight cars
//     between every pair of gateways more than 1.5 km apart, plus BG_DOWNTOWN x weight cars to and
//     from downtown (Nassau & Washington and Nassau & University Pl).
//   - Bus: busShiftPercent of the let-out trips ride the bus if every bus road is open to cars.
const LocalSim = (() => {
  const PERIOD_MIN = 15;
  const T = PERIOD_MIN / 60;        // analysis period, hours
  const PER_HOUR = 60 / PERIOD_MIN;
  const SAT_FLOW = 1800;            // cars per hour of green per lane
  const TC = 6.5, TF = 3.3;         // two-way stop gap acceptance, seconds
  const ITERATIONS = 30;
  const MPS_PER_MPH = 0.44704;

  const SETTINGS_DEFAULTS = { eventCars: 200, backgroundScale: 1, laneCapacity: 100, stopHeadway: 4 };
  const SIGNAL_DEFAULTS = { cycle: 90, greenShare: 0.6, lost: 4, ped: 0 };
  // The let-out: same origin and destination as the backend's trips (Nassau & Washington to the station).
  const EVENT = { id: "event", name: "HackPrinceton let-out", from: "int_nassau_wash", to: "int_alex_univ" };
  const BG_THROUGH = 1.2, BG_DOWNTOWN = 4, BG_MIN_METERS = 1500;
  const DOWNTOWN = ["int_nassau_wash", "int_nassau_univ"];
  const BUS_NAME = "TigerTransit Station Connector";
  const BUS_CORE_ROADS = ["wash_north", "wash_mid", "wash_south", "faculty_rd", "alex_station"];

  const data = LOCAL_NETWORK_DATA;
  const roadMap = new Map(data.roads.map(r => [r.id, r]));
  const nodeMap = new Map(data.intersections.map(n => [n.id, n]));
  const degreeOf = new Map();
  for (const r of data.roads) for (const id of [r.from, r.to]) degreeOf.set(id, (degreeOf.get(id) || 0) + 1);
  const degree = id => degreeOf.get(id) || 0;
  const round2 = v => Math.round(v * 100) / 100;

  // Bus route: the core Route A roads (now split into smaller pieces), in driving order from
  // Nassau & Washington.
  const busRoadIds = (() => {
    const left = data.roads.filter(r => BUS_CORE_ROADS.includes(r.core || r.id));
    const order = [];
    let at = "int_nassau_wash";
    while (left.length) {
      const i = left.findIndex(r => r.from === at || r.to === at);
      if (i < 0) { order.push(...left.map(r => r.id)); break; }
      const [r] = left.splice(i, 1);
      order.push(r.id);
      at = r.from === at ? r.to : r.from;
    }
    return order;
  })();

  function haversine(a, b) {
    const rad = Math.PI / 180, dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }
  // Nearest intersection to a point (used to attach places and map pins to the network).
  function nearestNode(latLng) {
    let best = null, bestD = Infinity;
    for (const n of data.intersections) {
      const ll = ROAD_GEOMETRY.intersections[n.id];
      if (!ll) continue;
      const d = haversine(latLng, ll);
      if (d < bestD) { best = n.id; bestD = d; }
    }
    return { nodeId: best, meters: Math.round(bestD) };
  }

  // Background traffic routes [from, to, cars] (ASSUMPTION, see the header).
  const BACKGROUND = (() => {
    const gws = (data.gateways || []).filter(g => nodeMap.has(g.id));
    const ll = id => ROAD_GEOMETRY.intersections[id];
    const out = [];
    for (const g of gws) {
      for (const h of gws) {
        if (g.id === h.id || haversine(ll(g.id), ll(h.id)) < BG_MIN_METERS) continue;
        out.push([g.id, h.id, BG_THROUGH * g.weight * h.weight]);
      }
      for (const d of DOWNTOWN) {
        out.push([g.id, d, BG_DOWNTOWN * g.weight / DOWNTOWN.length]);
        out.push([d, g.id, BG_DOWNTOWN * g.weight / DOWNTOWN.length]);
      }
    }
    return out;
  })();

  function defaultMajor(id) {
    const n = nodeMap.get(id);
    if (n.control.major) return n.control.major;
    const touching = data.roads.filter(r => r.from === id || r.to === id);
    const len = {};
    for (const r of touching) len[r.street] = (len[r.street] || 0) + r.lengthM;
    return Object.keys(len).sort((a, b) => len[b] - len[a])[0] || null;
  }

  // Full control settings for an intersection: the default, with the user's override on top.
  function effectiveControl(id, overrides) {
    const base = nodeMap.get(id).control;
    const ctl = { ...base, ...((overrides && overrides[id]) || {}) };
    if (ctl.type === "signal") for (const [k, v] of Object.entries(SIGNAL_DEFAULTS)) if (ctl[k] === undefined) ctl[k] = v;
    if ((ctl.type === "signal" || ctl.type === "stop_minor") && !ctl.major) ctl.major = defaultMajor(id);
    return ctl;
  }

  function network() {
    const places = Object.entries(ROAD_GEOMETRY.landmarks || {}).map(([key, p]) => ({
      id: `place_${key}`, name: p.name, latLng: p.latLng, builtIn: true, ...nearestNode(p.latLng)
    })).sort((a, b) => a.name.localeCompare(b.name));
    return {
      intersections: data.intersections.map(n => ({ id: n.id, name: n.name, x: n.x, y: n.y, streets: n.streets, control: { ...n.control }, controlSource: n.controlSource, degree: degree(n.id) })),
      roads: data.roads.map(r => ({ ...r, twoWay: r.oneway === 0 })),
      signalIntersections: data.intersections.filter(n => degree(n.id) >= 2).map(n => n.id),
      busRoute: { name: BUS_NAME, roadIds: busRoadIds },
      places,
      gateways: (data.gateways || []).map(g => g.id),
      eventTrip: { ...EVENT },
      background: { routes: BACKGROUND.length, cars: BACKGROUND.reduce((s, b) => s + Math.round(b[2]), 0) },
      settingsDefaults: { ...SETTINGS_DEFAULTS },
      signalDefaults: { ...SIGNAL_DEFAULTS },
      periodMinutes: PERIOD_MIN,
      capabilities: { lab: true }
    };
  }

  // ---- One simulation run ----
  function buildLinks(cfg) {
    const links = [];
    for (const r of data.roads) {
      const rs = cfg.roadSettings[r.id] || {};
      const access = rs.carAccess !== undefined ? rs.carAccess : r.carAccess;
      if (cfg.closed.has(r.id) || !access) continue;
      const oneway = rs.oneway !== undefined ? rs.oneway : r.oneway;
      const mph = rs.speedMph || r.speedMph;
      const lanes = r.lanes + (cfg.lanes[r.id] || 0);
      const t0 = r.lengthM / (mph * MPS_PER_MPH) / 60;
      const cap = lanes * cfg.settings.laneCapacity;
      if (oneway !== -1) links.push({ road: r, dir: 1, from: r.from, to: r.to, t0, cap, lanes });
      if (oneway !== 1) links.push({ road: r, dir: -1, from: r.to, to: r.from, t0, cap, lanes });
    }
    return links;
  }

  // HCM-style overflow delay (seconds). x = demand / capacity, cap in cars per hour, k term = 4x/(cT)
  // for signals and (3600/c) x / (450 T) for stops and roundabouts.
  const overflow = (x, term) => 900 * T * ((x - 1) + Math.sqrt((x - 1) ** 2 + term));

  function nodeDelays(links, flow, controls, settings) {
    const delay = new Float64Array(links.length), sat = new Float64Array(links.length);
    const byNode = new Map();
    links.forEach((l, i) => { if (!byNode.has(l.to)) byNode.set(l.to, []); byNode.get(l.to).push(i); });
    for (const [node, idx] of byNode) {
      const ctl = controls(node);
      const vph = i => flow[i] * PER_HOUR;
      if (ctl.type === "signal") {
        const C = ctl.cycle;
        const green = Math.max(C - 2 * ctl.lost - ctl.ped, 10);
        const gMain = Math.max(4, green * ctl.greenShare), gSide = Math.max(4, green * (1 - ctl.greenShare));
        for (const i of idx) {
          const g = links[i].road.street === ctl.major ? gMain : gSide;
          const c = links[i].lanes * SAT_FLOW * g / C;
          const x = vph(i) / c;
          const d1 = 0.5 * C * (1 - g / C) ** 2 / (1 - Math.min(1, x) * g / C);
          delay[i] = d1 + overflow(x, 4 * x / (c * T));
          sat[i] = x;
        }
      } else if (ctl.type === "stop_minor" && idx.some(i => links[i].road.street === ctl.major)) {
        // Conflicting traffic for a side-street car = all main-street cars entering the intersection.
        const vc = idx.filter(i => links[i].road.street === ctl.major).reduce((s, i) => s + vph(i), 0);
        for (const i of idx) {
          if (links[i].road.street === ctl.major) { delay[i] = 0; sat[i] = 0; continue; }
          const c = links[i].lanes * (vc > 0 ? vc * Math.exp(-vc * TC / 3600) / (1 - Math.exp(-vc * TF / 3600)) : 3600 / TF);
          const x = vph(i) / c;
          delay[i] = 3600 / c + overflow(x, (3600 / c) * x / (450 * T)) + 5;
          sat[i] = x;
        }
      } else if (ctl.type === "stop_all" || ctl.type === "stop_minor") {
        const h = settings.stopHeadway;
        const x = idx.reduce((s, i) => s + vph(i), 0) * h / 3600;
        for (const i of idx) { delay[i] = h + overflow(x, h * x / (450 * T)) + 5; sat[i] = x; }
      } else if (ctl.type === "roundabout") {
        const total = idx.reduce((s, i) => s + vph(i), 0);
        for (const i of idx) {
          const vc = 0.6 * (total - vph(i));
          const c = 1380 * Math.exp(-0.00102 * vc) * (links[i].lanes >= 2 ? 1.6 : 1);
          const x = vph(i) / c;
          delay[i] = 3600 / c + overflow(x, (3600 / c) * x / (450 * T)) + 5 * Math.min(x, 1);
          sat[i] = x;
        }
      }
    }
    return { delay, sat };
  }

  function linkCosts(links, flow, controls, settings) {
    const { delay, sat } = nodeDelays(links, flow, controls, settings);
    const run = links.map((l, i) => l.t0 * (1 + 0.15 * (flow[i] / l.cap) ** 4));
    const cost = run.map((t, i) => t + delay[i] / 60);
    return { run, delay, sat, cost };
  }

  // Shortest-path tree from one origin (Dijkstra with a binary heap). Returns the incoming link of
  // every reached node.
  function shortestTree(outLinks, links, cost, from) {
    const best = new Map([[from, 0]]), prev = new Map();
    const heap = [[0, from]];
    const push = item => {
      heap.push(item);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]]; i = p;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
        }
      }
      return top;
    };
    while (heap.length) {
      const [d, n] = pop();
      if (d > best.get(n)) continue;
      for (const i of outLinks.get(n) || []) {
        const m = links[i].to, nd = d + cost[i];
        if (nd < (best.has(m) ? best.get(m) : Infinity)) { best.set(m, nd); prev.set(m, i); push([nd, m]); }
      }
    }
    return prev;
  }

  function pathFromTree(prev, links, from, to) {
    if (from === to || !prev.has(to)) return null;
    const path = [];
    for (let n = to; n !== from; n = links[prev.get(n)].from) path.push(prev.get(n));
    return path.reverse();
  }

  function runColumn(cfg, trips) {
    const links = buildLinks(cfg);
    const outLinks = new Map();
    links.forEach((l, i) => { if (!outLinks.has(l.from)) outLinks.set(l.from, []); outLinks.get(l.from).push(i); });
    const controls = id => effectiveControl(id, cfg.controls);
    const n = links.length;
    let flow = new Float64Array(n);
    const pathW = trips.map(() => new Map());
    const routable = trips.map(t => t.cars > 0);
    const byOrigin = new Map();
    trips.forEach((t, ti) => { if (!byOrigin.has(t.from)) byOrigin.set(t.from, []); byOrigin.get(t.from).push(ti); });
    for (let k = 1; k <= ITERATIONS; k++) {
      const { cost } = linkCosts(links, flow, controls, cfg.settings);
      for (const [origin, tis] of byOrigin) {
        if (!tis.some(ti => routable[ti])) continue;
        const tree = shortestTree(outLinks, links, cost, origin);
        for (const ti of tis) {
          if (!routable[ti]) continue;
          const p = pathFromTree(tree, links, origin, trips[ti].to);
          if (!p) { routable[ti] = false; continue; }
          for (const e of pathW[ti].values()) e.w *= 1 - 1 / k;
          const key = p.join(",");
          const e = pathW[ti].get(key) || { links: p, w: 0 };
          e.w += 1 / k;
          pathW[ti].set(key, e);
        }
      }
      flow = new Float64Array(n);
      trips.forEach((t, ti) => { for (const e of pathW[ti].values()) for (const i of e.links) flow[i] += e.w * t.cars; });
    }
    const { run, delay, sat, cost } = linkCosts(links, flow, controls, cfg.settings);

    // Trips
    let completed = 0, unserved = 0, totalMinutes = 0, waitMinutes = 0;
    const tripResults = trips.map((t, ti) => {
      const paths = [...pathW[ti].values()].filter(e => e.w > 0.01);
      if (!routable[ti] || !paths.length) {
        unserved += t.cars;
        return { id: t.id, name: t.name, cars: t.cars, completed: false, minutes: null, route: [], routeShare: 0 };
      }
      const wSum = paths.reduce((s, e) => s + e.w, 0);
      const minutes = paths.reduce((s, e) => s + e.w * e.links.reduce((a, i) => a + cost[i], 0), 0) / wSum;
      const wait = paths.reduce((s, e) => s + e.w * e.links.reduce((a, i) => a + delay[i] / 60, 0), 0) / wSum;
      const main = paths.reduce((a, b) => (b.w > a.w ? b : a));
      completed += t.cars;
      totalMinutes += t.cars * minutes;
      waitMinutes += t.cars * wait;
      return {
        id: t.id, name: t.name, cars: t.cars, completed: true, minutes: round2(minutes), waitMinutes: round2(wait),
        route: main.links.map(i => ({ roadId: links[i].road.id, dir: links[i].dir })), routeShare: round2(main.w / wSum),
        routes: paths.length
      };
    });

    // Roads
    const linkOf = new Map(links.map((l, i) => [`${l.road.id}:${l.dir}`, i]));
    const roads = data.roads.map(r => {
      const dirs = [1, -1].map(dir => {
        const i = linkOf.get(`${r.id}:${dir}`);
        if (i === undefined) return null;
        return { cars: Math.round(flow[i]), minutes: round2(run[i] + delay[i] / 60), freeMinutes: round2(links[i].t0), waitSeconds: Math.round(delay[i]), ratio: round2(Math.max(flow[i] / links[i].cap, sat[i])) };
      });
      const [fw, bw] = dirs;
      if (!fw && !bw) {
        const closed = cfg.closed.has(r.id);
        return { id: r.id, carTrips: 0, travelMinutes: null, congestionRatio: null, closed, noCarAccess: !closed, forward: null, backward: null };
      }
      const busy = !bw || (fw && fw.cars >= bw.cars) ? fw : bw;
      return {
        id: r.id, carTrips: (fw ? fw.cars : 0) + (bw ? bw.cars : 0), travelMinutes: busy.minutes,
        congestionRatio: Math.max(fw ? fw.ratio : 0, bw ? bw.ratio : 0), closed: false, forward: fw, backward: bw
      };
    });

    // Intersections
    const into = new Map();
    links.forEach((l, i) => { if (!into.has(l.to)) into.set(l.to, []); into.get(l.to).push({ l, i }); });
    const intersections = data.intersections.map(node => {
      const approaches = (into.get(node.id) || [])
        .map(({ l, i }) => ({ roadId: l.road.id, street: l.road.street, cars: Math.round(flow[i]), waitSeconds: Math.round(delay[i]), saturation: round2(sat[i]) }));
      const cars = approaches.reduce((s, a) => s + a.cars, 0);
      const avg = cars ? approaches.reduce((s, a) => s + a.cars * a.waitSeconds, 0) / cars : 0;
      return { id: node.id, control: controls(node.id), cars, avgWaitSeconds: Math.round(avg), approaches };
    });

    const total = trips.reduce((s, t) => s + t.cars, 0) + cfg.shifted;
    return {
      totalCarTrips: total,
      completedCarTrips: completed,
      avgCarTravelMinutes: completed ? round2(totalMinutes / completed) : null,
      avgIntersectionWaitMinutes: completed ? round2(waitMinutes / completed) : null,
      unservedCarTrips: unserved,
      carTripsShiftedToBus: cfg.shifted,
      roads, intersections, trips: tripResults
    };
  }

  function validate(req) {
    const bad = [...(req.closedRoadIds || []), ...Object.keys(req.extraLanesByRoadId || {}), ...Object.keys(req.roadSettings || {})].filter(id => !roadMap.has(id));
    if (bad.length) throw new Error(`Unknown road ID: ${bad.join(", ")}`);
    const badNodes = Object.keys(req.intersectionControls || {}).filter(id => !nodeMap.has(id));
    if (badNodes.length) throw new Error(`Unknown intersection ID: ${badNodes.join(", ")}`);
    for (const t of req.trips || []) {
      if (!nodeMap.has(t.fromNodeId) || !nodeMap.has(t.toNodeId)) throw new Error(`Trip "${t.name}" uses an unknown intersection`);
    }
  }

  function simulate(req) {
    validate(req);
    const settings = { ...SETTINGS_DEFAULTS, ...(req.settings || {}) };
    const busOpen = cfg => busRoadIds.every(id => {
      const r = roadMap.get(id), rs = cfg.roadSettings[id] || {};
      return !cfg.closed.has(id) && (rs.carAccess !== undefined ? rs.carAccess : r.carAccess);
    });
    const demand = (onlyBoth, shifted) => {
      const trips = [];
      for (const [i, [from, to, cars]] of BACKGROUND.entries()) {
        const n = Math.round(cars * settings.backgroundScale);
        if (n > 0) trips.push({ id: `bg_${i}`, name: "Background", from, to, cars: n, background: true });
      }
      trips.push({ ...EVENT, cars: Math.max(0, Math.round(settings.eventCars) - shifted) });
      for (const t of req.trips || []) {
        if (onlyBoth && t.onlyModified) continue;
        trips.push({ id: t.id, name: t.name, from: t.fromNodeId, to: t.toNodeId, cars: Math.max(0, Math.round(t.cars)) });
      }
      return trips;
    };
    const baseCfg = { closed: new Set(), lanes: {}, roadSettings: {}, controls: {}, settings, shifted: 0 };
    const scenCfg = {
      closed: new Set(req.closedRoadIds || []), lanes: req.extraLanesByRoadId || {},
      roadSettings: req.roadSettings || {}, controls: req.intersectionControls || {}, settings, shifted: 0
    };
    if (req.busShiftPercent && busOpen(scenCfg)) scenCfg.shifted = Math.round(settings.eventCars * req.busShiftPercent / 100);

    const baseTrips = demand(true, 0), scenTrips = demand(false, scenCfg.shifted);
    const baseline = runColumn(baseCfg, baseTrips);
    const scenario = runColumn(scenCfg, scenTrips);
    // Drop background trips from the per-trip lists (they're summed in the totals).
    baseline.trips = baseline.trips.filter((t, i) => !baseTrips[i].background);
    scenario.trips = scenario.trips.filter((t, i) => !scenTrips[i].background);
    return { baseline, scenario };
  }

  return { network, simulate, nearestNode, effectiveControl, SIGNAL_DEFAULTS, SETTINGS_DEFAULTS };
})();
