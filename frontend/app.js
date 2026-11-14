// Princeton Traffic Lab frontend.
// Draws whatever network GET /api/network returns (no street names or IDs are hard-coded,
// except the optional demo preset), lets the user combine changes (road closures, extra lanes,
// signals, bus shift), and shows the POST /api/simulate results.

const SVG_NS = "http://www.w3.org/2000/svg";
const VIEW = { width: 820, height: 620, padding: 70 };
const MAX_EXTRA_LANES = 3;
const DEFAULT_GREEN_SHARE = 0.5;
const DEFAULT_BUS_PERCENT = 20;

// ---- App state ----
let network = null;         // from GET /api/network
let result = null;          // latest { baseline, scenario } from POST /api/simulate
let selected = null;        // { type: "road" | "node", id }
let requestCounter = 0;     // ignore old responses if the user clicks quickly
const geometry = {};        // road id -> { p1, p2 } in SVG coordinates
const nodePoints = {};      // intersection id -> { x, y } in SVG coordinates

// Everything the user has changed. Reset puts it back to this "empty" state.
const state = {
  closed: new Set(),        // road ids
  lanes: {},                // road id -> extra lanes (1..MAX_EXTRA_LANES)
  signals: new Map(),       // intersection id -> mainGreenShare (0..1)
  busEnabled: false,
  busPercent: DEFAULT_BUS_PERCENT
};

// The full scenario we send to the backend (shared API contract).
function currentScenario() {
  return {
    closedRoadIds: [...state.closed],
    extraLanesByRoadId: { ...state.lanes },
    signals: [...state.signals].map(([intersectionId, mainGreenShare]) => ({ intersectionId, mainGreenShare })),
    busShiftPercent: state.busEnabled && network.busRoute ? state.busPercent : 0
  };
}

function snapshot() {
  return {
    closed: new Set(state.closed),
    lanes: { ...state.lanes },
    signals: new Map(state.signals),
    busEnabled: state.busEnabled,
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
const percent = share => `${Math.round(share * 100)}%`;
const roadById = id => network.roads.find(r => r.id === id);
const nodeById = id => network.intersections.find(i => i.id === id);
const roadName = id => (roadById(id) || { name: id }).name;
const nodeName = id => (nodeById(id) || { name: id }).name;
const canSignal = id => (network.signalIntersections || []).includes(id);

function roadResult(which, id) {
  if (!result) return null;
  return result[which].roads.find(r => r.id === id) || null;
}

// Color by congestion ratio (car trips / capacity), as calculated by the backend.
function roadColorKey(road) {
  if (!road || road.closed) return "closed";
  if (road.carTrips === 0) return "empty";
  if (road.congestionRatio < 0.8) return "free";
  if (road.congestionRatio <= 1.0) return "busy";
  return "jam";
}
const roadColor = road => `var(--${roadColorKey(road)})`;

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
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onActivate(); }
  });
}

