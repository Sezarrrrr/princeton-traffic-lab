// Street-map view: Leaflet + OpenStreetMap tiles, with the simulation roads drawn on the real
// street geometry from geo/princeton-geo.js (keyed by the shared road IDs).
// The simulation numbers still come only from the API; this file just draws them.

const StreetMap = (() => {
  // ?tiles=test-fail points at a bad tile address, to rehearse the schematic fallback before the demo.
  const TILE_URL = new URLSearchParams(location.search).get("tiles") === "test-fail"
    ? "http://127.0.0.1:9/{z}/{x}/{y}.png"
    : "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const COLORS = { free: "#2e9e5b", busy: "#e0a100", jam: "#d0342c", closed: "#9aa1ad", empty: "#a9b0bb", nocar: "#c3c8d0", bus: "#2f6fdb", accent: "#e77500", route: "#7b3fd1" };
  const DRIVE_SIDE_METERS = 4;  // directional cars drive this far right of the road centerline
  const CLASS_WIDTH = { primary: 7, secondary: 6, tertiary: 5 };  // other streets: 3.5
  const MAX_CARS = 260;         // keeps the animation smooth on the big network
  const BASE_WIDTH = 7, LANE_WIDTH = 4;
  // Visual only: which way cars drive along each road. Trips in the road doc run from
  // Nassau & Washington to Princeton Station, so Route A uses alex_station from Faculty Rd north.
  const REVERSE_FLOW = new Set(["alex_station"]);
  const CAR_COLORS = ["#ffffff", "#f2f2f2", "#2b2f38", "#3a6fd8", "#c8372d", "#8a929e", "#e9c46a"];

  let map = null;
  let ready = false;
  const roadLayers = {};      // road id -> { casing, line, halo, hit, xMarker, badge, path }
  const nodeLayers = {};      // intersection id -> { ring, signal }
  let busLayer = null;
  let carLayer = null;
  let cars = [];
  let lastFrame = null;
  let missingGeometry = [];
  let lab = false;            // in-browser simulator: per-direction cars, control icons, trips
  let placeLayer = null, tripLayer = null, routeLayer = null;
  let routeKey = "", placeKey = "";
  let carScale = 1;           // cars shrink when zoomed out so they don't hide the road colors
  const updateCarScale = () => { carScale = Math.min(1.15, Math.max(0.55, Math.pow(2, map.getZoom() - 17))); };
  let lastCtx = null;
  // Zoom bands for decluttering: small stop signs and plain junction dots appear when zoomed in.
  function updateZoomClass() {
    const z = map.getZoom(), c = map.getContainer();
    c.classList.toggle("z-far", z < 15);
    c.classList.toggle("z-mid", z >= 15 && z < 16.25);
    c.classList.toggle("z-near", z >= 16.25);
  }

  // ---- Geometry helpers (meters on a small local area) ----
  const R = 6371000;
  function meters(a, b) {
    const lat = ((a[0] + b[0]) / 2) * Math.PI / 180;
    const dx = (b[1] - a[1]) * Math.PI / 180 * Math.cos(lat) * R;
    const dy = (b[0] - a[0]) * Math.PI / 180 * R;
    return Math.hypot(dx, dy);
  }
  function bearing(a, b) { // degrees clockwise from north
    const lat = ((a[0] + b[0]) / 2) * Math.PI / 180;
    const dx = (b[1] - a[1]) * Math.cos(lat);
    const dy = b[0] - a[0];
    return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  }
  function measure(points) {
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + meters(points[i - 1], points[i]));
    return { points, cum, length: cum[cum.length - 1] };
  }
  // Shift a polyline to the right of its direction of travel (right-hand traffic).
  function offsetRight(points, m) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
      const lat = points[i][0] * Math.PI / 180;
      const dx = (b[1] - a[1]) * Math.cos(lat), dy = b[0] - a[0];
      const len = Math.hypot(dx, dy) || 1;
      // right-hand normal of (dx, dy) is (dy, -dx); convert meters back to degrees
      const east = (dy / len) * m, north = (-dx / len) * m;
      out.push([points[i][0] + north / 111320, points[i][1] + east / (111320 * Math.cos(lat))]);
    }
    return out;
  }
  function pointAt(path, s) { // position and heading at distance s along the path
    const { points, cum } = path;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    const t = Math.min(Math.max((s - cum[i - 1]) / seg, 0), 1);
    const a = points[i - 1], b = points[i];
    return { latLng: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], heading: bearing(a, b) };
  }

  // ---- Icons ----
  function carIcon(color) {
    const html = `<div class="car-rot"><svg width="14" height="26" viewBox="0 0 14 26" aria-hidden="true">
      <rect x="1" y="1" width="12" height="24" rx="4" fill="${color}" stroke="#1d2330" stroke-width="1.2"/>
      <rect x="2.6" y="5.5" width="8.8" height="5" rx="1.6" fill="#1d2330" opacity="0.8"/>
      <rect x="2.6" y="17" width="8.8" height="3.6" rx="1.4" fill="#1d2330" opacity="0.6"/>
      <rect x="2" y="1.6" width="2.4" height="1.6" rx="0.6" fill="#ffe08a"/>
      <rect x="9.6" y="1.6" width="2.4" height="1.6" rx="0.6" fill="#ffe08a"/>
    </svg></div>`;
    return L.divIcon({ className: "car-icon", html, iconSize: [14, 26], iconAnchor: [7, 13] });
  }
  const venueIcon = () => L.divIcon({
    className: "venue-icon",
    html: '<div class="venue-pin"><span class="venue-dot"></span></div>',
    iconSize: [26, 26], iconAnchor: [13, 13]
  });
  const signalIcon = () => L.divIcon({
    className: "map-signal",
    html: '<svg width="14" height="30" viewBox="0 0 14 30"><rect width="14" height="30" rx="3" fill="#2b2f38"/><circle cx="7" cy="7" r="3.5" fill="#ff5a4f"/><circle cx="7" cy="15" r="3.5" fill="#6b5a1e"/><circle cx="7" cy="23" r="3.5" fill="#3ddc84"/></svg>',
    iconSize: [14, 30], iconAnchor: [-6, 34]
  });
  const textIcon = (cls, text) => L.divIcon({ className: cls, html: `<span>${text}</span>`, iconSize: null });
  const OCTAGON = "6,1 14,1 19,6 19,14 14,19 6,19 1,14 1,6";
  const controlIcons = {
    signal: () => L.divIcon({ ...signalIcon().options, className: "map-signal map-ctl ctl-signal" }),
    stop_all: () => L.divIcon({ className: "map-ctl ctl-stop_all", iconSize: [20, 20], iconAnchor: [-6, 26],
      html: `<svg width="20" height="20" viewBox="0 0 20 20"><polygon points="${OCTAGON}" fill="#c8102e" stroke="#fff" stroke-width="1.5"/><text x="10" y="13.5" text-anchor="middle" font-size="7.5" font-weight="700" fill="#fff" font-family="system-ui,sans-serif">ALL</text></svg>` }),
    stop_minor: () => L.divIcon({ className: "map-ctl ctl-stop_minor", iconSize: [16, 16], iconAnchor: [-6, 22],
      html: `<svg width="16" height="16" viewBox="0 0 20 20"><polygon points="${OCTAGON}" fill="#c8102e" stroke="#fff" stroke-width="1.8"/><rect x="5" y="8.6" width="10" height="2.8" fill="#fff"/></svg>` }),
    roundabout: () => L.divIcon({ className: "map-ctl ctl-roundabout", iconSize: [20, 20], iconAnchor: [-6, 26],
      html: '<svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="9" fill="#2f6fdb" stroke="#fff" stroke-width="1.5"/><path d="M10 4.5a5.5 5.5 0 1 1-5.2 3.7" fill="none" stroke="#fff" stroke-width="1.8"/><path d="M3.2 6.2l1.8 2.6 2.4-1.9" fill="none" stroke="#fff" stroke-width="1.6"/></svg>' })
  };
  const pointIcon = (cls, text) => L.divIcon({ className: "trip-point", iconSize: [22, 22], iconAnchor: [11, 11], html: `<span class="tp ${cls}">${text}</span>` });
  const placeIcon = builtIn => L.divIcon({ className: "place-icon", iconSize: [12, 12], iconAnchor: [6, 6], html: `<span class="pl ${builtIn ? "landmark" : "pin"}"></span>` });

  // ---- Setup ----
  function init(network, handlers, onTilesFailed) {
    if (typeof L === "undefined" || typeof ROAD_GEOMETRY === "undefined") return false;
    lab = !!(network.capabilities && network.capabilities.lab);
    handlersRef = handlers;

    map = L.map("leaflet-map", { zoomSnap: 0.25, zoomDelta: 0.5, scrollWheelZoom: true, preferCanvas: false });
    let loaded = 0, failed = 0, reported = false;
    const tiles = L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION });
    tiles.on("tileload", () => { loaded++; });
    tiles.on("tileerror", () => {
      failed++;
      if (!reported && loaded === 0 && failed >= 6) { reported = true; onTilesFailed("Map tiles couldn't load."); }
    });
    tiles.addTo(map);
    // No tiles at all after a while (e.g. offline at the venue): fall back to the schematic.
    setTimeout(() => { if (!reported && loaded === 0) { reported = true; onTilesFailed("Map tiles didn't load in time."); } }, 8000);
    map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');

    const allPoints = [];
    busLayer = L.layerGroup();
    const roadPane = map.createPane("roads"); roadPane.style.zIndex = 410;
    const carPane = map.createPane("cars"); carPane.style.zIndex = 620; carPane.style.pointerEvents = "none";
    const labelPane = map.createPane("labels"); labelPane.style.zIndex = 630; labelPane.style.pointerEvents = "none";

    missingGeometry = [];
    const startPoints = []; // the first view frames the core network around campus and downtown
    for (const road of network.roads) {
      const pts = ROAD_GEOMETRY.roads[road.id];
      if (!pts || pts.length < 2) { missingGeometry.push(road.id); continue; }
      allPoints.push(...pts);
      if (!lab || road.core) startPoints.push(...pts);
      const path = measure(REVERSE_FLOW.has(road.id) ? [...pts].reverse() : pts);
      const lanesPaths = { forward: measure(offsetRight(pts, DRIVE_SIDE_METERS)), backward: measure(offsetRight([...pts].reverse(), DRIVE_SIDE_METERS)) };
      const mid = pointAt(measure(pts), measure(pts).length / 2).latLng;
      const opts = { pane: "roads", lineCap: "round", lineJoin: "round" };
      // Bigger streets are drawn wider, so the map reads like a road map.
      const base = lab ? (CLASS_WIDTH[road.highway] || 3.5) : BASE_WIDTH;
      const layers = {
        path, lanesPaths, pts, base,
        halo: L.polyline(pts, { ...opts, color: COLORS.accent, weight: 20, opacity: 0, interactive: false }),
        casing: L.polyline(pts, { ...opts, color: "#ffffff", weight: base + 3, opacity: 0.9, interactive: false }),
        line: L.polyline(pts, { ...opts, color: COLORS.empty, weight: base, opacity: 0.95, interactive: false }),
        hit: L.polyline(pts, { ...opts, color: "#000", weight: lab ? 18 : 26, opacity: 0.001, className: `road-hit road-hit-${road.id}`, bubblingMouseEvents: false }),
        xMarker: L.marker(mid, { pane: "labels", icon: textIcon("map-x", "✕"), interactive: false }),
        badge: L.marker(mid, { pane: "labels", icon: textIcon("map-badge", ""), interactive: false }),
        badgeText: null
      };
      layers.hit.bindTooltip(road.name, { sticky: true, direction: "top", className: "road-tip" });
      layers.hit.on("click", e => handlers.onSelectRoad(road.id, e.latlng));
      for (const key of ["halo", "casing", "line", "hit"]) layers[key].addTo(map);
      roadLayers[road.id] = layers;
    }

    if (network.busRoute) {
      for (const id of network.busRoute.roadIds) {
        const pts = ROAD_GEOMETRY.roads[id];
        if (pts) busLayer.addLayer(L.polyline(pts, { pane: "roads", color: COLORS.bus, weight: 3, dashArray: "2 9", lineCap: "round", interactive: false }));
      }
    }

    const signals = new Set(network.signalIntersections || []);
    for (const inter of network.intersections) {
      const ll = ROAD_GEOMETRY.intersections[inter.id];
      if (!ll) continue;
      const can = !lab && signals.has(inter.id);
      const ring = L.circleMarker(ll, {
        pane: "roads", radius: can ? 9 : 6, weight: can ? 3 : 2, bubblingMouseEvents: false,
        color: can ? COLORS.accent : "#1d2330", fillColor: "#ffffff", fillOpacity: 1
      });
      ring.bindTooltip(inter.name + (can ? " (signal possible)" : ""), { direction: "top", className: "road-tip" });
      ring.on("click", () => handlers.onSelectNode(inter.id));
      ring.addTo(map);
      nodeLayers[inter.id] = { ring, can, ll, ctlKey: "none", ctlMarker: null, minor: lab && (inter.degree || 0) <= 2 };
    }
    placeLayer = L.layerGroup().addTo(map);
    tripLayer = L.layerGroup().addTo(map);
    routeLayer = L.layerGroup().addTo(map);
    map.on("click", e => handlers.onMapClick && handlers.onMapClick(e.latlng));

    // "You are here": Julis Romo Rabinowitz Building (HackPrinceton venue).
    const venue = ROAD_GEOMETRY.landmarks && ROAD_GEOMETRY.landmarks.jrr;
    if (venue) {
      L.marker(venue.latLng, { icon: venueIcon(), keyboard: false, zIndexOffset: 1000 })
        .bindTooltip(`<strong>You are here</strong><br>${venue.name}`, { permanent: true, direction: "right", offset: [12, 0], className: "venue-label" })
        .on("click", e => handlers.onMapClick && handlers.onMapClick(e.latlng))
        .addTo(map);
      allPoints.push(venue.latLng);
    }

    carLayer = L.layerGroup().addTo(map);
    map.fitBounds(L.latLngBounds(startPoints.length ? startPoints : allPoints), { padding: [30, 30] });
    updateCarScale();
    updateZoomClass();
    map.on("zoomend", () => { updateCarScale(); updateZoomClass(); if (lastCtx) render(lastCtx); });
    ready = true;
    requestAnimationFrame(animate);
    return true;
  }

  // ---- Update from state + results ----
  function render(ctx) {
    lastCtx = ctx;
    if (!ready) return;
    const { state, selected, roadResult, colorKey } = ctx;
    const zoom = map.getZoom();
    for (const [id, layers] of Object.entries(roadLayers)) {
      const after = roadResult("scenario", id), before = roadResult("baseline", id);
      const closed = state.closed.has(id);
      const lanes = state.lanes[id] || 0;
      const width = layers.base + lanes * LANE_WIDTH;
      const key = colorKey(after);
      layers.line.setStyle({ color: COLORS[key], weight: width, dashArray: closed ? "6 10" : key === "nocar" ? "2 7" : null });
      layers.casing.setStyle({ weight: width + 3, opacity: closed ? 0.5 : 0.9 });
      const isSel = selected && selected.type === "road" && selected.id === id;
      layers.halo.setStyle({ opacity: isSel ? 0.45 : 0, weight: width + 14 });
      if (closed) layers.xMarker.addTo(map); else layers.xMarker.remove();

      // Trip-count badges: always for roads that changed or were edited; for the rest only when zoomed in.
      let text = "", diff = 0;
      if (after && before && !after.closed && after.carTrips > 0) {
        diff = after.carTrips - before.carTrips;
        text = `${after.carTrips}` + (diff ? ` (${diff > 0 ? "+" : ""}${diff})` : "");
      }
      if (lanes && !closed) text += `${text ? " · " : ""}+${lanes} lane${lanes > 1 ? "s" : ""}`;
      const important = diff !== 0 || lanes > 0 || isSel;
      const show = text && (!lab || important || zoom >= 17);
      if (show) {
        if (!map.hasLayer(layers.badge)) layers.badge.addTo(map);
        const el = layers.badge.getElement();
        if (el && layers.badgeText !== text) { el.firstChild.textContent = text; layers.badgeText = text; }
      } else if (map.hasLayer(layers.badge)) {
        layers.badge.remove();
        layers.badgeText = null;
      }
    }
    for (const [id, n] of Object.entries(nodeLayers)) {
      const isSel = selected && selected.type === "node" && selected.id === id;
      // Plain bends (two roads, no control) only show up close in, unless selected.
      // Zoomed far out, only signals, roundabouts and all-way stops keep a dot.
      const type = ctx.controlOf ? ctx.controlOf(id).type : "none";
      const hide = !isSel && lab && ((n.minor && zoom < 16.25 && type === "none") || (zoom < 15 && (type === "none" || type === "stop_minor")));
      const radius = n.can ? 9 : lab ? (zoom < 15 ? 3.5 : zoom < 16.25 ? 5 : 7) : 6;
      n.ring.setRadius(hide ? 0 : radius);
      n.ring.setStyle({ fillColor: isSel ? "#ffe2c4" : "#ffffff", weight: hide ? 0 : isSel ? 4 : (n.can ? 3 : zoom < 15 && lab ? 1.5 : 2) });
      const key = ctx.controlOf ? ctx.controlOf(id).type : "none";
      if (key !== n.ctlKey) {
        if (n.ctlMarker) n.ctlMarker.remove();
        n.ctlMarker = controlIcons[key] ? L.marker(n.ll, { pane: "labels", icon: controlIcons[key](), interactive: false, keyboard: false }).addTo(map) : null;
        n.ctlKey = key;
      }
    }
    if (state.busEnabled) busLayer.addTo(map); else busLayer.remove();
    if (lab) renderLab(ctx);
  }

  // Places, trip end points, and the selected trip's route.
  function renderLab(ctx) {
    const pk = JSON.stringify((ctx.places || []).map(p => [p.id, p.name]));
    if (pk !== placeKey) {
      placeKey = pk;
      placeLayer.clearLayers();
      for (const p of ctx.places || []) {
        L.marker(p.latLng, { pane: "labels", icon: placeIcon(p.builtIn), keyboard: false, bubblingMouseEvents: false })
          .bindTooltip(p.name + (p.builtIn ? "" : " (your place)"), { direction: "top", className: "road-tip" })
          .on("click", e => handlersRef.onMapClick && handlersRef.onMapClick(e.latlng))
          .addTo(placeLayer);
      }
    }
    tripLayer.clearLayers();
    const sel = ctx.route && ctx.route.trip;
    for (const t of ctx.trips || []) {
      if (!t || !t.fromLatLng || !t.toLatLng) continue;
      const active = sel && sel.id === t.id;
      if (!active && t.builtIn) continue; // the let-out's ends are shown only when it's selected
      const opacity = active || !sel ? 1 : 0.45;
      for (const [ll, nodeId, cls, text] of [[t.fromLatLng, t.fromNodeId, "a", "A"], [t.toLatLng, t.toNodeId, "b", "B"]]) {
        const snap = nodeId && ROAD_GEOMETRY.intersections[nodeId];
        if (snap && meters(ll, snap) > 15) L.polyline([ll, snap], { pane: "labels", color: "#1d2330", weight: 2, dashArray: "3 5", opacity: 0.7 * opacity, interactive: false }).addTo(tripLayer);
        L.marker(ll, { pane: "labels", icon: pointIcon(cls, text), interactive: false, keyboard: false, opacity }).addTo(tripLayer);
      }
    }
    const rk = JSON.stringify(ctx.route ? [ctx.route.before, ctx.route.after] : null);
    if (rk === routeKey) return;
    routeKey = rk;
    routeLayer.clearLayers();
    if (!ctx.route) return;
    const line = steps => steps.flatMap(s => {
      const pts = ROAD_GEOMETRY.roads[s.roadId] || [];
      return s.dir === -1 ? [...pts].reverse() : pts;
    });
    const before = line(ctx.route.before), after = line(ctx.route.after);
    if (before.length) L.polyline(before, { pane: "roads", color: "#1d2330", weight: 4, opacity: 0.75, dashArray: "8 8", interactive: false }).addTo(routeLayer);
    if (after.length) {
      L.polyline(after, { pane: "roads", color: "#ffffff", weight: 11, opacity: 0.9, interactive: false }).addTo(routeLayer);
      L.polyline(after, { pane: "roads", color: COLORS.route, weight: 6, opacity: 0.95, interactive: false }).addTo(routeLayer);
    }
  }
  let handlersRef = {};

  function setPicking(on) {
    if (map) map.getContainer().classList.toggle("picking", on);
  }

  // ---- Cars (decoration: count follows car trips, speed follows travel time) ----
  function rebuildCars(result, enabled) {
    if (!ready) return;
    carLayer.clearLayers();
    cars = [];
    if (!result || !enabled) return;
    const times = result.baseline.roads.map(r => r.travelMinutes).filter(t => t > 0);
    const freeFlow = times.length ? Math.min(...times) : 1;
    let colorIndex = 0;
    const addCar = (path, s, speed) => {
      if (cars.length >= MAX_CARS) return;
      const p = pointAt(path, s);
      const marker = L.marker(p.latLng, {
        pane: "cars", icon: carIcon(CAR_COLORS[colorIndex++ % CAR_COLORS.length]), interactive: false, keyboard: false
      }).addTo(carLayer);
      cars.push({ marker, path, s, speed, rot: null });
    };
    for (const road of result.scenario.roads) {
      const layers = roadLayers[road.id];
      if (!layers || road.closed || !road.carTrips || !road.travelMinutes) continue;
      // In-browser simulator: cars in each direction, on the right-hand side, speed from that direction.
      if (road.forward !== undefined) {
        for (const key of ["forward", "backward"]) {
          const d = road[key];
          if (!d || !d.cars) continue;
          const path = layers.lanesPaths[key];
          const count = Math.min(6, Math.round(d.cars * path.length / 16000));
          const speed = 55 / Math.max(d.minutes / Math.max(d.freeMinutes, 0.01), 1);
          for (let i = 0; i < count; i++) addCar(path, (i + 0.5) / count * path.length, speed);
        }
        continue;
      }
      const { path } = layers;
      const count = Math.max(1, Math.min(10, Math.round(road.carTrips * path.length / 14000)));
      const speed = 55 / Math.max(road.travelMinutes / freeFlow, 1); // visual meters per second
      for (let i = 0; i < count; i++) addCar(path, (i + 0.5) / count * path.length, speed);
    }
  }

  function animate(time) {
    const dt = lastFrame === null ? 0 : Math.min((time - lastFrame) / 1000, 0.1);
    lastFrame = time;
    if (map && !document.getElementById("street-view").hidden) {
      const view = map.getBounds().pad(0.1);
      for (const car of cars) {
        car.s = (car.s + car.speed * dt) % car.path.length;
        const p = pointAt(car.path, car.s);
        if (!view.contains(p.latLng)) continue; // off screen: skip the DOM update
        car.marker.setLatLng(p.latLng);
        const el = car.marker.getElement();
        if (!car.rot && el) car.rot = el.firstChild;
        if (car.rot) car.rot.style.transform = `rotate(${p.heading}deg) scale(${carScale})`;
      }
    }
    requestAnimationFrame(animate);
  }

  return {
    init, render, rebuildCars, setPicking,
    getView: () => (map ? { lat: map.getCenter().lat, lng: map.getCenter().lng, zoom: map.getZoom() } : null),
    setView: v => { if (map && v) map.setView([v.lat, v.lng], v.zoom, { animate: false }); },
    isReady: () => ready,
    missing: () => missingGeometry,
    refreshSize: () => { if (map) map.invalidateSize(); }
  };
})();
