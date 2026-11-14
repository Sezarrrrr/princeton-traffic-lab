// Traffix Lab frontend.
// Draws whatever network GET /api/network returns (no street names or IDs are hard-coded,
// except the optional demo preset), lets the user combine changes (road closures, extra lanes,
// signals, bus shift), and shows the POST /api/simulate results.

const SVG_NS = "http://www.w3.org/2000/svg";
const VIEW = { width: 820, height: 620, padding: 70 };
const MAX_EXTRA_LANES = 3;
const DEFAULT_GREEN_SHARE = 0.5;
const DEFAULT_BUS_PERCENT = 20;
const busRoutes = () => customRoutes;
let focusedBusId = null;
let is3D = false;
let mapViewRequest = 0;

// ---- App state ----
let network = null;         // from GET /api/network
let result = null;          // latest { baseline, scenario } from POST /api/simulate
let endpointMode = null;
let endpoints = new Map();
let roadsById = new Map(), nodesById = new Map(), signalIds = new Set();
let junctions = [];
let junctionIds = new Set();
let roadResults = {};
let activeTool = null;
let singleRoadLane = false;
const mapPicking = () => !!endpointMode || draftStop !== null ||
  !!(laneDraft && !laneDraft.options.length) || (activeTool === "signal" && !selected);
const pickingRoad = () => activeTool === "closure" || singleRoadLane;

function pickMapPoint(id) {
  if (!junctionIds.has(id)) return;
  if (activeTool === "signal") {
    if (canSignal(id)) select("node", id);
    else $("map-tool-instruction").textContent = "Pick a junction with a modeled car approach.";
  } else if (laneDraft) pickLanePoint(id);
  else if (draftStop !== null) addDraftPoint(id);
  else chooseEndpoint(id);
}
let selected = null;        // { type: "road" | "node", id }
let focusedRoadEdit = null;
const openRoadDetails = new Set();
let requestCounter = 0;     // ignore old responses if the user clicks quickly
const geometry = {};        // road id -> { p1, p2 } in SVG coordinates
const nodePoints = {};      // intersection id -> { x, y } in SVG coordinates

// Everything the user has changed. Reset puts it back to this "empty" state.
const state = {
  tripDemand: 100,
  originId: null,
  destinationId: null,
  closed: new Set(),        // road ids
  laneStretches: [],
  speedStretches: [],
  lanes: {},                // road id -> extra lanes (1..MAX_EXTRA_LANES)
  signals: new Map(),       // intersection id -> mainGreenShare (0..1)
  busRoutes: new Set(),
  busPercent: DEFAULT_BUS_PERCENT
};

// The full scenario we send to the backend (shared API contract).
function currentScenario() {
  return {
    tripDemand: state.tripDemand,
    originId: state.originId ?? undefined,
    destinationId: state.destinationId ?? undefined,
    closedRoadIds: [...state.closed],
    extraLanesByRoadId: { ...state.lanes },
    laneStretches: [...state.laneStretches],
    speedStretches: [...state.speedStretches],
    signals: [...state.signals].map(([intersectionId, mainGreenShare]) => ({ intersectionId, mainGreenShare })),
    enabledBusRouteIds: customRoutes.filter(route => state.busRoutes.has(route.id)).map(route => route.id),
    customBusRoutes: customRoutes.map(({ id, name, points }) => ({ id, name, points })),
    busShiftPercent: state.busPercent
  };
}

function snapshot() {
  return {
    tripDemand: state.tripDemand,
    originId: state.originId,
    destinationId: state.destinationId,
    closed: new Set(state.closed),
    lanes: { ...state.lanes },
    laneStretches: [...state.laneStretches],
    speedStretches: [...state.speedStretches],
    signals: new Map(state.signals),
    busRoutes: new Set(state.busRoutes),
    busPercent: state.busPercent
  };
}

function restore(saved) {
  Object.assign(state, saved);
}

// ---- Small helpers ----
const $ = id => document.getElementById(id);

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

const formatMinutes = v => (v === null || v === undefined ? "No completed trips." : `${v.toFixed(1)} min`);
const formatWait = value => value == null ? "—" : `${(value * 60).toFixed(1)} s`;
const percent = share => `${Math.round(share * 100)}%`;
const roadById = id => roadsById.get(id);
const nodeById = id => nodesById.get(id);
const roadName = id => roadById(id)?.name ?? "Road segment";
const nodeName = id => endpoints.get(id)?.name ?? nodeById(id)?.name ?? "Road junction";
const endpointNode = id => endpoints.get(id)?.nodeId ?? id;
const hasTrip = () => Boolean(state.originId && state.destinationId);
const routeRoads = () => new Set(result?.scenario.carRoutes?.flatMap(route => route.roadIds) || []);
const activeRouteRoads = () => resultMatchesEndpoints() ? routeRoads() : new Set();
const resultMatchesEndpoints = () => confirmedState?.originId === state.originId &&
  confirmedState?.destinationId === state.destinationId && confirmedState?.tripDemand === state.tripDemand;
const canSignal = id => signalIds.has(id);

function mapJunctions() {
  const approaches = new Map();
  for (const road of network.roads) {
    const name = road.name.split(" (")[0];
    for (const id of [road.from, road.to]) {
      if (!approaches.has(id)) approaches.set(id, []);
      approaches.get(id).push(name);
    }
  }
  return network.intersections.flatMap(node => {
    const names = approaches.get(node.id) || [];
    const streets = [...new Set(names)].sort();
    if (names.length < 3 && streets.length < 2) return [];
    return [{ ...node, name: node.imported && streets.length > 1 ? streets.join(" & ") : node.name }];
  });
}

function roadResult(which, id) {
  if (!result) return null;
  const actual = roadResults[which]?.get(id);
  if (actual) return actual;
  const road = roadById(id);
  const parent = road?.parentId && roadResults[which]?.get(road.parentId);
  if (parent) {
    const fraction = StreetMap.roadDistance(road) / StreetMap.roadDistance(roadById(road.parentId));
    return { ...parent, id, freeFlowMinutes: parent.freeFlowMinutes * fraction,
      travelMinutes: parent.travelMinutes === null ? null : parent.travelMinutes * fraction };
  }
  const split = roadParts.get(id)?.map(part => roadResults[which]?.get(part));
  if (split?.length === 2 && split.every(Boolean) && split[0].capacity === split[1].capacity &&
      split[0].congestionRatio === split[1].congestionRatio && split[0].speedLimitMph === split[1].speedLimitMph) {
    const [a, b] = split;
    return { ...a, id, freeFlowMinutes: a.freeFlowMinutes + b.freeFlowMinutes,
      travelMinutes: a.closed || b.closed ? null : a.travelMinutes + b.travelMinutes };
  }
  if (!road) return null;
  const source = road.speedLimits?.[road.directions?.car?.[0] === -1 ? "backward" : "forward"] ??
    { mph: 25, source: "Simulation assumption" };
  const minutes = StreetMap.roadDistance(road) * .06 / (source.mph * 1.609344);
  return { id, carTrips: 0, freeFlowMinutes: minutes, travelMinutes: minutes, congestionRatio: 0,
    closed: false, capacity: network.modeledBaseCapacity, speedLimitMph: source.mph, speedLimitSource: source };
}
const roadParts = new Map();

// Compare the backend's travel times for the same segment and trip endpoints.
function roadColorKey(id) {
  if (state.closed.has(id) || state.closed.has(roadById(id)?.parentId)) return "closed";
  const before = roadResult("baseline", id), after = roadResult("scenario", id);
  if (!resultMatchesEndpoints() || !before || !after) return "empty";
  if (after.closed) return "closed";
  if (!before.carTrips && !after.carTrips && after.speedLimitMph === after.originalSpeedLimitMph) return "empty";
  if (after.travelMinutes < before.travelMinutes - 0.000001) return "faster";
  if (after.travelMinutes > before.travelMinutes + 0.000001) return "slower";
  if (after.effectiveSpeedKph != null && before.effectiveSpeedKph != null) {
    if (after.effectiveSpeedKph > before.effectiveSpeedKph) return "faster";
    if (after.effectiveSpeedKph < before.effectiveSpeedKph) return "slower";
  }
  return before.carTrips || after.carTrips ? "unchanged" : "empty";
}