// ---- Drawing the map (once, from the network data) ----
function drawMap() {
  const svg = $("map");
  svg.setAttribute("viewBox", `0 0 ${VIEW.width} ${VIEW.height}`);
  svg.innerHTML = "";

  const byId = Object.fromEntries(network.intersections.map(i => [i.id, i]));
  const project = makeProjector(network.intersections);
  for (const inter of network.intersections) nodePoints[inter.id] = project(inter);

  const roadLayer = svgEl("g");
  const busLayer = svgEl("g", { id: "bus-layer" });
  const carLayer = svgEl("g", { id: "car-layer" });
  const labelLayer = svgEl("g");
  const nodeLayer = svgEl("g");
  svg.append(roadLayer, busLayer, carLayer, labelLayer, nodeLayer);

  for (const road of network.roads) {
    if (!byId[road.from] || !byId[road.to]) continue; // reported in the status line
    const p1 = nodePoints[road.from], p2 = nodePoints[road.to];
    geometry[road.id] = { p1, p2 };
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
    makeClickable(g, road.name, () => select("road", road.id));
    roadLayer.append(g);

    const label = svgEl("text", { class: "trip-badge", "data-road-id": road.id, x: mx, y: my - 16, "text-anchor": "middle" });
    labelLayer.append(label);
  }

  if (network.busRoute) {
    for (const id of network.busRoute.roadIds) {
      const geo = geometry[id];
      if (!geo) continue;
      busLayer.append(svgEl("line", { class: "bus-line", x1: geo.p1.x, y1: geo.p1.y, x2: geo.p2.x, y2: geo.p2.y }));
    }
  }

  for (const inter of network.intersections) {
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
}

// ---- Updating the map from the latest results ----
function renderMap() {
  for (const g of document.querySelectorAll(".road")) {
    const id = g.dataset.roadId;
    const after = roadResult("scenario", id);
    const isClosed = state.closed.has(id);
    const lanes = state.lanes[id] || 0;
    const width = 9 + lanes * 5;
    g.classList.toggle("closed", isClosed);
    g.classList.toggle("selected", selected && selected.type === "road" && selected.id === id);
    const line = g.querySelector(".line");
    line.setAttribute("stroke", roadColor(after));
    line.setAttribute("stroke-width", width);
    g.querySelector(".halo").setAttribute("stroke-width", width + 12);
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

  $("bus-layer").classList.toggle("active", state.busEnabled);
}

// ---- Panel: selected road or intersection ----
function renderSelected() {
  const box = $("selected");
  if (isDragging(box)) return;
  box.innerHTML = "";
  if (!selected) {
    box.append(el("h2", {}, "Selected"), el("p", { class: "muted" }, "Click a road or intersection on the map."));
    return;
  }
  if (selected.type === "road") renderSelectedRoad(box, selected.id);
  else renderSelectedNode(box, selected.id);
}

function renderSelectedRoad(box, id) {
  const isClosed = state.closed.has(id);
  const lanes = state.lanes[id] || 0;
  const before = roadResult("baseline", id), after = roadResult("scenario", id);
  const trips = r => (r ? String(r.carTrips) : "–");
  const mins = r => (r && r.travelMinutes !== null ? `${r.travelMinutes.toFixed(1)} min` : "–");
  const ratio = r => (r && r.congestionRatio !== null ? r.congestionRatio.toFixed(2) : "–");

  box.append(el("h2", {}, roadName(id)));
  const meta = el("p", { class: "selected-meta muted" }, "ID ");
  meta.append(el("code", {}, id), ` · ${isClosed ? "Closed" : "Open"}`);
  box.append(meta);

  const table = el("table", { class: "compare" });
  table.innerHTML = `<thead><tr><th></th><th>Original</th><th>Modified</th></tr></thead>`;
  const body = el("tbody");
  for (const [label, fn] of [["Car trips", trips], ["Travel time", mins], ["Volume / capacity", ratio]]) {
    const tr = el("tr");
    tr.append(el("th", { scope: "row" }, label), el("td", {}, fn(before)), el("td", {}, fn(after)));
    body.append(tr);
  }
  table.append(body);
  box.append(table);

  const actions = el("div", { class: "actions" });
  const toggle = el("button", { type: "button", class: "primary" }, isClosed ? "Reopen road" : "Close road");
  toggle.addEventListener("click", () => change(() => {
    if (state.closed.has(id)) state.closed.delete(id); else state.closed.add(id);
  }));
  actions.append(toggle);
  box.append(actions);

  const laneRow = el("div", { class: "stepper" });
  const minus = el("button", { type: "button", "aria-label": "Remove a lane" }, "−");
  const plus = el("button", { type: "button", "aria-label": "Add a lane" }, "+");
  minus.disabled = isClosed || lanes === 0;
  plus.disabled = isClosed || lanes >= MAX_EXTRA_LANES;
  const setLanes = n => change(() => { if (n > 0) state.lanes[id] = n; else delete state.lanes[id]; });
  minus.addEventListener("click", () => setLanes(lanes - 1));
  plus.addEventListener("click", () => setLanes(lanes + 1));
  laneRow.append(el("span", {}, "Extra lanes"), minus, el("strong", { class: "count" }, String(lanes)), plus);
  box.append(laneRow);
  if (isClosed) box.append(el("p", { class: "small muted" }, "Reopen the road to add lanes."));
}

function renderSelectedNode(box, id) {
  box.append(el("h2", {}, nodeName(id)));
  const meta = el("p", { class: "selected-meta muted" }, "ID ");
  meta.append(el("code", {}, id), " · Intersection");
  box.append(meta);

  if (!canSignal(id)) {
    box.append(el("p", { class: "muted" }, "The simulation doesn't support a signal at this intersection. Orange-ringed intersections do."));
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

  if (hasSignal) {
    const share = state.signals.get(id);
    const wrap = el("div", { class: "slider" });
    const label = el("label", { for: "green-share" }, "Main road green time ");
    const value = el("strong", {}, percent(share));
    label.append(value);
    const input = el("input", { type: "range", id: "green-share", min: "0.2", max: "0.8", step: "0.05", value: String(share) });
    input.addEventListener("input", () => {
      value.textContent = percent(Number(input.value));
      debouncedChange(() => state.signals.set(id, Number(input.value)));
    });
    wrap.append(label, input, el("p", { class: "small muted" }, "More green for the main road means a longer wait for the cross street."));
    box.append(wrap);
  }
}

// ---- Panel: bus route ----
function renderBus() {
  const box = $("bus-controls");
  if (isDragging(box)) return;
  box.innerHTML = "";
  if (!network.busRoute) {
    box.append(el("p", { class: "muted" }, "No bus route available yet."));
    return;
  }
  const route = network.busRoute;
  const check = el("label", { class: "check" });
  const input = el("input", { type: "checkbox", id: "bus-enabled" });
  input.checked = state.busEnabled;
  input.addEventListener("change", () => change(() => { state.busEnabled = input.checked; }));
  check.append(input, ` Run ${route.name}`);
  box.append(check);

  const wrap = el("div", { class: "slider" });
  const label = el("label", { for: "bus-percent" }, "Car trips switching to bus ");
  const value = el("strong", {}, `${state.busPercent}%`);
  label.append(value);
  const slider = el("input", { type: "range", id: "bus-percent", min: "0", max: "50", step: "5", value: String(state.busPercent) });
  slider.disabled = !state.busEnabled;
  slider.addEventListener("input", () => {
    value.textContent = `${slider.value}%`;
    debouncedChange(() => { state.busPercent = Number(slider.value); });
  });
  wrap.append(label, slider);
  box.append(wrap);

  const closedOnRoute = route.roadIds.filter(id => state.closed.has(id));
  box.append(el("p", { class: "small muted" },
    closedOnRoute.length && state.busEnabled
      ? `Note: the bus route uses ${closedOnRoute.map(roadName).join(", ")}, which is closed.`
      : `Route: ${route.roadIds.map(roadName).join(" → ")}`));
}

// ---- Panel: list of changes ----
function renderChanges() {
  const list = $("changes");
  list.innerHTML = "";
  const items = [];
  for (const id of state.closed) items.push([`Closed ${roadName(id)}`, () => state.closed.delete(id)]);
  for (const [id, n] of Object.entries(state.lanes)) items.push([`+${n} lane${n > 1 ? "s" : ""} on ${roadName(id)}`, () => delete state.lanes[id]]);
  for (const [id, share] of state.signals) items.push([`Signal at ${nodeName(id)} (main road green ${percent(share)})`, () => state.signals.delete(id)]);
  if (state.busEnabled && network.busRoute) items.push([`Bus: ${state.busPercent}% of car trips switch`, () => { state.busEnabled = false; }]);

  if (!items.length) {
    list.append(el("li", { class: "muted" }, "No changes. This is the original scenario."));
    return;
  }
  for (const [text, undo] of items) {
    const li = el("li");
    const remove = el("button", { type: "button", class: "link", "aria-label": `Undo: ${text}` }, "Undo");
    remove.addEventListener("click", () => change(undo));
    li.append(el("span", {}, text), remove);
    list.append(li);
  }
}

// ---- Panel: original vs. modified ----
function renderComparison() {
  const body = $("compare-body");
  body.innerHTML = "";
  if (!result) return;
  const b = result.baseline, s = result.scenario;

  // [label, before, after, how to format, is "up" bad?]
  const rows = [["Avg. car trip", b.avgCarTravelMinutes, s.avgCarTravelMinutes, formatMinutes, true]];
  if ("completedCarTrips" in s) rows.push(["Completed car trips", b.completedCarTrips, s.completedCarTrips, String, false]);
  rows.push(["Unserved car trips", b.unservedCarTrips, s.unservedCarTrips, String, true]);
  rows.push(["Shifted to bus", b.carTripsShiftedToBus, s.carTripsShiftedToBus, String, null]);
  if ("totalCarTrips" in s) rows.push(["Total trips", b.totalCarTrips, s.totalCarTrips, String, null]);

  for (const [label, before, after, fmt, upIsBad] of rows) {
    const tr = el("tr");
    const afterCell = el("td", {}, fmt(after));
    if (upIsBad !== null && before !== null && after !== null && before !== after) {
      const worse = (after > before) === upIsBad;
      afterCell.classList.add(worse ? "worse" : "better");
    }
    tr.append(el("th", { scope: "row" }, label), el("td", {}, fmt(before)), afterCell);
    body.append(tr);
  }

  // Trip conservation check (only if the backend sends the totals).
  const check = $("conservation");
  if ("totalCarTrips" in s && "completedCarTrips" in s) {
    const ok = r => r.completedCarTrips + r.unservedCarTrips + r.carTripsShiftedToBus === r.totalCarTrips;
    check.textContent = ok(b) && ok(s)
      ? `✓ Every trip is accounted for: ${s.completedCarTrips} completed + ${s.unservedCarTrips} unserved + ${s.carTripsShiftedToBus} by bus = ${s.totalCarTrips}.`
      : "⚠ Trip totals don't add up. Check the backend response.";
    check.classList.toggle("worse", !(ok(b) && ok(s)));
  } else {
    check.textContent = "";
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

function renderPreset() {
  // Demo shortcut from demo/demo-script.md. Only shown if the network has that road.
  const area = $("preset-area");
  area.innerHTML = "";
  const presetRoad = "wash_mid";
  if (!roadById(presetRoad)) return;
  const btn = el("button", { type: "button" }, "Demo: HackPrinceton Let-Out");
  btn.title = `Start from the original scenario and close ${roadName(presetRoad)}`;
  btn.addEventListener("click", () => {
    selected = { type: "road", id: presetRoad };
    change(() => {
      restore(emptyState());
      state.closed.add(presetRoad);
    });
  });
  area.append(btn);
}

// Don't rebuild a panel while the user is dragging one of its sliders.
const isDragging = box => box.contains(document.activeElement) && document.activeElement.type === "range";

function render() {
  renderMap();
  StreetMap.render({ state, selected, roadResult, colorKey: roadColorKey });
  renderSelected();
  renderBus();
  renderChanges();
  renderComparison();
  renderShifts();
}

// ---- Animated cars (decoration: count follows car trips, speed follows travel time) ----
let cars = [];
let lastFrame = null;

function rebuildCars() {
  StreetMap.rebuildCars(result, $("animate-cars").checked);
  const layer = $("car-layer");
  layer.innerHTML = "";
  cars = [];
  if (!result || !$("animate-cars").checked) return;
  for (const road of result.scenario.roads) {
    const geo = geometry[road.id];
    if (!geo || road.closed || !road.carTrips || !road.travelMinutes) continue;
    const count = Math.max(1, Math.min(12, Math.round(road.carTrips / 20)));
    const speed = 0.9 / road.travelMinutes; // fraction of the road per second
    for (let i = 0; i < count; i++) {
      const dot = svgEl("circle", { class: "car", r: 4 });
      layer.append(dot);
      cars.push({ geo, pos: i / count, speed, dot });
    }
  }
}

function animate(time) {
  const dt = lastFrame === null ? 0 : Math.min((time - lastFrame) / 1000, 0.1);
  lastFrame = time;
  for (const car of cars) {
    car.pos = (car.pos + car.speed * dt) % 1;
    const { p1, p2 } = car.geo;
    car.dot.setAttribute("cx", p1.x + (p2.x - p1.x) * car.pos);
    car.dot.setAttribute("cy", p1.y + (p2.y - p1.y) * car.pos);
  }
  requestAnimationFrame(animate);
}

// ---- User actions ----
function select(type, id) {
  selected = { type, id };
  render();
}

function emptyState() {
  return { closed: new Set(), lanes: {}, signals: new Map(), busEnabled: false, busPercent: DEFAULT_BUS_PERCENT };
}

// Apply a change to the state, then re-run the simulation.
// If the backend rejects it (e.g. a feature it doesn't support yet), undo the change.
function change(mutate) {
  const before = snapshot();
  mutate();
  runSimulation(before);
}

let debounceTimer = null;
function debouncedChange(mutate) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => change(mutate), 120);
}

function resetScenario() {
  selected = null;
  change(() => restore(emptyState()));
}

async function runSimulation(previousState) {
  const myRequest = ++requestCounter;
  render(); // show the change right away
  try {
    const data = await fetchSimulation(currentScenario());
    if (myRequest !== requestCounter) return; // a newer request has started
    result = data;
    setStatus(statusText());
    render();
    rebuildCars();
  } catch (err) {
    if (myRequest !== requestCounter) return;
    if (previousState) restore(previousState);
    render();
    setStatus(`That change wasn't applied: ${err.message}`, true);
  }
}

// ---- Status line ----
let networkProblems = [];

function statusText() {
  const source = CONFIG.useMock ? "mock data" : `backend at ${CONFIG.apiBase}`;
  const problems = networkProblems.length ? ` Problems: ${networkProblems.join("; ")}` : "";
  return `Using ${source}. ${network.intersections.length} intersections, ${network.roads.length} roads.${problems}`;
}

function setStatus(text, isError = false) {
  const status = $("status");
  status.textContent = text;
  status.classList.toggle("error", isError);
}

// ---- Start ----
async function start() {
  $("reset").addEventListener("click", resetScenario);
  const animateBox = $("animate-cars");
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) animateBox.checked = false;
  animateBox.addEventListener("change", rebuildCars);

  try {
    network = await fetchNetwork();
  } catch (err) {
    setStatus(`Could not load the road network: ${err.message}`, true);
    return;
  }
  const ids = new Set(network.intersections.map(i => i.id));
  networkProblems = [];
  for (const road of network.roads) {
    if (!ids.has(road.from)) networkProblems.push(`${road.id}: unknown from "${road.from}"`);
    if (!ids.has(road.to)) networkProblems.push(`${road.id}: unknown to "${road.to}"`);
  }
  drawMap();
  setupViews();
  renderPreset();
  runSimulation(null);
  requestAnimationFrame(animate);
}

// ---- Street map vs. schematic view ----
// The street map is the default. The schematic stays available as a demo fallback, and is used
// automatically if Leaflet or the map tiles can't load (e.g. no internet at the venue).
function showView(view) {
  const street = view === "street" && StreetMap.isReady();
  $("street-view").hidden = !street;
  $("schematic-view").hidden = street;
  $("view-street").setAttribute("aria-pressed", String(street));
  $("view-schematic").setAttribute("aria-pressed", String(!street));
  $("view-street").disabled = !StreetMap.isReady();
  if (street) StreetMap.refreshSize();
}

function showMapNote(text) {
  const note = $("map-note");
  note.textContent = text;
  note.hidden = !text;
}

function setupViews() {
  const handlers = { onSelectRoad: id => select("road", id), onSelectNode: id => select("node", id) };
  const onTilesFailed = reason => {
    showMapNote(`${reason} Showing the schematic view. Try "Street map" again when you're back online.`);
    showView("schematic");
  };
  let ok = false;
  try {
    ok = StreetMap.init(network, handlers, onTilesFailed);
  } catch (err) {
    console.error(err);
  }
  $("view-street").addEventListener("click", () => { showMapNote(""); showView("street"); });
  $("view-schematic").addEventListener("click", () => showView("schematic"));

  if (!ok) {
    showMapNote("The street map couldn't load (no internet or Leaflet blocked). Showing the schematic view.");
    showView("schematic");
    return;
  }
  const missing = StreetMap.missing();
  if (missing.length) showMapNote(`No street geometry yet for: ${missing.join(", ")}. Those roads appear only in the schematic view.`);
  const wanted = new URLSearchParams(location.search).get("view");
  showView(wanted === "schematic" ? "schematic" : "street");
}

start();
