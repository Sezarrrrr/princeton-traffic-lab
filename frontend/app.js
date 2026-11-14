// Princeton Traffic Lab frontend.
// Draws whatever network GET /api/network returns (no street names or IDs are hard-coded),
// lets the user close/reopen roads, and shows the POST /api/simulate results.

const SVG_NS = "http://www.w3.org/2000/svg";
const VIEW = { width: 820, height: 620, padding: 70 };

// ---- App state ----
let network = null;        // from GET /api/network
let result = null;         // latest { baseline, scenario } from POST /api/simulate
let selectedRoadId = null;
const closedRoadIds = new Set();
let requestCounter = 0;    // ignore old responses if the user clicks quickly

// The full scenario we send to the backend. Only closures are editable for now;
// the other fields are sent with their "reset" values, as the API contract asks.
function currentScenario() {
  return {
    closedRoadIds: [...closedRoadIds],
    extraLanesByRoadId: {},
    signals: [],
    busShiftPercent: 0
  };
}

// ---- Small helpers ----
const $ = id => document.getElementById(id);

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function formatMinutes(value) {
  return value === null || value === undefined ? "No completed trips." : `${value.toFixed(1)} min`;
}

function roadName(id) {
  const road = network.roads.find(r => r.id === id);
  return road ? road.name : id;
}

function roadResult(which, id) {
  if (!result) return null;
  return result[which].roads.find(r => r.id === id) || null;
}

// Color by congestion ratio (car trips / capacity), as calculated by the backend.
function roadColorClass(road) {
  if (!road || road.closed) return "closed";
  if (road.carTrips === 0) return "empty";
  if (road.congestionRatio < 0.8) return "free";
  if (road.congestionRatio <= 1.0) return "busy";
  return "jam";
}

// Fit any set of x/y coordinates into the SVG, so the backend can use any scale.
function makeProjector(intersections) {
  const xs = intersections.map(i => i.x);
  const ys = intersections.map(i => i.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1), spanY = Math.max(maxY - minY, 1);
  const scale = Math.min(
    (VIEW.width - 2 * VIEW.padding) / spanX,
    (VIEW.height - 2 * VIEW.padding) / spanY
  );
  const offsetX = (VIEW.width - spanX * scale) / 2;
  const offsetY = (VIEW.height - spanY * scale) / 2;
  return p => ({ x: offsetX + (p.x - minX) * scale, y: offsetY + (p.y - minY) * scale });
}

// ---- Drawing the map (once, from the network data) ----
function drawMap() {
  const svg = $("map");
  svg.setAttribute("viewBox", `0 0 ${VIEW.width} ${VIEW.height}`);
  svg.innerHTML = "";

  const byId = {};
  for (const inter of network.intersections) byId[inter.id] = inter;
  const project = makeProjector(network.intersections);

  const roadLayer = svgEl("g");
  const nodeLayer = svgEl("g");
  svg.append(roadLayer, nodeLayer);

  for (const road of network.roads) {
    const a = byId[road.from], b = byId[road.to];
    if (!a || !b) continue; // reported in the status line
    const p1 = project(a), p2 = project(b);
    const line = { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };

    const g = svgEl("g", {
      class: "road",
      "data-road-id": road.id,
      tabindex: "0",
      role: "button",
      "aria-label": road.name
    });
    const title = svgEl("title");
    title.textContent = road.name;

    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    const xMark = svgEl("path", {
      class: "x-mark",
      d: `M${mx - 9},${my - 9} L${mx + 9},${my + 9} M${mx + 9},${my - 9} L${mx - 9},${my + 9}`,
      visibility: "hidden"
    });
    const badge = svgEl("text", { class: "trip-badge", x: mx, y: my - 14, "text-anchor": "middle" });

    g.append(
      title,
      svgEl("line", { ...line, class: "halo", "stroke-width": 20 }),
      svgEl("line", { ...line, class: "line", "stroke-width": 9 }),
      svgEl("line", { ...line, class: "hit" }),
      xMark,
      badge
    );
    g.addEventListener("click", () => selectRoad(road.id));
    g.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectRoad(road.id); }
    });
    roadLayer.append(g);
  }

  const signals = new Set(network.signalIntersections || []);
  for (const inter of network.intersections) {
    const p = project(inter);
    const g = svgEl("g", { class: signals.has(inter.id) ? "node signal" : "node" });
    const title = svgEl("title");
    title.textContent = inter.name + (signals.has(inter.id) ? " (signal)" : "");
    // Put labels on the left for nodes near the right edge so they aren't cut off.
    const onRight = p.x > VIEW.width * 0.75;
    const label = svgEl("text", {
      x: onRight ? p.x - 12 : p.x + 12,
      y: onRight ? p.y - 12 : p.y + 4,
      "text-anchor": onRight ? "end" : "start"
    });
    label.textContent = inter.name;
    g.append(title, svgEl("circle", { cx: p.x, cy: p.y, r: 7 }), label);
    nodeLayer.append(g);
  }
}