function trafficRoadIds() {
  const ids = new Set([...(roadResults.baseline?.keys() || []), ...(roadResults.scenario?.keys() || []), ...state.closed]);
  for (const id of roadResults.scenario?.keys() || []) {
    const parent = roadById(id)?.parentId;
    if (parent && !state.closed.has(parent)) ids.delete(parent);
  }
  return ids;
}

// Fit any set of x/y coordinates into the SVG, so the backend can use any scale.
function makeProjector(intersections) {
  const xs = intersections.map(i => i.x), ys = intersections.map(i => i.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1), spanY = Math.max(maxY - minY, 1);
  const scale = Math.min((VIEW.width - 2 * VIEW.padding) / spanX, (VIEW.height - 2 * VIEW.padding) / spanY);
  const offsetX = (VIEW.width - spanX * scale) / 2;
  const offsetY = (VIEW.height - spanY * scale) / 2;
  return p => ({ x: offsetX + (p.x - minX) * scale, y: offsetY + (p.y - minY) * scale });
}

function makeClickable(g, label, onActivate) {
  g.setAttribute("tabindex", "0");
  g.setAttribute("role", "button");
  g.setAttribute("aria-label", label);
  g.addEventListener("click", onActivate);
  g.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onActivate(e); }
  });
}

// ---- Drawing the map (once, from the network data) ----
function drawMap() {
  const svg = $("map");
  svg.setAttribute("viewBox", `0 0 ${VIEW.width} ${VIEW.height}`);
  svg.innerHTML = "";

  const byId = Object.fromEntries(network.intersections.map(i => [i.id, i]));
  const project = makeProjector(network.intersections);
  for (const inter of [...network.intersections, ...(network.streetPicks || [])]) nodePoints[inter.id] = project(inter);
  for (const road of network.pickRoads || []) geometry[road.id] = { p1: nodePoints[road.from], p2: nodePoints[road.to] };

  const roadLayer = svgEl("g");
  const importedLayer = svgEl("g", { id: "schematic-import" });
  const customLayer = svgEl("g", { id: "schematic-custom" });
  const laneLayer = svgEl("g", { id: "schematic-lane-edits", "pointer-events": "none" });
  const coverageLayer = svgEl("g");
  const importedPaths = [];
  const endpointLayer = svgEl("g", { id: "schematic-endpoints" });
  const carLayer = svgEl("g", { id: "car-layer" });
  const labelLayer = svgEl("g");
  const nodeLayer = svgEl("g");
  const junctionPaths = junctions.map(({ id }) => {
    const { x, y } = nodePoints[id];
    return `M${x.toFixed(2)} ${y.toFixed(2)}h.01`;
  }).join("");
  const junctionLayer = svgEl("g", { class: "schematic-junction-picks" });
  junctionLayer.append(
    svgEl("path", { d: junctionPaths, stroke: "#a95622", "stroke-width": 3.6 }),
    svgEl("path", { d: junctionPaths, stroke: "#ffcf91", "stroke-width": 2.4 })
  );
  svg.append(coverageLayer, importedLayer, roadLayer, laneLayer, carLayer, labelLayer, nodeLayer, customLayer, junctionLayer, endpointLayer);
  if (network.coverage) {
    const center = project({ x: 0, y: 0 });
    const edge = project({ x: network.coverage.radiusMeters, y: 0 });
    coverageLayer.append(svgEl("circle", { cx: center.x, cy: center.y, r: edge.x - center.x, class: "schematic-coverage" }));
  }

  for (const road of network.roads) {
    if (!byId[road.from] || !byId[road.to]) continue; // reported in the status line
    const p1 = nodePoints[road.from], p2 = nodePoints[road.to];
    geometry[road.id] = { p1, p2 };
    if (road.osmWay) {
      importedPaths.push(`M${p1.x.toFixed(2)} ${p1.y.toFixed(2)}L${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`);
      continue;
    }
    const line = { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;

    const g = svgEl("g", { class: "road", "data-road-id": road.id });
    const title = svgEl("title");
    title.textContent = road.name;
    g.append(
      title,
      svgEl("line", { ...line, class: "halo" }),
      svgEl("line", { ...line, class: "line" }),
      svgEl("line", { ...line, class: "hit" }),
      svgEl("path", {
        class: "x-mark",
        d: `M${mx - 9},${my - 9} L${mx + 9},${my + 9} M${mx + 9},${my - 9} L${mx - 9},${my + 9}`
      })
    );
    makeClickable(g, road.name, () => {
      if (!mapPicking()) select("road", road.id);
    });
    roadLayer.append(g);

    const label = svgEl("text", { class: "trip-badge", "data-road-id": road.id, x: mx, y: my - 16, "text-anchor": "middle" });
    labelLayer.append(label);
  }

  if (importedPaths.length) {
    importedLayer.append(svgEl("path", { d: importedPaths.join(""), class: "schematic-imported-roads" }),
      svgEl("g", { id: "schematic-import-active" }));
    svg.onclick = event => {
      if (!mapPicking() && event.target.closest("[role=button]")) return;
      const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
      if (mapPicking()) {
        let closest, best = 9;
        for (const node of junctions) {
          const point = nodePoints[node.id];
          const distance = Math.hypot(point.x - p.x, point.y - p.y);
          if (distance < best) { closest = node; best = distance; }
        }
        if (closest) pickMapPoint(closest.id);
      } else {
        let junction, nearest = 1.7;
        for (const node of pickingRoad() ? [] : network.intersections) {
          if (!node.imported) continue;
          const point = nodePoints[node.id];
          const distance = Math.hypot(point.x - p.x, point.y - p.y);
          if (distance < nearest) { junction = node; nearest = distance; }
        }
        if (junction) { select("node", junction.id); return; }
        let closest, best = 6;
        for (const [id, { p1, p2 }] of Object.entries(geometry)) {
          const dx = p2.x - p1.x, dy = p2.y - p1.y;
          const fraction = Math.min(1, Math.max(0, ((p.x - p1.x) * dx + (p.y - p1.y) * dy) / (dx*dx + dy*dy)));
          const distance = Math.hypot(p.x - p1.x - fraction * dx, p.y - p1.y - fraction * dy);
          if (distance < best) { closest = id; best = distance; }
        }
        if (closest) select("road", closest);
      }
    };
  }

  for (const inter of network.intersections) {
    if (inter.imported) continue;
    const p = nodePoints[inter.id];
    const signalOk = canSignal(inter.id);
    const g = svgEl("g", { class: "node" + (signalOk ? " can-signal" : ""), "data-node-id": inter.id });
    const title = svgEl("title");
    title.textContent = inter.name + (signalOk ? " (signal possible)" : "");
    // Put labels on the left for nodes near the right edge so they aren't cut off.
    const onRight = p.x > VIEW.width * 0.75;
    const label = svgEl("text", {
      class: "node-label",
      x: onRight ? p.x + 6 : p.x + 12,
      y: onRight ? p.y + 24 : p.y + 4,
      "text-anchor": onRight ? "end" : "start"
    });
    label.textContent = inter.name;
    const signalIcon = svgEl("g", { class: "signal-icon", transform: `translate(${p.x - 26}, ${p.y - 34})` });
    signalIcon.append(
      svgEl("rect", { width: 14, height: 30, rx: 3 }),
      svgEl("circle", { cx: 7, cy: 7, r: 3.5, class: "lamp red" }),
      svgEl("circle", { cx: 7, cy: 15, r: 3.5, class: "lamp amber" }),
      svgEl("circle", { cx: 7, cy: 23, r: 3.5, class: "lamp green" })
    );
    g.append(title, svgEl("circle", { class: "ring", cx: p.x, cy: p.y, r: 12 }), svgEl("circle", { class: "dot", cx: p.x, cy: p.y, r: 7 }), label, signalIcon);
    makeClickable(g, inter.name, () => select("node", inter.id));
    nodeLayer.append(g);
  }
  for (const [index, place] of (network.locations || []).entries()) {
    const anchor = nodePoints[place.nodeId];
    const x = anchor.x + (index % 2 ? -19 : 19), y = anchor.y + (index % 2 ? 13 : -18);
    const marker = svgEl("circle", { class: "schematic-landmark", cx: x, cy: y, r: 5 });
    const title = svgEl("title");
    title.textContent = place.name;
    marker.append(title);
    makeClickable(marker, place.name, () => pickMapPoint(place.id));
    endpointLayer.append(marker);
  }
}

// ---- Updating the map from the latest results ----
function laneMarkings() {
  const counts = new Map(Object.entries(state.lanes));
  const edits = [...counts.keys()].map(id => ({ roadIds: [id] }));
  for (const edit of state.laneStretches) {
    edits.push(edit);
    for (const id of edit.roadIds) counts.set(id, (counts.get(id) || 0) + 1);
  }
  for (const [id, extra] of counts) {
    const parent = roadById(id)?.parentId;
    if (parent) counts.set(id, extra + (counts.get(parent) || 0));
  }
  const displayCounts = new Map(counts);
  for (const id of roadResults.scenario?.keys() || []) {
    const parent = roadById(id)?.parentId;
    if (!counts.has(parent)) continue;
    displayCounts.delete(parent);
    displayCounts.set(id, counts.get(id) || counts.get(parent));
  }
  return {
    counts: displayCounts,
    labels: edits.map(({ roadIds }) => {
      const added = roadIds.map(id => counts.get(id));
      const base = network.modeledBaseLanes;
      const low = Math.min(...added), high = Math.max(...added);
      const range = offset => low === high ? low + offset : `${low + offset}–${high + offset}`;
      return { roadIds, text: Number.isInteger(base)
        ? `${range(base)} lanes` : `+${range(0)} lane${high === 1 ? "" : "s"}` };
    })
  };
}

function renderMap(laneEdits) {
  const routeIds = activeRouteRoads();
  const imported = $("schematic-import-active");
  if (imported) {
    imported.replaceChildren();
    for (const id of new Set([...routeIds, ...trafficRoadIds(), selected?.id])) {
      if (!roadById(id)?.osmWay) continue;
      const { p1, p2 } = geometry[id];
      const line = { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
      if (routeIds.has(id)) imported.append(svgEl("line", { ...line, stroke: "#6047d9", "stroke-width": 5 }));
      imported.append(svgEl("line", { ...line, "data-road-id": id,
        stroke: `var(--${roadColorKey(id)})`, "stroke-width": 2.5 }));

    }
  }
  for (const g of document.querySelectorAll(".road")) {
    const id = g.dataset.roadId;
    const isClosed = state.closed.has(id);
    const width = routeIds.has(id) ? 9 : 5;
    g.classList.toggle("closed", isClosed);
    g.classList.toggle("on-route", routeIds.has(id));
    g.classList.toggle("selected", selected && selected.type === "road" && selected.id === id);
    const line = g.querySelector(".line");
    line.setAttribute("stroke", `var(--${roadColorKey(id)})`);
    line.setAttribute("stroke-width", width);
    g.querySelector(".halo").setAttribute("stroke-width", width + 12);
  }

  const lanes = $("schematic-lane-edits");
  lanes.replaceChildren();
  for (const [id, count] of laneEdits.counts) {
    if (!geometry[id]) continue;
    const { p1, p2 } = geometry[id];
    const line = { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    lanes.append(
      svgEl("line", { ...line, stroke: `var(--${roadColorKey(id)})`,
        "stroke-width": (routeIds.has(id) ? 9 : 5) + 2 * count, "stroke-linecap": "round" }),
      ...(!state.closed.has(id) && !state.closed.has(roadById(id)?.parentId)
        ? [svgEl("line", { ...line, class: "lane-divider" })] : [])
    );
  }
  for (const { roadIds, text } of laneEdits.labels) {
    const middle = geometry[roadIds[Math.floor(roadIds.length / 2)]];
    if (!middle) continue;
    const label = svgEl("text", { class: "schematic-lane-count",
      x: (middle.p1.x + middle.p2.x) / 2, y: (middle.p1.y + middle.p2.y) / 2 - 7 });
    label.textContent = text;
    lanes.append(label);
  }

  for (const label of document.querySelectorAll(".trip-badge")) {
    const id = label.dataset.roadId;
    const before = roadResult("baseline", id), after = roadResult("scenario", id);
    const lanes = state.lanes[id] || 0;
    let text = "";
    if (after && before && !after.closed && after.carTrips > 0) {
      const diff = after.carTrips - before.carTrips;
      text = `${after.carTrips}` + (diff ? ` (${diff > 0 ? "+" : ""}${diff})` : "");
    }
    if (lanes && !state.closed.has(id)) text += `${text ? " · " : ""}+${lanes} lane${lanes > 1 ? "s" : ""}`;
    label.textContent = text;
  }

  for (const g of document.querySelectorAll(".node")) {
    const id = g.dataset.nodeId;
    g.classList.toggle("selected", selected && selected.type === "node" && selected.id === id);
    g.classList.toggle("has-signal", state.signals.has(id));
  }

  document.querySelectorAll(".schematic-pin").forEach(pin => pin.remove());
  if (!hasTrip()) return;
  for (const [field, letter] of [["originId", "A"], ["destinationId", "B"]]) {
    const point = nodePoints[endpointNode(state[field])];
    if (!point) continue;
    const pin = svgEl("g", { class: `schematic-pin endpoint-pin-${letter}`,
      transform: `translate(${point.x} ${point.y - 23})` });
    const text = svgEl("text", { "text-anchor": "middle", y: 4 });
    text.textContent = letter;
    pin.append(svgEl("circle", { r: 10 }), text);
    $("schematic-endpoints").append(pin);
  }


}

function renderSchematicCustomBuses() {
  const layer = $("schematic-custom");
  if (!layer) return;
  layer.replaceChildren();
  const draw = (points, roadIds, color) => {
    const group = svgEl("g", { style: `color: ${color}` });
    for (const id of roadIds) {
      if (!geometry[id]) continue;
      const { p1, p2 } = geometry[id];
      group.append(svgEl("line", { class: "bus-line", x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }));
    }
    for (const [index, point] of points.entries()) {
      const p = nodePoints[endpointNode(point.endpointId)];
      if (!p) continue;
      const stop = svgEl("circle", { class: "schematic-stop", cx: p.x + 5, cy: p.y - 5, r: point.stop ? 4 : 2 });
      makeClickable(stop, endpoints.get(point.endpointId).name, () => pickMapPoint(point.endpointId));
      const label = svgEl("text", { class: "schematic-stop-number", x: p.x + 5, y: p.y - 5 });
      label.textContent = index + 1;
      group.append(stop, label);
    }
    layer.append(group);
  };
  for (const route of customRoutes) {
    if (!state.busRoutes.has(route.id)) continue;
    const service = result?.scenario.busRoutes?.find(item => item.id === route.id);
    draw(route.points, service?.roadIds || [], route.color);
  }
  if (draft) draw(draft.points, preview?.legs?.flatMap(leg => leg.roadIds) || [], draft.color);
}

// ---- Panel: selected road or intersection ----
function renderSelected() {
  const box = $("selected");
  box.hidden = !activeTool || !selected;
  box.replaceChildren();
  if (box.hidden) return;
  if (selected.type === "road") renderSelectedRoad(box, selected.id);
  else renderSelectedNode(box, selected.id);
}

function renderSelectedRoad(box, id) {
  const isClosed = state.closed.has(id);
  const lanes = state.lanes[id] || 0;
  const before = roadResult("baseline", id), after = roadResult("scenario", id);
  const trips = r => (r ? String(r.carTrips) : "–");
  const mins = r => r?.travelMinutes != null ? `${r.travelMinutes.toFixed(3)} min` : "–";
  const speed = r => r?.effectiveSpeedKph != null ? `${(r.effectiveSpeedKph / 1.609344).toFixed(1)} mph` : "–";
  const limit = value => value != null ? `${Number(value.toFixed(1))} mph` : "–";
  const freeFlow = value => value != null ? `${value.toFixed(2)} min` : "–";
  const capacity = r => r?.capacity != null ? String(r.capacity) : "–";
  const ratio = r => (r && r.congestionRatio !== null ? r.congestionRatio.toFixed(2) : "–");

  box.append(el("h2", {}, roadName(id)));
  box.append(el("p", { class: "selected-meta muted" }, isClosed ? "Closed" : "Open"));
  const road = roadById(id);
  if (road.carAccess === false) box.append(el("p", { class: "small muted" }, "Restricted to non-car routing."));
  else if (road.twoWay === false) {
    const [from, to] = road.directions?.car?.[0] === -1 ? [road.to, road.from] : [road.from, road.to];
    box.append(el("p", { class: "small muted" }, `One way · ${nodeName(from)} → ${nodeName(to)}`));
  }

  const table = el("table", { class: "compare" });
  table.innerHTML = `<thead><tr><th></th><th>Original</th><th>Modified</th></tr></thead>`;
  const body = el("tbody");
  for (const [label, original, modified] of [
    ["Speed limit", limit(before?.speedLimitMph ?? after?.originalSpeedLimitMph), limit(after?.speedLimitMph)],
    ["Free-flow time", freeFlow(before?.freeFlowMinutes ?? after?.originalFreeFlowMinutes), freeFlow(after?.freeFlowMinutes)]
  ]) {
    const tr = el("tr");
    tr.append(el("th", { scope: "row" }, label), el("td", {}, original), el("td", {}, modified));
    body.append(tr);
  }
  for (const [label, fn] of [["Car trips", trips], ["Segment travel time", mins], ["Effective speed", speed], ["Capacity", capacity], ["Volume / capacity", ratio]]) {
    const tr = el("tr");
    tr.append(el("th", { scope: "row" }, label), el("td", {}, fn(before)), el("td", {}, fn(after)));
    body.append(tr);
  }
  table.append(body);
  box.append(table);
  const sources = el("div", { class: "small muted speed-sources" });
  const directions = road.directions?.car ?? (road.twoWay === false ? [1] : [1, -1]);
  for (const direction of directions.length ? directions : [1]) {
    const key = direction === 1 ? "forward" : "backward";
    const source = after?.directions?.[key]?.speedLimitSource ?? road.speedLimits?.[key] ??
      { mph: 25, source: "Simulation assumption" };
    const toward = direction === 1 ? road.to : road.from;
    const row = el("p", {}, `Toward ${nodeName(toward)} · ${limit(source.mph)} · `);
    row.append(source.url ? el("a", { href: source.url, target: "_blank", rel: "noopener" }, source.source) : source.source);
    const actual = after?.directions?.[key];
    if (directions.length > 1 && actual && Object.values(after.directions)
      .some(other => other.speedLimitMph !== actual.speedLimitMph)) {
      row.append(` · ${speed(actual)} effective`);
    }
    sources.append(row);
  }
  box.append(sources);
  if (road.osmWay) box.append(el("p", { class: "small muted" }, "Imported street segment"));

  if (activeTool === "closure") {
    const actions = el("div", { class: "actions" });
    const toggle = el("button", { type: "button", class: "primary" }, isClosed ? "Reopen road" : "Confirm closure");
    toggle.addEventListener("click", () => change(() => {
      if (state.closed.has(id)) state.closed.delete(id); else state.closed.add(id);
    }));
    actions.append(toggle);
    box.append(actions);
  }
  if (!singleRoadLane) return;

  const laneRow = el("div", { class: "stepper" });
  const minus = el("button", { type: "button", "aria-label": "Remove a lane" }, "−");
  const plus = el("button", { type: "button", "aria-label": "Add a lane" }, "+");
  minus.disabled = isClosed || lanes === 0;
  plus.disabled = isClosed || lanes >= MAX_EXTRA_LANES || roadById(id).carAccess === false;
  const setLanes = n => change(() => { if (n > 0) state.lanes[id] = n; else delete state.lanes[id]; });
  minus.addEventListener("click", () => setLanes(lanes - 1));
  plus.addEventListener("click", () => setLanes(lanes + 1));
  laneRow.append(el("span", {}, "Extra lanes"), minus, el("strong", { class: "count" }, String(lanes)), plus);
  box.append(laneRow);
  if (isClosed) box.append(el("p", { class: "small muted" }, "Reopen the road to add lanes."));
}

function renderSelectedNode(box, id) {
  box.append(el("h2", {}, nodeName(id)));
  box.append(el("p", { class: "selected-meta muted" }, "Intersection"));

  if (!canSignal(id)) {
    box.append(el("p", { class: "muted" }, "This junction has no modeled signal approaches. Pick another intersection."));
    return;
  }
  const hasSignal = state.signals.has(id);
  const toggle = el("button", { type: "button", class: "primary" }, hasSignal ? "Remove signal" : "Add signal");
  toggle.addEventListener("click", () => change(() => {
    if (state.signals.has(id)) state.signals.delete(id); else state.signals.set(id, DEFAULT_GREEN_SHARE);
  }));
  const actions = el("div", { class: "actions" });
  actions.append(toggle);
  box.append(actions);

  const phases = network.signalApproaches?.[id];
  if (phases) {
    const names = roadIds => roadIds.map(roadName).join(", ") || "No modeled car approach";
    box.append(
      el("p", { class: "muted" }, `Main green · ${names(phases.mainRoadIds)}`),
      el("p", { class: "muted" }, `Remaining green · ${names(phases.crossRoadIds)}`)
    );
  }
  if (!hasSignal) return;
  addSlider(box, "green-share", "Main green share", 0.2, 0.8, 0.05, state.signals.get(id),
    percent, share => state.signals.set(id, share));
  if (network.signalCycleSeconds) {
    box.append(el("p", { class: "small muted" }, `Assumed ${network.signalCycleSeconds}-second cycle. Wait depends on the red time for each approach.`));
  }
  const signal = result?.scenario.signals?.find(item => item.intersectionId === id);
  if (signal) {
    const waits = el("ul", { class: "approach-waits" });
    for (const approach of signal.approaches) {
      const seconds = Math.round(approach.waitMinutes * 60);
      waits.append(el("li", {}, `${roadName(approach.roadId)} · ${approach.carTrips} trips · ${seconds} s average wait`));
    }
    box.append(waits);
  }
}

function addSlider(box, id, title, min, max, step, current, format, mutate, disabled = false) {
  const wrap = el("div", { class: "slider" });
  const label = el("label", { for: id }, `${title} `);
  const value = el("strong", {}, format(current));
  const input = el("input", { type: "range", id, min, max, step, value: current });
  input.disabled = disabled;
  input.addEventListener("input", () => { value.textContent = format(Number(input.value)); });
  input.addEventListener("change", () => change(() => mutate(Number(input.value))));
  label.append(value);
  wrap.append(label, input);
  box.append(wrap);
}

function renderBus() {
  const box = $("bus-controls");
  const restoreSliderFocus = document.activeElement?.id === "bus-percent";
  box.replaceChildren();
  for (const route of busRoutes()) {
    const input = el("input", { type: "checkbox", id: `bus-${route.id}`, "aria-label": route.name });
    input.checked = state.busRoutes.has(route.id);
    input.addEventListener("change", () => change(() => {
      if (input.checked) state.busRoutes.add(route.id);
      else {
        state.busRoutes.delete(route.id);
        if (focusedBusId === route.id) focusedBusId = null;
      }
    }));
    const name = el("button", { type: "button", class: "bus-line-name",
      "aria-pressed": String(focusedBusId === route.id) }, route.name);
    name.onclick = () => {
      focusedBusId = route.id;
      showView("street");
      render();
      StreetMap.focusBus(route, result?.scenario.busRoutes?.find(item => item.id === route.id));
    };
    const controls = el("div", { class: "bus-line-controls" });
    controls.append(input, el("i", { class: "route-swatch", style: `background: ${route.color}` }), name);
    const service = result?.scenario.busRoutes?.find(item => item.id === route.id);
    const stops = route.stopIds.map(id => endpoints.get(id)?.name || nodeName(endpointNode(id))).join(" → ");
    let description = "Off · 0 trips shifted.";
    if (input.checked) {
      description = "Checking service…";
      if (service?.error) description = `Service unavailable. ${service.error} 0 trips shifted.`;
      else if (resultMatchesEndpoints() && service?.servesPartialTrip) {
        const riders = service.partialShiftedTrips;
        description = `${service.detoured ? "Running via detour" : "Running"} · ${riders} trips using bus for part of the route.`;
      }
      else if (resultMatchesEndpoints() && service?.enabled && !service.servesTrip) description = `${service.detoured ? "Running via detour." : "Running."} 0 trips shifted. ${service.tripMismatch || "The selected trip does not match the stop order."}`;
      else if (resultMatchesEndpoints() && service?.operating) {
        const boarding = endpoints.get(service.boardingStopId)?.name;
        const alighting = endpoints.get(service.alightingStopId)?.name;
        description = `${service.detoured ? "Running via detour" : "Running"} · ${boarding} → ${alighting} · ${service.shiftedTrips} trips shifted.`;
      }
    }
    const entry = el("div", { class: "bus-route-entry" });
    box.append(entry);
    entry.append(controls, el("p", { class: "route-stops muted" }, stops),
      el("p", { class: "route-status muted", "data-route-id": route.id }, description));
    if (route.points) {
      const edit = el("button", { type: "button", "aria-label": `Edit ${route.name}` }, "Edit");
      const remove = el("button", { type: "button", "aria-label": `Delete ${route.name}` }, "Delete");
      edit.onclick = () => activateTool("bus", route);
      remove.onclick = () => {
        if (draft?.id === route.id) closeBusDraft();
        change(() => {
          customRoutes = customRoutes.filter(item => item.id !== route.id);
          state.busRoutes.delete(route.id);
          if (focusedBusId === route.id) focusedBusId = null;
          persistCustomRoutes();
        });
      };
      const actions = el("div", { class: "custom-route-actions" });
      actions.append(edit, remove);
      entry.append(actions);
    }
  }
  if (!CONFIG.useMock && !customRoutes.length) {
    box.append(el("p", { class: "muted" }, "No saved bus lines."));
  }
  addSlider(box, "bus-percent", "Eligible trips switching to bus", 0, 50, 5, state.busPercent,
    value => `${value}%`, value => { state.busPercent = value; }, CONFIG.useMock);
  if (restoreSliderFocus) $("bus-percent").focus({ preventScroll: true });
}

// ---- Panel: list of changes ----
function crossStreet(id, street, fallback) {
  const name = endpoints.get(id)?.name ?? fallback;
  const shortName = name.split(" & ").filter(part => part !== street &&
    !(street === "Nassau Street" && part === "Nassau")).join(" & ");
  return shortName || fallback;
}

function stretchName({ startId, endId, roadIds }) {
  const street = roadName(roadIds[0]).split(" (")[0];
  return `${street} · ${crossStreet(startId, street, "Start")} → ${crossStreet(endId, street, "End")}`;
}

function appendRoadEditDetails(li, edit, request, isOpen) {
  const details = el("details", { class: "road-edit-details" });
  const content = el("div", { class: "small" });
  details.append(el("summary", {}, "Details"), content);
  li.append(details);
  let loaded = false;
  const load = async () => {
    if (loaded) return;
    loaded = true;
    content.textContent = "Comparing this edit…";
    try {
      const segments = await postScenario("road-edit-details", { scenario: currentScenario(), ...request });
      if (!details.isConnected) return;
      const duration = value => value == null ? "Closed" : `${value.toFixed(3)} min`;
      const rows = el("ul", { class: "road-edit-segments" });
      for (const [index, { id, before, after }] of segments.entries()) {
        const road = roadById(id);
        const from = endpoints.get(road.from)?.name, to = endpoints.get(road.to)?.name;
        const junction = name => name?.includes(" & ") && !name.includes("road junction") ? name : null;
        const names = [junction(from), junction(to)].filter(Boolean);
        const label = names.length ? names.join(" → ") : `Segment ${index + 1}`;
        const row = el("li");
        row.append(el("strong", {}, label),
          el("div", {}, `Capacity ${before.capacity} → ${after.capacity} · ${duration(before.travelMinutes)} → ${duration(after.travelMinutes)}`));
        if (request.speedIndex != null) row.append(el("div", {}, `Speed limit ${before.speedLimitMph} → ${after.speedLimitMph} mph`));
        rows.append(row);
      }
      content.replaceChildren(el("p", { class: "muted" }, "Same scenario, with and without this edit."), rows);
    } catch (error) {
      content.textContent = error.message;
      loaded = false;
    }
  };
  details.open = isOpen;
  details.ontoggle = () => {
    if (!details.isConnected) return;
    if (details.open) { openRoadDetails.add(edit); load(); }
    else openRoadDetails.delete(edit);
  };
}

function renderChanges() {
  const list = $("changes");
  list.innerHTML = "";
  const items = [];
  for (const id of state.closed) items.push([`Closed ${roadName(id)}`, () => state.closed.delete(id)]);
  for (const [id, n] of Object.entries(state.lanes)) {
    const { from, to } = roadById(id);
    const stretch = { startId: from, endId: to, roadIds: [id] };
    items.push([`${stretchName(stretch)} · +${n} lane${n > 1 ? "s" : ""}`,
      () => delete state.lanes[id], id, stretch, { extraLaneRoadId: id }]);
  }
  for (const [index, stretch] of state.laneStretches.entries()) {
    items.push([`${stretchName(stretch)} · +1 lane`, () => state.laneStretches.splice(index, 1),
      stretch, stretch, { laneIndex: index }]);
  }
  for (const [index, stretch] of state.speedStretches.entries()) {
    items.push([`${stretchName(stretch)} · ${stretch.speedLimitMph} mph`, () => state.speedStretches.splice(index, 1),
      stretch, stretch, { speedIndex: index }]);
  }
  for (const [id, share] of state.signals) items.push([`Signal at ${nodeName(id)} (main road green ${percent(share)})`, () => state.signals.delete(id)]);
  for (const route of busRoutes()) {
    if (state.busRoutes.has(route.id)) items.push([`${route.name} · ${state.busPercent}% of eligible trips switch`, () => {
      state.busRoutes.delete(route.id);
    }]);
  }

  const editKeys = new Set(items.map(item => item[2]));
  if (!editKeys.has(focusedRoadEdit)) clearRoadEditFocus();
  for (const key of openRoadDetails) if (!editKeys.has(key)) openRoadDetails.delete(key);
  if (!items.length) {
    list.append(el("li", { class: "muted" }, "No changes. This is the original scenario."));
    return;
  }
  for (const [text, undo, edit, stretch, request] of items) {
    const li = el("li");
    const remove = el("button", { type: "button", class: "link", "aria-label": `Undo: ${text}` }, "Undo");
    remove.addEventListener("click", () => change(undo));
    if (stretch) {
      li.classList.add("road-edit");
      const actions = el("div", { class: "road-edit-actions" });
      const show = el("button", { type: "button", class: "link",
        "aria-label": `Show on map: ${text}`, "aria-pressed": String(focusedRoadEdit === edit) }, "Show on map");
      show.onclick = () => {
        const alreadyFocused = focusedRoadEdit === edit;
        cancelMapTool();
        if (!alreadyFocused) {
          focusedRoadEdit = edit;
          showView("street");
          StreetMap.focusRoadEdit([stretch.startId, stretch.endId], stretch.roadIds);
        }
        render();
        list.querySelectorAll(".road-edit-actions button:first-child")[indexOfEdit]?.focus({ preventScroll: true });
      };
      const indexOfEdit = list.querySelectorAll(".road-edit").length;
      actions.append(show, remove);
      li.append(el("span", {}, text), actions);
      if (!CONFIG.useMock) appendRoadEditDetails(li, edit, request, openRoadDetails.has(edit));
    } else li.append(el("span", {}, text), remove);
    list.append(li);
  }
}

// ---- Panel: original vs. modified ----
function renderComparison() {
  const body = $("compare-body");
  body.replaceChildren();
  const table = $("comparison-table"), empty = $("comparison-empty"), check = $("conservation");
  table.hidden = true;
  empty.hidden = false;
  check.textContent = "";
  empty.textContent = hasTrip() ? "No changes to trip results yet." : "Choose both trip endpoints to see results.";
  if (!result || !resultMatchesEndpoints()) return;
  const b = result.baseline, s = result.scenario;

  // [label, before, after, how to format, is "up" bad?]
  const rows = [["Avg. car trip", b.avgCarTravelMinutes, s.avgCarTravelMinutes, formatMinutes, true]];
  if ("avgCarSignalWaitMinutes" in s) rows.push(["Avg. signal wait per car trip", b.avgCarSignalWaitMinutes, s.avgCarSignalWaitMinutes, formatWait, true]);
  if ("completedCarTrips" in s) rows.push(["Completed car trips", b.completedCarTrips, s.completedCarTrips, String, false]);
  rows.push(["Unserved car trips", b.unservedCarTrips, s.unservedCarTrips, String, true]);
  rows.push(["Shifted to bus", b.carTripsShiftedToBus, s.carTripsShiftedToBus, String, null]);
  if ("partialBusTrips" in s) rows.push(["Trips using bus for part of the route", b.partialBusTrips, s.partialBusTrips, String, null]);
  if ("totalCarTrips" in s) rows.push(["Total trips", b.totalCarTrips, s.totalCarTrips, String, null]);

  for (const [label, before, after, fmt, upIsBad] of rows) {
    const original = fmt(before), modified = fmt(after);
    if (original === modified) continue;
    const tr = el("tr");
    const afterCell = el("td", {}, modified);
    if (upIsBad !== null && before !== null && after !== null) {
      const worse = (after > before) === upIsBad;
      afterCell.classList.add(worse ? "worse" : "better");
    }
    tr.append(el("th", { scope: "row" }, label), el("td", {}, original), afterCell);
    body.append(tr);
  }

  table.hidden = !body.childElementCount;
  empty.hidden = !table.hidden;
  if ("totalCarTrips" in s && "completedCarTrips" in s) {
    const ok = r => r.completedCarTrips + r.unservedCarTrips + r.carTripsShiftedToBus === r.totalCarTrips;
    if (!ok(b) || !ok(s)) check.textContent = "⚠ Trip totals don't add up. Check the backend response.";
  }
}

function renderShifts() {
  const list = $("shifts");
  list.innerHTML = "";
  if (!result) return;
  const changed = network.roads
    .map(road => ({ road, before: roadResult("baseline", road.id), after: roadResult("scenario", road.id) }))
    .filter(x => x.before && x.after && x.before.carTrips !== x.after.carTrips)
    .sort((x, y) => (y.after.carTrips - y.before.carTrips) - (x.after.carTrips - x.before.carTrips));

  if (!changed.length) {
    list.append(el("li", { class: "muted" }, "No change from the original scenario."));
    return;
  }
  for (const { road, before, after } of changed) {
    const li = el("li");
    li.append(
      el("span", {}, road.name + (after.closed ? " (closed)" : "")),
      el("span", { class: "nums " + (after.carTrips > before.carTrips ? "worse" : "better") }, `${before.carTrips} → ${after.carTrips}`)
    );
    list.append(li);
  }
}

const endpointFields = [["originId", "From"], ["destinationId", "To"]];
const pickerInputs = new Map();
const mapPickButtons = new Map();

function chooseEndpoint(id, field = endpointMode) {
  if (!field || !endpoints.has(id)) return;
  const other = field === "originId" ? "destinationId" : "originId";
  if (endpointNode(id) === endpointNode(state[other])) {
    $("trip-feedback").textContent = "Choose different points for From and To.";
    return;
  }
  cancelMapTool();
  change(() => { state[field] = id; });
  StreetMap.revealEndpoints([state.originId, state.destinationId]);
  syncTripControls();
}

function syncTripControls() {
  for (const [field] of endpointFields) {
    const entry = pickerInputs.get(field);
    if (entry && (entry.id !== state[field] || document.activeElement !== entry.input)) {
      entry.input.value = endpoints.get(state[field])?.name || "";
      entry.id = state[field];
    }
    mapPickButtons.get(field)?.setAttribute("aria-pressed", String(endpointMode === field));
  }
  $("trip-mode").textContent = endpointMode
    ? `Next map click sets ${endpointMode === "originId" ? "From" : "To"}. Choose a marked street junction.` : "";
  $("trip-controls").closest(".map-card").classList.toggle("picking-endpoint", mapPicking());
  StreetMap.showPicks(mapPicking());
  syncMapTools();
}

function createEndpointPicker(field, label) {
  const group = el("div", { class: "endpoint-control" });
  const input = el("input", {
    id: field, type: "search", autocomplete: "off",
    placeholder: field === "originId" ? "Choose a starting point" : "Choose a destination",
    "aria-controls": `${field}-matches`, "aria-expanded": "false"
  });
  const matches = el("ul", { class: "endpoint-matches", id: `${field}-matches`, hidden: "" });
  const mapButton = el("button", { type: "button", "aria-pressed": "false", "aria-label": `Pick ${label} on map` }, "Pick on map");
  pickerInputs.set(field, { input, id: null });
  mapPickButtons.set(field, mapButton);
  const hide = () => {
    matches.hidden = true;
    input.setAttribute("aria-expanded", "false");
  };
  const commit = id => {
    hide();
    chooseEndpoint(id, field);
    input.value = endpoints.get(state[field])?.name ?? "";
  };
  const showMatches = (query = "") => {
    matches.replaceChildren();
    const search = query.trim().toLocaleLowerCase();
    const options = [];
    for (const point of endpoints.values()) {
      if (point.roadId) continue;
      if (point.name.toLocaleLowerCase().includes(search)) options.push(point);
      if (options.length === 40) break;
    }
    for (const point of options) {
      const sameName = options.filter(option => option.name === point.name).length > 1;
      const suffix = sameName && point.latLng ? ` · ${point.latLng.map(value => value.toFixed(5)).join(", ")}` : "";
      const button = el("button", { type: "button", "data-endpoint-id": point.id }, point.name + suffix);
      button.addEventListener("click", () => commit(point.id));
      const item = el("li");
      item.append(button);
      matches.append(item);
    }
    if (!options.length) matches.append(el("li", { class: "muted" }, "No matching places"));
    matches.hidden = false;
    input.setAttribute("aria-expanded", "true");
    return options;
  };
  input.addEventListener("focus", () => { input.select(); showMatches(); });
  input.addEventListener("input", () => showMatches(input.value));
  input.addEventListener("keydown", event => {
    if (event.key === "Escape") { hide(); input.value = endpoints.get(state[field])?.name ?? ""; }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      matches.querySelector("button")?.focus();
    }
    if (event.key === "Enter") {
      const options = showMatches(input.value);
      const exact = options.filter(point => point.name.toLocaleLowerCase() === input.value.trim().toLocaleLowerCase());
      if (exact.length === 1 || options.length === 1) commit((exact[0] || options[0]).id);
    }
  });
  group.addEventListener("focusout", event => {
    if (!group.contains(event.relatedTarget)) {
      hide();
      input.value = endpoints.get(state[field])?.name ?? "";
    }
  });
  mapButton.addEventListener("click", () => {
    hide();
    const next = endpointMode === field ? null : field;
    cancelMapTool();
    endpointMode = next;
    $("trip-feedback").textContent = "";
    render();
  });
  group.append(el("label", { for: field }, label), input, mapButton, matches);
  return group;
}

function setupEndpointPickers() {
  endpoints = new Map([
    ...(network.locations || []), ...(network.busStops || []), ...network.intersections, ...(network.streetPicks || [])
  ].map(point => [point.id, point]));
  for (const point of junctions) endpoints.set(point.id, point);
  if (!CONFIG.useMock) {
    for (const [field, label] of endpointFields) $("trip-controls").append(createEndpointPicker(field, label));
  }
}

function speedEditDetails() {
  const limits = new Map();
  return state.speedStretches.map(edit => {
    const previousLimits = new Set();
    for (const id of edit.roadIds) {
      const previous = limits.get(id) ?? roadResult("baseline", id)?.speedLimitMph ??
        roadResult("scenario", id)?.originalSpeedLimitMph;
      if (previous != null) previousLimits.add(previous);
      limits.set(id, edit.speedLimitMph);
    }
    return {
      ...edit,
      startNodeId: endpointNode(edit.startId),
      endNodeId: endpointNode(edit.endId),
      startName: endpoints.get(edit.startId).name,
      endName: endpoints.get(edit.endId).name,
      street: roadName(edit.roadIds[0]).split(" (")[0],
      previousLimits: [...previousLimits].sort((a, b) => a - b)
    };
  });
}

function render() {
  if (Number($("trip-demand").value) !== state.tripDemand) $("trip-demand").value = state.tripDemand;
  syncTripControls();
  const laneEdits = laneMarkings();
  renderMap(laneEdits);
  renderSchematicCustomBuses();
  StreetMap.render({ state, selected, colorKey: roadColorKey, routeIds: activeRouteRoads(),
    trafficIds: trafficRoadIds(), focusedBusId, customRoutes, busServices: result?.scenario.busRoutes || [],
    speedEdits: speedEditDetails(), laneEdits });
  renderSelected();
  renderBus();
  renderChanges();
  renderComparison();
  renderShifts();
}

// ---- Animated cars (decoration: count follows car trips, speed follows travel time) ----
let cars = [];
let buses = [];
let lastFrame = null;

function schematicItinerary(roadIds, origin, signals) {
  const legs = [];
  let node = origin, duration = 0, distance = 0;
  for (const id of roadIds) {
    const road = roadById(id), geo = geometry[id];
    if (!road || !geo || (node !== road.from && node !== road.to)) return { legs: [], duration: 0 };
    const forward = road.from === node;
    const from = forward ? geo.p1 : geo.p2, to = forward ? geo.p2 : geo.p1;
    node = forward ? road.to : road.from;
    if (from.x === to.x && from.y === to.y) continue;
    const length = StreetMap.roadDistance(road);
    const seconds = StreetMap.vehicleLegSeconds(length, roadResults.scenario?.get(id), road, forward);
    legs.push({ from, to, start: duration, seconds });
    duration += seconds;
    duration += StreetMap.redLightSeconds(signals, node, road, duration);
    distance += length;
  }
  return { legs, duration, distance };
}

function schematicPosition(vehicle, dt) {
  const { legs, duration } = vehicle;
  const elapsed = vehicle.elapsed = (vehicle.elapsed + dt) % duration;
  let i = 0;
  while (i < legs.length - 1 && legs[i + 1].start <= elapsed) i++;
  const { from, to, start, seconds } = legs[i];
  const t = Math.min(1, (elapsed - start) / seconds);
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

function rebuildCars() {
  StreetMap.rebuildCars(result, $("animate-cars").checked, endpointNode(state.originId));
  const layer = $("car-layer");
  layer.innerHTML = "";
  cars = [];
  buses = [];
  if (!result) return;
  const signals = StreetMap.signalStops(result.scenario.signals);
  for (const service of result.scenario.busRoutes || []) {
    if (!service.operating) continue;
    const route = busRoutes().find(r => r.id === service.id);
    if (!route) continue;
    const itinerary = schematicItinerary(service.roadIds, service.nodeIds[0], signals);
    if (!itinerary.duration) continue;
    const marker = svgEl("g", { class: "schematic-bus", style: `color: ${route.color}` });
    marker.append(svgEl("rect", { x: -8, y: -5, width: 16, height: 10, rx: 2 }),
      svgEl("rect", { x: -5, y: -3, width: 10, height: 5, rx: 1, class: "bus-window" }));
    layer.append(marker);
    buses.push({ marker, ...itinerary, elapsed: 0 });
  }
  if (!$("animate-cars").checked) return;
  for (const route of result.scenario.carRoutes || []) {
    const { legs, duration, distance } = schematicItinerary(route.roadIds, endpointNode(state.originId), signals);
    if (!duration) continue;
    const count = Math.max(2, Math.min(16, Math.ceil(distance / 220)));
    for (let i = 0; i < count; i++) {
      const dot = svgEl("circle", { class: "car", r: 4 });
      layer.append(dot);
      cars.push({ legs, duration, elapsed: (i + 0.5) / count * duration, dot });
    }
  }
}

function animate(time) {
  const dt = lastFrame === null ? 0 : (time - lastFrame) / 1000 * StreetMap.playbackRate;
  lastFrame = time;
  if ($("schematic-view").hidden) {
    requestAnimationFrame(animate);
    return;
  }
  for (const car of cars) {
    const { x, y } = schematicPosition(car, reducedMotion ? 0 : dt);
    car.dot.setAttribute("cx", x);
    car.dot.setAttribute("cy", y);
    const fade = Math.min(0.65, car.duration * 0.15);
    car.dot.setAttribute("opacity", Math.min(1, car.elapsed / fade, (car.duration - car.elapsed) / fade));
  }
  for (const bus of buses) {
    const { x, y } = schematicPosition(bus, reducedMotion ? 0 : dt);
    bus.marker.setAttribute("transform", `translate(${x} ${y})`);
  }
  requestAnimationFrame(animate);
}

// ---- User actions ----
function syncMapTools() {
  for (const button of document.querySelectorAll("[data-map-tool]")) {
    button.setAttribute("aria-pressed", String(button.dataset.mapTool === activeTool));
  }
  $("map-tool-context").hidden = !activeTool;
  $("bus-tool").hidden = activeTool !== "bus";
  $("single-road-lane").hidden = activeTool !== "lane" || singleRoadLane || !laneDraft;
  let instruction = "";
  if (activeTool === "signal") instruction = selected ? "Set the signal or pick another intersection." : "Pick an intersection.";
  if (activeTool === "closure") instruction = selected ? "Review this road segment or pick another." : "Pick a road segment to close.";
  if (singleRoadLane) instruction = selected ? "Set the extra lanes for this segment." : "Pick a road segment.";
  if (laneDraft) instruction = laneDraft.options.length ? "Review the highlighted stretch."
    : laneDraft.startId ? "Pick the end point." : "Pick the start point.";
  if (activeTool === "bus") {
    instruction = draftStop !== null ? `Pick stop ${draftStop + 1}.`
      : draft ? "Review the shuttle path." : "Manage your saved routes.";
  }
  $("map-tool-instruction").textContent = instruction;
}

function clearRoadEditFocus() {
  if (focusedRoadEdit === null) return;
  focusedRoadEdit = null;
  StreetMap.previewLane([], []);
}

function cancelMapTool() {
  clearRoadEditFocus();
  activeTool = null;
  endpointMode = null;
  singleRoadLane = false;
  selected = null;
  closeLaneDraft();
  if (draft) closeBusDraft();
}

function activateTool(tool, route) {
  cancelMapTool();
  activeTool = tool;
  syncMapTools();
  if (tool === "bus" || tool === "lane" || tool === "speed") showView("street");
  if (tool === "bus") startBusDraft(route);
  if (tool === "lane" || tool === "speed") startLaneDraft(tool);
  render();
}

function setupMapTools() {
  for (const button of document.querySelectorAll("[data-map-tool]")) {
    const tool = button.dataset.mapTool;
    button.disabled = ["bus", "speed", "lane"].includes(tool) &&
      (CONFIG.useMock || !junctions.length || !StreetMap.isReady());
    button.onclick = () => activateTool(tool);
  }
  $("cancel-map-tool").onclick = () => { cancelMapTool(); render(); };
  $("single-road-lane").onclick = () => {
    singleRoadLane = true;
    closeLaneDraft();
    render();
  };
}

function select(type, id) {
  if (mapPicking() && activeTool !== "signal") {
    if (type === "node") pickMapPoint(id);
    return;
  }
  if (!activeTool) activeTool = type === "node" ? "signal" : "closure";
  if ((activeTool === "signal" && type !== "node") ||
      (pickingRoad() && type !== "road") ||
      (activeTool !== "signal" && !pickingRoad())) return;
  selected = { type, id };
  render();
}

function emptyState() {
  return { closed: new Set(), lanes: {}, laneStretches: [], speedStretches: [], signals: new Map(), busRoutes: new Set(), busPercent: DEFAULT_BUS_PERCENT };
}

// Apply a change to the state, then re-run the simulation.
// If the backend rejects the change, restore the last successful scenario.
function change(mutate) {
  invalidateRecommendations();
  mutate();
  if (draft) updateBusDraft();
  runSimulation();
}

let recommendationVersion = 0;

function invalidateRecommendations() {
  recommendationVersion++;
  $("recommendations").replaceChildren();
}

function applyScenario(scenario) {
  restore({
    tripDemand: scenario.tripDemand ?? state.tripDemand,
    originId: scenario.originId,
    destinationId: scenario.destinationId,
    closed: new Set(scenario.closedRoadIds),
    lanes: { ...scenario.extraLanesByRoadId },
    laneStretches: [...(scenario.laneStretches || [])],
    speedStretches: [...(scenario.speedStretches || [])],
    signals: new Map(scenario.signals.map(signal => [signal.intersectionId, signal.mainGreenShare])),
    busRoutes: new Set(scenario.enabledBusRouteIds.filter(id => customRoutes.some(route => route.id === id))),
    busPercent: scenario.busShiftPercent
  });
}

function recommendationRow(option, ties) {
  const item = el("li", { class: "recommendation-option" });
  const rank = ties.get(option.rank) > 1 ? `Tied #${option.rank}` : `#${option.rank}`;
  const title = el("strong", {}, `${rank} · ${option.label}`);
  const metrics = el("p", { class: "muted" },
    `${option.completedCarTrips} completed by car · ${option.unservedCarTrips} unserved · ` +
    `${option.carTripsShiftedToBus} shifted to bus · ${option.partialBusTrips ?? 0} using bus for part of the route · ${formatMinutes(option.avgCarTravelMinutes)} avg. by car`);
  item.append(title, metrics);
  if (!option.isCurrent) {
    const apply = el("button", { type: "button", "aria-label": `Apply ${option.label}` }, "Apply");
    apply.addEventListener("click", () => change(() => applyScenario(option.scenario)));
    item.append(apply);
  }
  return item;
}

async function findBestFix() {
  const version = ++recommendationVersion;
  const box = $("recommendations");
  $("recommend").disabled = true;
  box.textContent = "Comparing changes…";
  try {
    const data = await postScenario("recommend", currentScenario());
    if (version !== recommendationVersion) return;
    const ties = new Map();
    for (const option of data.options) ties.set(option.rank, (ties.get(option.rank) || 0) + 1);
    const best = el("ul", { class: "recommendation-list" });
    const others = el("ul", { class: "recommendation-list" });
    for (const option of data.options) {
      (option.rank === 1 ? best : others).append(recommendationRow(option, ties));
    }
    box.replaceChildren(
      el("h3", {}, data.source),
      el("p", { class: "muted" }, "Ranks by fewest unserved trips, then shortest average car time. Compares one change at a time with the current scenario."),
      best
    );
    if (others.childElementCount) {
      const details = el("details");
      details.append(el("summary", {}, `Other options (${others.childElementCount})`), others);
      box.append(details);
    }
  } catch (err) {
    if (version === recommendationVersion) box.textContent = err.message;
  } finally {
    if (version === recommendationVersion) $("recommend").disabled = false;
  }
}

function resetScenario() {
  cancelMapTool();
  change(() => restore(emptyState()));
}

let confirmedState = null;
async function runSimulation() {
  const myRequest = ++requestCounter;
  $("trip-feedback").textContent = "";
  render(); // show the change right away
  if (!hasTrip()) return;
  try {
    const data = await fetchSimulation(currentScenario());
    if (myRequest !== requestCounter) return; // a newer request has started
    result = data;
    roadResults = Object.fromEntries(["baseline", "scenario"].map(key => [key, new Map(data[key].roads.map(road => [road.id, road]))]));
    confirmedState = snapshot();
    $("recommend").disabled = CONFIG.useMock;
    if ((network.demo || network.defaults) && data.scenario.completedCarTrips === 0) {
      $("trip-feedback").textContent = "No valid car route between these points with the current closures, street directions and access rules.";
    }
    setStatus(statusText());
    render();
    rebuildCars();
  } catch (err) {
    if (myRequest !== requestCounter) return;
    if (confirmedState) restore(confirmedState);
    render();
    setStatus(`That change wasn't applied: ${err.message}`, true);
  }
}

// ---- Status line ----
let networkProblems = [];

function statusText() {
  const source = CONFIG.useMock ? "mock data" : `backend at ${CONFIG.apiBase}`;
  const problems = networkProblems.length ? ` Problems: ${networkProblems.join("; ")}` : "";
  return `Using ${source}. ${network.intersections.length.toLocaleString("en-US")} intersections, ${network.roads.length.toLocaleString("en-US")} roads.${problems}`;
}

function setStatus(text, isError = false) {
  const status = $("status");
  status.textContent = text;
  status.classList.toggle("error", isError);
}

// ---- Start ----
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
async function start() {
  const demand = $("trip-demand");
  $("demand-form").addEventListener("submit", event => {
    event.preventDefault();
    if (demand.valueAsNumber === state.tripDemand) return;
    change(() => { state.tripDemand = demand.valueAsNumber; });
  });
  $("reset").addEventListener("click", resetScenario);
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || (!activeTool && !endpointMode)) return;
    cancelMapTool();
    render();
  });
  $("recommend").addEventListener("click", findBestFix);
  if (CONFIG.useMock) $("recommendations").textContent = "Trip selection and recommendations require the real backend.";
  const animateBox = $("animate-cars");
  if (reducedMotion) animateBox.checked = false;
  animateBox.addEventListener("change", rebuildCars);

  try {
    network = await fetchNetwork();
  } catch (err) {
    setStatus(`Could not load the road network: ${err.message}`, true);
    return;
  }
  state.tripDemand = network.tripDemand?.default ?? 100;
  demand.max = network.tripDemand?.max ?? 1000;
  roadsById = new Map([...network.roads, ...(network.pickRoads || [])].map(road => [road.id, road]));
  for (const { id, parentId } of network.pickRoads || []) {
    if (!roadParts.has(parentId)) roadParts.set(parentId, []);
    roadParts.get(parentId).push(id);
  }
  nodesById = new Map(network.intersections.map(node => [node.id, node]));
  signalIds = new Set(network.signalIntersections || []);
  junctions = mapJunctions();
  junctionIds = new Set(junctions.map(point => point.id));
  const ids = new Set(nodesById.keys());
  networkProblems = [];
  for (const road of network.roads) {
    if (!ids.has(road.from)) networkProblems.push(`${road.id}: unknown from "${road.from}"`);
    if (!ids.has(road.to)) networkProblems.push(`${road.id}: unknown to "${road.to}"`);
  }
  setupEndpointPickers();
  loadCustomRoutes();
  setupBusEditor();
  drawMap();
  setupViews();
  setupLaneMap();
  setupMapTools();
  $("coverage-view").hidden = !network.coverage || !StreetMap.isReady();
  $("coverage-view").onclick = () => { showView("street"); StreetMap.showCoverage(); };
  setStatus(statusText());
  render();
  requestAnimationFrame(animate);
}

