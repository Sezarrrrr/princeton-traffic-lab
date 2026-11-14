// Panels for the in-browser simulator ("lab" mode, the default without ?api=real):
// custom trips between two points, places/pins, intersection controls (signals with timing,
// stop signs, roundabouts), road speed / direction / car access, and the model assumptions.
// Uses the shared helpers and state from app.js (loaded after this file; all calls happen at runtime).

const CONTROL_NAMES = {
  none: "No control",
  stop_minor: "Two-way stop",
  stop_all: "All-way stop",
  signal: "Traffic signal",
  roundabout: "Roundabout"
};
const DEFAULT_TRIP_CARS = 50;

const isLab = () => !!(network && network.capabilities && network.capabilities.lab);
let userPlaces = [];            // places the user pinned on the map (kept across Reset)
let pinCounter = 0, tripCounter = 0;
let picking = null;             // null | "from" | "to"
const tripDraft = { from: "", to: "", cars: DEFAULT_TRIP_CARS, name: "", onlyModified: false };

// ---- Small builders ----
function slider({ id, label, min, max, step, value, format, onInput, hint }) {
  const wrap = el("div", { class: "slider" });
  const lab = el("label", { for: id }, `${label} `);
  const out = el("strong", {}, format(value));
  lab.append(out);
  const input = el("input", { type: "range", id, min: String(min), max: String(max), step: String(step), value: String(value) });
  input.addEventListener("input", () => {
    const v = Number(input.value);
    out.textContent = format(v);
    onInput(v);
  });
  wrap.append(lab, input);
  if (hint) wrap.append(el("p", { class: "small muted" }, hint));
  return wrap;
}

