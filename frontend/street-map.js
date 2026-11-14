// Street-map view: Leaflet + OpenStreetMap tiles, with the simulation roads drawn on the real
// street geometry from geo/princeton-geo.js (keyed by the shared road IDs).
// The simulation numbers still come only from the API; this file just draws them.

const StreetMap = (() => {
  // ?tiles=test-fail points at a bad tile address, to rehearse the schematic fallback before the demo.
  const TILE_URL = new URLSearchParams(location.search).get("tiles") === "test-fail"
    ? "http://127.0.0.1:9/{z}/{x}/{y}.png"
    : "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const COLORS = { free: "#2e9e5b", busy: "#e0a100", jam: "#d0342c", closed: "#9aa1ad", empty: "#a9b0bb", bus: "#2f6fdb", accent: "#e77500" };
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
  let carScale = 1;           // cars shrink when zoomed out so they don't hide the road colors
  const updateCarScale = () => { carScale = Math.min(1.15, Math.max(0.55, Math.pow(2, map.getZoom() - 17))); };

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

  // ---- Setup ----
  function init(network, handlers, onTilesFailed) {
    if (typeof L === "undefined" || typeof ROAD_GEOMETRY === "undefined") return false;

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
    for (const road of network.roads) {
      const pts = ROAD_GEOMETRY.roads[road.id];
      if (!pts || pts.length < 2) { missingGeometry.push(road.id); continue; }
      allPoints.push(...pts);
      const path = measure(REVERSE_FLOW.has(road.id) ? [...pts].reverse() : pts);
      const mid = pointAt(measure(pts), measure(pts).length / 2).latLng;
      const opts = { pane: "roads", lineCap: "round", lineJoin: "round" };
      const layers = {
        path,
        halo: L.polyline(pts, { ...opts, color: COLORS.accent, weight: 20, opacity: 0, interactive: false }),
        casing: L.polyline(pts, { ...opts, color: "#ffffff", weight: BASE_WIDTH + 4, opacity: 0.9, interactive: false }),
        line: L.polyline(pts, { ...opts, color: COLORS.empty, weight: BASE_WIDTH, opacity: 0.95, interactive: false }),
        hit: L.polyline(pts, { ...opts, color: "#000", weight: 26, opacity: 0.001, className: `road-hit road-hit-${road.id}` }),
        xMarker: L.marker(mid, { pane: "labels", icon: textIcon("map-x", "✕"), interactive: false }),
        badge: L.marker(mid, { pane: "labels", icon: textIcon("map-badge", ""), interactive: false })
      };
      layers.hit.bindTooltip(road.name, { sticky: true, direction: "top", className: "road-tip" });
      layers.hit.on("click", () => handlers.onSelectRoad(road.id));
      for (const key of ["halo", "casing", "line", "hit", "badge"]) layers[key].addTo(map);
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
      const can = signals.has(inter.id);
      const ring = L.circleMarker(ll, {
        pane: "roads", radius: can ? 9 : 6, weight: can ? 3 : 2,
        color: can ? COLORS.accent : "#1d2330", fillColor: "#ffffff", fillOpacity: 1
      });
      ring.bindTooltip(inter.name + (can ? " (signal possible)" : ""), { direction: "top", className: "road-tip" });
      ring.on("click", () => handlers.onSelectNode(inter.id));
      ring.addTo(map);
      nodeLayers[inter.id] = { ring, can, signal: L.marker(ll, { pane: "labels", icon: signalIcon(), interactive: false }) };
    }

    // "You are here": Julis Romo Rabinowitz Building (HackPrinceton venue).
    const venue = ROAD_GEOMETRY.landmarks && ROAD_GEOMETRY.landmarks.jrr;
    if (venue) {
      L.marker(venue.latLng, { icon: venueIcon(), keyboard: false, zIndexOffset: 1000 })
        .bindTooltip(`<strong>You are here</strong><br>${venue.name}`, { permanent: true, direction: "right", offset: [12, 0], className: "venue-label" })
        .addTo(map);
      allPoints.push(venue.latLng);
    }

    carLayer = L.layerGroup().addTo(map);
    map.fitBounds(L.latLngBounds(allPoints), { padding: [30, 30] });
    updateCarScale();
    map.on("zoomend", updateCarScale);
    ready = true;
    requestAnimationFrame(animate);
    return true;
  }

  // ---- Update from state + results ----
  function render(ctx) {
    if (!ready) return;
    const { state, selected, roadResult, colorKey } = ctx;
    for (const [id, layers] of Object.entries(roadLayers)) {
      const after = roadResult("scenario", id), before = roadResult("baseline", id);
      const closed = state.closed.has(id);
      const lanes = state.lanes[id] || 0;
      const width = BASE_WIDTH + lanes * LANE_WIDTH;
      layers.line.setStyle({ color: COLORS[colorKey(after)], weight: width, dashArray: closed ? "6 10" : null });
      layers.casing.setStyle({ weight: width + 4, opacity: closed ? 0.5 : 0.9 });
      const isSel = selected && selected.type === "road" && selected.id === id;
      layers.halo.setStyle({ opacity: isSel ? 0.45 : 0, weight: width + 14 });
      if (closed) layers.xMarker.addTo(map); else layers.xMarker.remove();

      let text = "";
      if (after && before && !after.closed && after.carTrips > 0) {
        const diff = after.carTrips - before.carTrips;
        text = `${after.carTrips}` + (diff ? ` (${diff > 0 ? "+" : ""}${diff})` : "");
      }
      if (lanes && !closed) text += `${text ? " · " : ""}+${lanes} lane${lanes > 1 ? "s" : ""}`;
      const el = layers.badge.getElement();
      if (el) {
        el.firstChild.textContent = text;
        el.style.display = text ? "" : "none";
      }
    }
    for (const [id, n] of Object.entries(nodeLayers)) {
      const isSel = selected && selected.type === "node" && selected.id === id;
      n.ring.setStyle({ fillColor: isSel ? "#ffe2c4" : "#ffffff", weight: isSel ? 4 : (n.can ? 3 : 2) });
      if (state.signals.has(id)) n.signal.addTo(map); else n.signal.remove();
    }
    if (state.busEnabled) busLayer.addTo(map); else busLayer.remove();
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
    for (const road of result.scenario.roads) {
      const layers = roadLayers[road.id];
      if (!layers || road.closed || !road.carTrips || !road.travelMinutes) continue;
      const { path } = layers;
      const count = Math.max(1, Math.min(10, Math.round(road.carTrips * path.length / 14000)));
      const speed = 55 / Math.max(road.travelMinutes / freeFlow, 1); // visual meters per second
      for (let i = 0; i < count; i++) {
        const s = (i + 0.5) / count * path.length;
        const p = pointAt(path, s);
        const marker = L.marker(p.latLng, {
          pane: "cars", icon: carIcon(CAR_COLORS[colorIndex++ % CAR_COLORS.length]), interactive: false, keyboard: false
        }).addTo(carLayer);
        cars.push({ marker, path, s, speed, rot: null });
      }
    }
  }

  function animate(time) {
    const dt = lastFrame === null ? 0 : Math.min((time - lastFrame) / 1000, 0.1);
    lastFrame = time;
    if (map && !document.getElementById("street-view").hidden) {
      for (const car of cars) {
        car.s = (car.s + car.speed * dt) % car.path.length;
        const p = pointAt(car.path, car.s);
        car.marker.setLatLng(p.latLng);
        const el = car.marker.getElement();
        if (!car.rot && el) car.rot = el.firstChild;
        if (car.rot) car.rot.style.transform = `rotate(${p.heading}deg) scale(${carScale})`;
      }
    }
    requestAnimationFrame(animate);
  }

  return {
    init, render, rebuildCars,
    isReady: () => ready,
    missing: () => missingGeometry,
    refreshSize: () => { if (map) map.invalidateSize(); }
  };
})();