// ---- Street map vs. schematic view ----
// The street map is the default. The schematic stays available as a demo fallback, and is used
// automatically if Leaflet or the map tiles can't load (e.g. no internet at the venue).
function showView(view) {
  const street = view === "street" && StreetMap.isReady();
  $("street-view").hidden = !street;
  $("schematic-view").hidden = street;
  $("view-street").setAttribute("aria-pressed", String(street && !is3D));
  $("view-3d").setAttribute("aria-pressed", String(street && is3D));
  $("building-legend").hidden = !(street && is3D);
  $("view-street").disabled = !StreetMap.isReady();
  if (street) StreetMap.refreshSize();
}

function showMapNote(text) {
  const note = $("map-note");
  note.textContent = text;
  note.hidden = !text;
}

async function setMapPerspective(enabled) {
  const request = ++mapViewRequest;
  const button = $("view-3d");
  button.disabled = enabled;
  showMapNote("");
  try {
    if (enabled) await StreetMap.prepare3D();
    if (request !== mapViewRequest) return;
    StreetMap.set3D(enabled);
    is3D = enabled;
  } catch {
    if (request !== mapViewRequest) return;
    StreetMap.set3D(false);
    is3D = false;
    showMapNote("3D could not load. Showing the 2D map.");
  } finally {
    if (request === mapViewRequest) {
      button.disabled = false;
      showView("street");
    }
  }
}

function setupViews() {
  const handlers = {
    onSelectRoad: id => select("road", id),
    onSelectNode: id => select("node", id),
    onSelectEndpoint: id => pickMapPoint(id),
    picking: mapPicking,
    pickingRoad
  };
  const onTilesFailed = reason => {
    if (is3D) {
      setMapPerspective(false);
      showMapNote(`${reason} Showing the 2D road network.`);
      return;
    }
    showMapNote(`${reason} Showing the schematic view. Try 2D again when you're back online.`);
    showView("schematic");
  };
  let ok = false;
  try {
    ok = StreetMap.init(network, junctions, handlers, onTilesFailed);
  } catch (err) {
    console.error(err);
  }
  $("view-street").addEventListener("click", () => setMapPerspective(false));
  $("view-3d").addEventListener("click", () => { if (!is3D) setMapPerspective(true); });

  if (!ok) {
    showMapNote("The street map couldn't load (no internet or Leaflet blocked). Showing the schematic view.");
    showView("schematic");
    return;
  }
  const missing = StreetMap.missing();
  if (missing.length) showMapNote(`No street geometry yet for: ${missing.join(", ")}. Those roads appear only in the schematic view.`);
  $("view-3d").disabled = false;
  showView("street");
}

start();