function selectBox(id, label, options, value, onChange) {
  const wrap = el("label", { class: "field", for: id });
  wrap.append(el("span", {}, label));
  const sel = el("select", { id });
  for (const [v, text] of options) {
    const o = el("option", { value: String(v) }, text);
    if (String(v) === String(value)) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener("change", () => onChange(sel.value));
  wrap.append(sel);
  return wrap;
}

const fmtMin = v => (v === null || v === undefined ? "–" : `${v.toFixed(1)} min`);
const fmtSec = v => (v === null || v === undefined ? "–" : `${Math.round(v)} s`);
const shortStreet = s => s.replace(/ Street$/, " St").replace(/ Road$/, " Rd").replace(/ Avenue$/, " Ave").replace(/ Place$/, " Pl").replace(/ Drive$/, " Dr");

// ---- Scenario fields only the in-browser simulator understands ----
function labScenarioFields() {
  return {
    roadSettings: structuredClone(state.roadSettings),
    intersectionControls: structuredClone(state.controls),
    settings: { ...state.settings },
    trips: state.trips.map(t => ({ id: t.id, name: t.name, fromNodeId: t.fromNodeId, toNodeId: t.toNodeId, cars: t.cars, onlyModified: t.onlyModified }))
  };
}

const settingsNow = () => ({ ...network.settingsDefaults, ...state.settings });
const controlNow = id => LocalSim.effectiveControl(id, state.controls);
const controlDefault = id => LocalSim.effectiveControl(id, {});

function controlLabel(ctl) {
  if (ctl.type === "signal") return `Signal (${ctl.cycle} s cycle, ${shortStreet(ctl.major || "main")} green ${percent(ctl.greenShare)}${ctl.ped ? `, ${ctl.ped} s walk phase` : ""})`;
  if (ctl.type === "stop_minor") return `Two-way stop (${shortStreet(ctl.major || "main street")} doesn't stop)`;
  return CONTROL_NAMES[ctl.type];
}

// Store an override only when it differs from the default.
function setControl(id, patch) {
  const next = { ...controlNow(id), ...patch };
  if (JSON.stringify(LocalSim.effectiveControl(id, { [id]: next })) === JSON.stringify(controlDefault(id))) delete state.controls[id];
  else state.controls[id] = next;
}

function roadSetting(id, key) {
  const rs = state.roadSettings[id] || {};
  return rs[key] !== undefined ? rs[key] : roadById(id)[key];
}
function setRoadSetting(id, key, value) {
  const rs = { ...(state.roadSettings[id] || {}) };
  if (value === roadById(id)[key]) delete rs[key]; else rs[key] = value;
  if (Object.keys(rs).length) state.roadSettings[id] = rs; else delete state.roadSettings[id];
}

// ---- "Your changes" entries for the lab-only changes ----
function labChangeItems() {
  const items = [];
  for (const [id, rs] of Object.entries(state.roadSettings)) {
    const road = roadById(id);
    if (rs.speedMph !== undefined) items.push([`${rs.speedMph} mph on ${road.name} (was ${road.speedMph})`, () => setRoadSetting(id, "speedMph", road.speedMph)]);
    if (rs.oneway !== undefined) items.push([`${directionText(road, rs.oneway)} on ${road.name}`, () => setRoadSetting(id, "oneway", road.oneway)]);
    if (rs.carAccess !== undefined) items.push([`${rs.carAccess ? "Cars allowed" : "No cars"} on ${road.name}`, () => setRoadSetting(id, "carAccess", road.carAccess)]);
  }
  for (const id of Object.keys(state.controls)) {
    items.push([`${controlLabel(controlNow(id))} at ${nodeName(id)} (was ${CONTROL_NAMES[controlDefault(id).type].toLowerCase()})`, () => delete state.controls[id]]);
  }
  return items;
}

function directionText(road, oneway) {
  if (oneway === 0) return "Two-way";
  const [a, b] = oneway === 1 ? [road.from, road.to] : [road.to, road.from];
  return `One-way toward ${nodeName(b)}`;
}

// ---- Selected road: speed, direction, car access ----
function renderLabRoadControls(box, id) {
  const road = roadById(id);
  const closed = state.closed.has(id);
  const before = roadResult("baseline", id), after = roadResult("scenario", id);

  // Per-direction numbers
  const dirs = el("ul", { class: "shifts dir-list" });
  for (const [key, toward] of [["forward", road.to], ["backward", road.from]]) {
    const b = before && before[key], a = after && after[key];
    if (!b && !a) continue;
    const li = el("li");
    li.append(el("span", {}, `Toward ${nodeName(toward)}`),
      el("span", { class: "nums" }, `${b ? b.cars : 0} → ${a ? a.cars : 0} cars · ${fmtMin(a ? a.minutes : null)}`));
    dirs.append(li);
  }
  if (dirs.children.length) {
    box.append(el("p", { class: "small muted dir-head" }, "By direction (original → modified cars, modified time incl. intersection wait):"), dirs);
  }

  const group = el("div", { class: "lab-group" });
  if (!road.carAccess || roadSetting(id, "carAccess") !== road.carAccess) {
    const access = roadSetting(id, "carAccess");
    const btn = el("button", { type: "button" }, access ? "Close to cars again" : "Allow cars on this road");
    btn.addEventListener("click", () => change(() => setRoadSetting(id, "carAccess", !access)));
    group.append(el("p", { class: "small muted" }, road.carAccess ? "" : "This road has no car access in the original scenario (simulation assumption)."), btn);
  }

  const oneway = roadSetting(id, "oneway");
  group.append(selectBox(`dir-${id}`, "Direction", [
    [0, "Two-way"],
    [1, `One-way toward ${nodeName(road.to)}`],
    [-1, `One-way toward ${nodeName(road.from)}`]
  ], oneway, v => change(() => setRoadSetting(id, "oneway", Number(v)))));

  const mph = roadSetting(id, "speedMph");
  group.append(slider({
    id: `speed-${id}`, label: "Speed limit", min: 10, max: 45, step: 5, value: mph,
    format: v => `${v} mph`, onInput: v => debouncedChange(() => setRoadSetting(id, "speedMph", v)),
    hint: `Original ${road.speedMph} mph (${road.lengthM} m long, ${road.lanes} lane${road.lanes > 1 ? "s" : ""} each way${road.oneway ? ", one-way" : ""}).`
  }));
  if (closed) group.append(el("p", { class: "small muted" }, "The road is closed, so these settings take effect when it reopens."));
  box.append(group);
}

// ---- Selected intersection: control type and timing ----
function renderLabNode(box, id) {
  const node = nodeById(id);
  const ctl = controlNow(id), def = controlDefault(id);
  box.append(el("h2", {}, node.name));
  const meta = el("p", { class: "selected-meta muted" }, "ID ");
  meta.append(el("code", {}, id), ` · ${node.degree} road${node.degree === 1 ? "" : "s"} meet here`);
  box.append(meta);

  const streets = [...new Set(network.roads.filter(r => r.from === id || r.to === id).map(r => r.street))];
  const typeOptions = Object.entries(CONTROL_NAMES).map(([k, v]) => [k, v + (k === def.type ? " (original)" : "")]);
  box.append(selectBox(`ctl-${id}`, "Control", typeOptions, ctl.type, v => {
    selected = { type: "node", id };
    change(() => setControl(id, { type: v }));
  }));

  if (ctl.type === "signal") {
    if (streets.length > 1) {
      box.append(selectBox(`major-${id}`, "Main street (gets the main green)", streets.map(s => [s, s]), ctl.major,
        v => change(() => setControl(id, { major: v }))));
    } else {
      box.append(el("p", { class: "small muted" }, `Only ${streets[0] || "one street"} meets here, so the second phase is a pedestrian crossing.`));
    }
    const bar = el("div", { class: "phase-bar", "aria-hidden": "true" });
    const legend = el("p", { class: "small muted phase-legend" });
    const drawBar = c => {
      const green = Math.max(c.cycle - 2 * c.lost - c.ped, 10);
      const parts = [["main", green * c.greenShare], ["lost", c.lost], ["side", green * (1 - c.greenShare)], ["lost", c.lost]];
      if (c.ped) parts.push(["ped", c.ped]);
      const total = parts.reduce((s, p) => s + p[1], 0);
      bar.innerHTML = "";
      for (const [cls, sec] of parts) bar.append(el("span", { class: `ph ${cls}`, style: `flex-grow:${sec / total}` }));
      legend.textContent = `Main green ${Math.round(green * c.greenShare)} s · cross green ${Math.round(green * (1 - c.greenShare))} s · yellow + all-red ${c.lost} s ×2` + (c.ped ? ` · walk ${c.ped} s` : "") + ` = ${c.cycle} s`;
    };
    const live = { ...ctl };
    drawBar(live);
    const sig = (key, value) => { live[key] = value; drawBar(live); debouncedChange(() => setControl(id, { [key]: value })); };
    box.append(bar, legend,
      slider({ id: `cycle-${id}`, label: "Cycle length", min: 40, max: 180, step: 5, value: ctl.cycle, format: v => `${v} s`, onInput: v => sig("cycle", v),
        hint: "Longer cycles move more cars per hour but make each red wait longer." }),
      slider({ id: `green-${id}`, label: "Main street green", min: 0.2, max: 0.8, step: 0.05, value: ctl.greenShare, format: percent, onInput: v => sig("greenShare", v) }),
      slider({ id: `lost-${id}`, label: "Yellow + all-red per phase", min: 2, max: 8, step: 1, value: ctl.lost, format: v => `${v} s`, onInput: v => sig("lost", v) }),
      slider({ id: `ped-${id}`, label: "Pedestrian walk phase", min: 0, max: 40, step: 5, value: ctl.ped, format: v => (v ? `${v} s` : "off"), onInput: v => sig("ped", v),
        hint: "All cars stop while people cross in every direction (useful during the let-out)." }));
  } else if (ctl.type === "stop_minor") {
    box.append(selectBox(`major-${id}`, "Main street (doesn't stop)", streets.map(s => [s, s]), ctl.major,
      v => change(() => setControl(id, { major: v }))));
  } else if (ctl.type === "stop_all") {
    box.append(el("p", { class: "small muted" }, `Every car stops. One car crosses every ${settingsNow().stopHeadway} s (change it under Assumptions).`));
  } else if (ctl.type === "roundabout") {
    box.append(el("p", { class: "small muted" }, "Cars yield to traffic already in the circle; nobody stops when it's clear."));
  }

  // Approach results
  const before = result && result.baseline.intersections.find(i => i.id === id);
  const after = result && result.scenario.intersections.find(i => i.id === id);
  if (after) {
    const table = el("table", { class: "compare approaches" });
    table.innerHTML = "<thead><tr><th>Entering from</th><th>Cars</th><th>Wait</th></tr></thead>";
    const body = el("tbody");
    const rows = new Map();
    for (const a of (before ? before.approaches : [])) rows.set(a.roadId, { b: a });
    for (const a of after.approaches) rows.set(a.roadId, { ...(rows.get(a.roadId) || {}), a });
    for (const [roadId, { b, a }] of rows) {
      const tr = el("tr");
      const wait = el("td", {}, `${fmtSec(b ? b.waitSeconds : null)} → ${fmtSec(a ? a.waitSeconds : null)}`);
      if (a && b && a.waitSeconds !== b.waitSeconds) wait.classList.add(a.waitSeconds > b.waitSeconds ? "worse" : "better");
      tr.append(el("th", { scope: "row" }, roadName(roadId)), el("td", {}, `${b ? b.cars : 0} → ${a ? a.cars : 0}`), wait);
      body.append(tr);
    }
    table.append(body);
    box.append(el("p", { class: "small muted dir-head" }, `Average wait here: ${fmtSec(before ? before.avgWaitSeconds : null)} → ${fmtSec(after.avgWaitSeconds)} per car (original → modified).`), table);
  }

  if (state.controls[id]) {
    const reset = el("button", { type: "button", class: "link" }, `Restore original (${CONTROL_NAMES[def.type].toLowerCase()})`);
    reset.addEventListener("click", () => change(() => delete state.controls[id]));
    box.append(el("div", { class: "actions" }, ""), reset);
  }
}

// ---- Places and picking points on the map ----
const allPlaces = () => [...(network.places || []), ...userPlaces];
const placeById = id => allPlaces().find(p => p.id === id);

function resolvePoint(value) {
  if (!value) return null;
  const [kind, id] = value.split(":");
  if (kind === "place") {
    const p = placeById(id);
    return p && { label: p.name, nodeId: p.nodeId, latLng: p.latLng };
  }
  const n = nodeById(id);
  return n && { label: n.name, nodeId: id, latLng: ROAD_GEOMETRY.intersections[id] };
}

function startPick(which) {
  picking = picking === which ? null : which;
  StreetMap.setPicking(!!picking);
  document.body.classList.toggle("picking", !!picking);
  setStatus(picking ? `Click anywhere on the map to set the trip ${picking === "from" ? "start" : "end"} point (Esc to cancel).` : statusText());
  renderTrips();
}

// latLng from the street map, or an intersection id from the schematic view.
function handlePick(latLng, nodeId) {
  const which = picking;
  picking = null;
  StreetMap.setPicking(false);
  document.body.classList.remove("picking");
  const snap = nodeId ? { nodeId, meters: 0 } : LocalSim.nearestNode(latLng);
  const ll = latLng || ROAD_GEOMETRY.intersections[nodeId];
  const place = { id: `pin_${++pinCounter}`, name: `Pin ${pinCounter}`, latLng: ll, nodeId: snap.nodeId, meters: snap.meters, builtIn: false };
  userPlaces.push(place);
  tripDraft[which] = `place:${place.id}`;
  setStatus(`${place.name} added near ${nodeName(snap.nodeId)}${snap.meters ? ` (${snap.meters} m away)` : ""}. Rename it under "Your places".`);
  render();
}

// ---- Trips card ----
function tripResult(which, id) {
  return result && result[which].trips ? result[which].trips.find(t => t.id === id) : null;
}

function renderTrips() {
  const box = $("trips-body");
  if (!box || isDragging(box) || (box.contains(document.activeElement) && document.activeElement.tagName === "INPUT" && document.activeElement.type !== "checkbox")) return;
  box.innerHTML = "";
  if (!isLab()) {
    box.append(el("p", { class: "muted small" }, "Custom trips run in the in-browser simulator. Open the page without ?api=real to use them; the backend doesn't support them yet."));
    return;
  }

  // Existing trips
  const list = el("ul", { class: "trip-list" });
  const ev = network.eventTrip;
  const rows = [{ id: ev.id, name: ev.name, cars: settingsNow().eventCars, builtIn: true, from: nodeName(ev.from), to: nodeName(ev.to) },
    ...state.trips.map(t => ({ ...t, from: t.fromLabel, to: t.toLabel }))];
  for (const t of rows) {
    const b = tripResult("baseline", t.id), a = tripResult("scenario", t.id);
    const li = el("li", { class: "trip-row" + (selected && selected.type === "trip" && selected.id === t.id ? " selected" : "") });
    const main = el("button", { type: "button", class: "trip-main", title: "Show the route on the map" });
    main.append(el("strong", {}, t.name), el("span", { class: "muted small" }, `${t.from} → ${t.to} · ${t.cars} cars${t.onlyModified ? " · modified only" : ""}`));
    main.addEventListener("click", () => select("trip", t.id));
    const time = el("span", { class: "nums trip-time" });
    if (a && !a.completed) time.append(el("span", { class: "worse" }, "No route"));
    else {
      time.textContent = `${b && b.completed ? fmtMin(b.minutes) : "–"} → `;
      const s = el("span", {}, a ? fmtMin(a.minutes) : "–");
      if (a && b && b.completed && Math.abs(a.minutes - b.minutes) >= 0.05) s.classList.add(a.minutes > b.minutes ? "worse" : "better");
      time.append(s);
    }
    li.append(main, time);
    if (!t.builtIn) {
      const rm = el("button", { type: "button", class: "link", "aria-label": `Remove trip ${t.name}` }, "Remove");
      rm.addEventListener("click", () => removeTrip(t.id));
      li.append(rm);
    }
    list.append(li);
  }
  box.append(list);
  box.append(el("p", { class: "small muted" }, `Times are door-to-door for the trip, original → modified. Also simulated: ${network.background.cars} background cars on ${network.background.routes} routes (see Assumptions).`));

  // New trip form
  const form = el("div", { class: "trip-form" });
  form.append(el("h3", {}, "Add a trip"));
  const pointRow = which => {
    const row = el("div", { class: "point-row" });
    const sel = el("select", { id: `trip-${which}`, "aria-label": which === "from" ? "Trip start" : "Trip end" });
    const add = (v, text, group) => { const o = el("option", { value: v }, text); if (v === tripDraft[which]) o.selected = true; group.append(o); };
    add("", which === "from" ? "Start: choose…" : "End: choose…", sel);
    const gPins = el("optgroup", { label: "Your places" });
    for (const p of userPlaces) add(`place:${p.id}`, p.name, gPins);
    if (userPlaces.length) sel.append(gPins);
    const gPlaces = el("optgroup", { label: "Places" });
    for (const p of network.places || []) add(`place:${p.id}`, p.name, gPlaces);
    sel.append(gPlaces);
    const gNodes = el("optgroup", { label: "Intersections" });
    for (const n of [...network.intersections].sort((a, b) => a.name.localeCompare(b.name))) add(`node:${n.id}`, n.name, gNodes);
    sel.append(gNodes);
    sel.addEventListener("change", () => { tripDraft[which] = sel.value; renderTripsSoon(); });
    const pin = el("button", { type: "button", class: "pin-btn" + (picking === which ? " active" : ""), "aria-pressed": String(picking === which) }, picking === which ? "Click map…" : "Pick on map");
    pin.title = "Click anywhere on the map; the point snaps to the nearest intersection";
    pin.addEventListener("click", () => startPick(which));
    row.append(el("span", { class: "point-tag " + which }, which === "from" ? "A" : "B"), sel, pin);
    return row;
  };
  form.append(pointRow("from"), pointRow("to"));

  const nums = el("div", { class: "trip-nums" });
  const carsLabel = el("label", { for: "trip-cars" }, "Cars ");
  const cars = el("input", { type: "number", id: "trip-cars", min: "1", max: "1000", step: "5", value: String(tripDraft.cars) });
  cars.addEventListener("input", () => { tripDraft.cars = Number(cars.value); });
  carsLabel.append(cars);
  const nameLabel = el("label", { for: "trip-name" }, "Name ");
  const name = el("input", { type: "text", id: "trip-name", maxlength: "40", placeholder: "optional", value: tripDraft.name });
  name.addEventListener("input", () => { tripDraft.name = name.value; });
  nameLabel.append(name);
  nums.append(carsLabel, nameLabel);
  form.append(nums);

  const only = el("label", { class: "check small" });
  const onlyBox = el("input", { type: "checkbox", id: "trip-only-modified" });
  onlyBox.checked = tripDraft.onlyModified;
  onlyBox.addEventListener("change", () => { tripDraft.onlyModified = onlyBox.checked; });
  only.append(onlyBox, " New traffic: only in the modified scenario");
  form.append(only);

  const err = el("p", { class: "small worse", id: "trip-error" });
  const addBtn = el("button", { type: "button", class: "primary" }, "Add trip");
  addBtn.addEventListener("click", () => addTrip(err));
  form.append(el("div", { class: "actions" }), addBtn, err);
  box.append(form);

  // Your places
  if (userPlaces.length) {
    const pl = el("div", { class: "places" });
    pl.append(el("h3", {}, "Your places"));
    const ul = el("ul", { class: "changes" });
    for (const p of userPlaces) {
      const li = el("li");
      const input = el("input", { type: "text", value: p.name, maxlength: "30", "aria-label": `Rename ${p.name}` });
      input.addEventListener("change", () => {
        p.name = input.value.trim() || p.name;
        for (const t of state.trips) {
          if (t.fromPlace === p.id) t.fromLabel = p.name;
          if (t.toPlace === p.id) t.toLabel = p.name;
        }
        render();
      });
      const rm = el("button", { type: "button", class: "link" }, "Delete");
      rm.addEventListener("click", () => {
        userPlaces = userPlaces.filter(x => x !== p);
        for (const w of ["from", "to"]) if (tripDraft[w] === `place:${p.id}`) tripDraft[w] = "";
        render();
      });
      li.append(input, el("span", { class: "small muted" }, `→ ${nodeName(p.nodeId)}`), rm);
      ul.append(li);
    }
    pl.append(ul, el("p", { class: "small muted" }, "Each place snaps to its nearest intersection for the simulation. Trips keep working if you delete a place."));
    box.append(pl);
  }
}
let tripsTimer = null;
const renderTripsSoon = () => { clearTimeout(tripsTimer); tripsTimer = setTimeout(() => { renderTrips(); StreetMap.render(mapContext()); }, 0); };

function addTrip(errBox) {
  const a = resolvePoint(tripDraft.from), b = resolvePoint(tripDraft.to);
  const cars = Math.round(Number(tripDraft.cars));
  if (!a || !b) { errBox.textContent = "Choose a start and an end point."; return; }
  if (a.nodeId === b.nodeId) { errBox.textContent = `Both points snap to ${nodeName(a.nodeId)}. Pick points further apart.`; return; }
  if (!(cars >= 1 && cars <= 1000)) { errBox.textContent = "Cars must be between 1 and 1000."; return; }
  const id = `trip_${++tripCounter}`;
  const trip = {
    id, name: tripDraft.name.trim() || `${a.label} → ${b.label}`, cars, onlyModified: tripDraft.onlyModified,
    fromNodeId: a.nodeId, toNodeId: b.nodeId, fromLabel: a.label, toLabel: b.label, fromLatLng: a.latLng, toLatLng: b.latLng,
    fromPlace: tripDraft.from.startsWith("place:") ? tripDraft.from.slice(6) : null,
    toPlace: tripDraft.to.startsWith("place:") ? tripDraft.to.slice(6) : null
  };
  tripDraft.name = "";
  selected = { type: "trip", id };
  change(() => { state.trips = [...state.trips, trip]; });
}

function removeTrip(id) {
  if (selected && selected.type === "trip" && selected.id === id) selected = null;
  change(() => { state.trips = state.trips.filter(t => t.id !== id); });
}

// ---- Selected trip ----
function tripInfo(id) {
  if (id === network.eventTrip.id) {
    const ev = network.eventTrip;
    return { id, name: ev.name, cars: settingsNow().eventCars, fromLabel: nodeName(ev.from), toLabel: nodeName(ev.to), builtIn: true,
      fromLatLng: ROAD_GEOMETRY.intersections[ev.from], toLatLng: ROAD_GEOMETRY.intersections[ev.to] };
  }
  return state.trips.find(t => t.id === id) || null;
}

function renderSelectedTrip(box, id) {
  const t = tripInfo(id);
  if (!t) { selected = null; box.append(el("h2", {}, "Selected"), el("p", { class: "muted" }, "Click a road or intersection on the map.")); return; }
  box.append(el("h2", {}, t.name));
  box.append(el("p", { class: "selected-meta muted" }, `${t.fromLabel} → ${t.toLabel} · ${t.cars} cars${t.builtIn ? " (size set under Assumptions)" : ""}`));
  const b = tripResult("baseline", id), a = tripResult("scenario", id);
  const table = el("table", { class: "compare" });
  table.innerHTML = "<thead><tr><th></th><th>Original</th><th>Modified</th></tr></thead>";
  const body = el("tbody");
  const cell = (r, f) => (!r ? "–" : r.completed ? f(r) : "No route");
  for (const [label, f] of [["Trip time", r => fmtMin(r.minutes)], ["Waiting at intersections", r => fmtMin(r.waitMinutes)], ["Main route share", r => percent(r.routeShare)]]) {
    const tr = el("tr");
    tr.append(el("th", { scope: "row" }, label), el("td", {}, t.onlyModified && label === "Trip time" && !b ? "Not in original" : cell(b, f)), el("td", {}, cell(a, f)));
    body.append(tr);
  }
  table.append(body);
  box.append(table);
  if (a && a.completed) {
    box.append(el("p", { class: "small muted dir-head" }, `Main route now (${a.routes > 1 ? `${percent(a.routeShare)} of these cars; the rest spread over ${a.routes - 1} other route${a.routes > 2 ? "s" : ""}` : "all of these cars"}):`));
    const ol = el("ol", { class: "route-list" });
    for (const step of a.route) ol.append(el("li", {}, roadName(step.roadId)));
    box.append(ol);
    box.append(el("p", { class: "small muted" }, "Map: solid purple = modified route, dashed = original route."));
  } else if (a) {
    box.append(el("p", { class: "worse small" }, "No open road connects these points in the modified scenario, so these cars are counted as unserved."));
  }
  if (!t.builtIn) {
    const rm = el("button", { type: "button" }, "Remove trip");
    rm.addEventListener("click", () => removeTrip(id));
    box.append(el("div", { class: "actions" }), rm);
  }
}

// ---- Assumptions card ----
function renderSettings() {
  const box = $("settings-body");
  if (!box || isDragging(box)) return;
  box.innerHTML = "";
  if (!isLab()) {
    box.append(el("p", { class: "muted small" }, "Using the backend's assumptions (200 trips, 100 cars per lane, 2 min per road)."));
    return;
  }
  const s = settingsNow();
  const set = (key, v) => debouncedChange(() => {
    if (v === network.settingsDefaults[key]) delete state.settings[key]; else state.settings[key] = v;
  });
  box.append(
    el("p", { class: "small muted" }, `These apply to both columns. One ${network.periodMinutes}-minute let-out period; every value is a simulation assumption.`),
    slider({ id: "set-event", label: "Let-out cars", min: 0, max: 600, step: 25, value: s.eventCars, format: v => `${v}`, onInput: v => set("eventCars", v),
      hint: `${nodeName(network.eventTrip.from)} → ${nodeName(network.eventTrip.to)}` }),
    slider({ id: "set-bg", label: "Background traffic", min: 0, max: 2, step: 0.1, value: s.backgroundScale, format: v => `${Math.round(v * 100)}% (${Math.round(v * network.background.cars)} cars)`, onInput: v => set("backgroundScale", v) }),
    slider({ id: "set-cap", label: "Lane capacity", min: 50, max: 200, step: 10, value: s.laneCapacity, format: v => `${v} cars / lane / ${network.periodMinutes} min`, onInput: v => set("laneCapacity", v) }),
    slider({ id: "set-stop", label: "All-way stop: seconds per car", min: 2, max: 8, step: 0.5, value: s.stopHeadway, format: v => `${v} s`, onInput: v => set("stopHeadway", v) })
  );
  if (Object.keys(state.settings).length) {
    const btn = el("button", { type: "button", class: "link" }, "Restore default assumptions");
    btn.addEventListener("click", () => change(() => { state.settings = {}; }));
    box.append(btn);
  }
}

// ---- What the street map needs to draw lab extras ----
function mapContext() {
  const ctx = { state, selected, roadResult, colorKey: roadColorKey };
  if (!isLab()) {
    ctx.controlOf = id => (state.signals.has(id) ? { type: "signal" } : { type: "none" });
    return ctx;
  }
  ctx.controlOf = controlNow;
  ctx.places = allPlaces();
  ctx.trips = [tripInfo(network.eventTrip.id), ...state.trips];
  ctx.picking = picking;
  if (selected && selected.type === "trip") {
    const a = tripResult("scenario", selected.id), b = tripResult("baseline", selected.id);
    ctx.route = { trip: tripInfo(selected.id), after: a && a.completed ? a.route : [], before: b && b.completed ? b.route : [] };
  }
  return ctx;
}

document.addEventListener("keydown", e => { if (e.key === "Escape" && picking) startPick(picking); });