// ---- Updating the map and panel from the latest results ----
function render() {
  const colors = { free: "var(--free)", busy: "var(--busy)", jam: "var(--jam)", closed: "var(--closed)", empty: "var(--empty)" };

  for (const g of document.querySelectorAll(".road")) {
    const id = g.dataset.roadId;
    const after = roadResult("scenario", id);
    const before = roadResult("baseline", id);
    const isClosed = closedRoadIds.has(id);

    g.classList.toggle("closed", isClosed);
    g.classList.toggle("selected", id === selectedRoadId);
    g.querySelector(".line").setAttribute("stroke", colors[roadColorClass(after)] || colors.empty);
    g.querySelector(".x-mark").setAttribute("visibility", isClosed ? "visible" : "hidden");

    const badge = g.querySelector(".trip-badge");
    if (after && before && !after.closed && after.carTrips > 0) {
      const diff = after.carTrips - before.carTrips;
      badge.textContent = `${after.carTrips}` + (diff ? ` (${diff > 0 ? "+" : ""}${diff})` : "");
    } else {
      badge.textContent = "";
    }
  }

  renderComparison();
  renderSelected();
  renderShifts();
}

function setCompareCell(id, text, change) {
  const cell = $(id);
  cell.textContent = text;
  cell.classList.toggle("worse", change > 0);
  cell.classList.toggle("better", change < 0);
}

function renderComparison() {
  if (!result) return;
  const b = result.baseline, s = result.scenario;
  $("avg-before").textContent = formatMinutes(b.avgCarTravelMinutes);
  const avgChange = (b.avgCarTravelMinutes !== null && s.avgCarTravelMinutes !== null)
    ? s.avgCarTravelMinutes - b.avgCarTravelMinutes : 0;
  setCompareCell("avg-after", formatMinutes(s.avgCarTravelMinutes), avgChange);

  $("unserved-before").textContent = b.unservedCarTrips;
  setCompareCell("unserved-after", s.unservedCarTrips, s.unservedCarTrips - b.unservedCarTrips);

  $("bus-before").textContent = b.carTripsShiftedToBus;
  $("bus-after").textContent = s.carTripsShiftedToBus;

  $("closed-list").textContent = closedRoadIds.size
    ? `Closed: ${[...closedRoadIds].map(roadName).join(", ")}`
    : "No roads closed.";
}

function renderSelected() {
  const box = $("selected");
  if (!selectedRoadId) {
    box.innerHTML = `<h2>Selected road</h2><p class="muted">Click a road on the map.</p>`;
    return;
  }
  const isClosed = closedRoadIds.has(selectedRoadId);
  const before = roadResult("baseline", selectedRoadId);
  const after = roadResult("scenario", selectedRoadId);
  const trips = r => (r ? r.carTrips : "–");
  const mins = r => (r && r.travelMinutes !== null ? `${r.travelMinutes.toFixed(1)} min` : "–");

  box.innerHTML = `
    <h2></h2>
    <p class="selected-meta muted">ID <code></code> · ${isClosed ? "Closed" : "Open"}</p>
    <table class="compare">
      <thead><tr><th></th><th>Original</th><th>Modified</th></tr></thead>
      <tbody>
        <tr><th scope="row">Car trips</th><td>${trips(before)}</td><td>${trips(after)}</td></tr>
        <tr><th scope="row">Travel time</th><td>${mins(before)}</td><td>${mins(after)}</td></tr>
      </tbody>
    </table>
    <p></p>
    <button id="toggle-road" type="button" class="primary">${isClosed ? "Reopen road" : "Close road"}</button>
  `;
  // Names come from data, so set them as text (not HTML).
  box.querySelector("h2").textContent = roadName(selectedRoadId);
  box.querySelector("code").textContent = selectedRoadId;
  $("toggle-road").addEventListener("click", () => toggleRoad(selectedRoadId));
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
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No change from the original scenario.";
    list.append(li);
    return;
  }
  for (const { road, before, after } of changed) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = road.name + (after.closed ? " (closed)" : "");
    const nums = document.createElement("span");
    nums.className = "nums " + (after.carTrips > before.carTrips ? "worse" : "better");
    nums.textContent = `${before.carTrips} → ${after.carTrips}`;
    li.append(name, nums);
    list.append(li);
  }
}

// ---- User actions ----
function selectRoad(id) {
  selectedRoadId = id;
  render();
}

function toggleRoad(id) {
  if (closedRoadIds.has(id)) closedRoadIds.delete(id);
  else closedRoadIds.add(id);
  runSimulation();
}

function resetScenario() {
  closedRoadIds.clear();
  selectedRoadId = null;
  runSimulation();
}

async function runSimulation() {
  const myRequest = ++requestCounter;
  render(); // show the closed styling right away
  try {
    const data = await fetchSimulation(currentScenario());
    if (myRequest !== requestCounter) return; // a newer request has started
    result = data;
    setStatus(statusText());
    render();
  } catch (err) {
    if (myRequest !== requestCounter) return;
    setStatus(`Simulation error: ${err.message}`, true);
  }
}

// ---- Status line ----
let networkProblems = [];

function statusText() {
  const source = CONFIG.useMock ? "mock data" : `backend at ${CONFIG.apiBase}`;
  const bus = network.busRoute
    ? `Bus route: ${network.busRoute.name} (${network.busRoute.roadIds.length} roads).`
    : "No bus route yet.";
  const problems = networkProblems.length ? ` Problems: ${networkProblems.join("; ")}` : "";
  return `Using ${source}. ${network.intersections.length} intersections, ${network.roads.length} roads. ${bus}${problems}`;
}

function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

// ---- Start ----
async function start() {
  $("reset").addEventListener("click", resetScenario);
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
  runSimulation();
}

start();
