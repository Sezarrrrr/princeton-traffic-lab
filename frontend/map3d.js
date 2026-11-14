// 3D view: MapLibre GL JS with OpenFreeMap vector tiles (3D buildings), the simulation roads drawn
// on top, and small 3D cars (extruded boxes) driving along them. Loaded only when "3D" is first
// opened, so the rest of the page works without it. Same data and handlers as street-map.js.
const Map3D = (() => {
  const LIB = {
    js: { src: "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js", integrity: "sha384-SYKAG6cglRMN0RVvhNeBY0r3FYKNOJtznwA0v7B5Vp9tr31xAHsZC0DqkQ/pZDmj" },
    css: { href: "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css", integrity: "sha384-MinO0mNliZ3vwppuPOUnGa+iq619pfMhLVUXfC4LHwSCvF9H+6P/KO4Q7qBOYV5V" }
  };
  // OpenFreeMap "Liberty" style: OpenMapTiles vector tiles with 3D buildings (attribution shown on the map).
  const STYLE = "https://tiles.openfreemap.org/styles/liberty";
  const COLORS = { free: "#2e9e5b", busy: "#e0a100", jam: "#d0342c", closed: "#9aa1ad", empty: "#a9b0bb", nocar: "#c3c8d0", route: "#7b3fd1", accent: "#e77500", bus: "#2f6fdb" };
  const CAR_COLORS = ["#ffffff", "#e8e8e8", "#2b2f38", "#3a6fd8", "#c8372d", "#8a929e", "#e9c46a"];
  const CAR = { length: 5.2, width: 2.3, height: 1.8 };  // a little larger than life so they read at street zoom
  const SIDE = 2.2;          // cars drive this many meters right of the centerline
  const CLASS_WIDTH = { primary: 7, secondary: 6, tertiary: 5 };

  let map = null, ready = false, loading = null, failed = false;
  let network = null, handlers = {}, lab = false;
  let lastCtx = null, lastCars = null, carsOn = true;
  let cars = [], lastFrame = null, frameSkip = 0;
  const markers = { places: [], trips: [], key: "" };
  let hoverPopup = null;

  // ---- Load MapLibre on demand ----
  function loadLib() {
    if (window.maplibregl) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const css = document.createElement("link");
      Object.assign(css, { rel: "stylesheet", href: LIB.css.href, integrity: LIB.css.integrity, crossOrigin: "anonymous" });
      document.head.append(css);
      const s = document.createElement("script");
      Object.assign(s, { src: LIB.js.src, integrity: LIB.js.integrity, crossOrigin: "anonymous" });
      s.onload = resolve;
      s.onerror = () => reject(new Error("The 3D map library couldn't load (no internet?)."));
      document.head.append(s);
    });
  }

  // ---- Geometry helpers ----
  const R = 6371000;
  function meters(a, b) {
    const lat = ((a[0] + b[0]) / 2) * Math.PI / 180;
    return Math.hypot((b[1] - a[1]) * Math.PI / 180 * Math.cos(lat) * R, (b[0] - a[0]) * Math.PI / 180 * R);
  }
  function measure(points) {
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + meters(points[i - 1], points[i]));
    return { points, cum, length: cum[cum.length - 1] };
  }
  function pointAt(path, s) {
    const { points, cum } = path;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    const t = Math.min(Math.max((s - cum[i - 1]) / seg, 0), 1);
    const a = points[i - 1], b = points[i];
    const lat = a[0] * Math.PI / 180;
    const dx = (b[1] - a[1]) * Math.cos(lat), dy = b[0] - a[0];
    const len = Math.hypot(dx, dy) || 1;
    return { ll: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], ux: dx / len, uy: dy / len };
  }
  // Car footprint: a rectangle centred SIDE meters right of the path, pointing along it. [lon, lat] ring.
  function carPolygon(p) {
    const lat = p.ll[0] * Math.PI / 180;
    const mLat = 1 / 111320, mLon = 1 / (111320 * Math.cos(lat));
    const rx = p.uy, ry = -p.ux; // right-hand normal (east, north)
    const cx = p.ll[1] + rx * SIDE * mLon, cy = p.ll[0] + ry * SIDE * mLat;
    const hl = CAR.length / 2, hw = CAR.width / 2;
    const corner = (f, s) => [cx + (p.ux * f + rx * s) * mLon, cy + (p.uy * f + ry * s) * mLat];
    const ring = [corner(hl, hw), corner(hl, -hw), corner(-hl, -hw), corner(-hl, hw)];
    ring.push(ring[0]);
    return ring;
  }
  const lonLat = ll => [ll[1], ll[0]];

  // ---- Icons drawn on canvas (signal, stop, all-way stop, roundabout) ----
  function iconImage(type) {
    const size = 40, c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    if (type === "signal") {
      g.fillStyle = "#2b2f38"; g.beginPath(); g.roundRect(12, 1, 16, 38, 4); g.fill();
      [["#ff5a4f", 9], ["#6b5a1e", 20], ["#3ddc84", 31]].forEach(([col, y]) => { g.fillStyle = col; g.beginPath(); g.arc(20, y, 4.5, 0, 7); g.fill(); });
    } else if (type === "roundabout") {
      g.fillStyle = "#2f6fdb"; g.beginPath(); g.arc(20, 20, 17, 0, 7); g.fill();
      g.strokeStyle = "#fff"; g.lineWidth = 3.5; g.beginPath(); g.arc(20, 20, 9, 0.6, 5.6); g.stroke();
    } else {
      g.fillStyle = "#c8102e"; g.strokeStyle = "#fff"; g.lineWidth = 2.5; g.beginPath();
      for (let k = 0; k < 8; k++) { const a = Math.PI / 8 + k * Math.PI / 4; g.lineTo(20 + 17 * Math.cos(a), 20 + 17 * Math.sin(a)); }
      g.closePath(); g.fill(); g.stroke();
      g.fillStyle = "#fff";
      if (type === "stop_all") { g.font = "bold 12px system-ui, sans-serif"; g.textAlign = "center"; g.fillText("ALL", 20, 24.5); }
      else g.fillRect(10, 17.5, 20, 5);
    }
    return g.getImageData(0, 0, size, size);
  }

  // ---- Setup ----
  async function init(net, h, view) {
    if (ready) return true;
    if (failed) return false;
    if (loading) return loading;
    network = net; handlers = h; lab = !!(net.capabilities && net.capabilities.lab);
    loading = (async () => {
      await loadLib();
      const probe = document.createElement("canvas");
      if (!(probe.getContext("webgl2") || probe.getContext("webgl"))) throw new Error("This browser can't show WebGL (3D) maps.");
      map = new maplibregl.Map({
        container: "map3d", style: STYLE,
        center: view ? [view.lng, view.lat] : [-74.6565, 40.3465], zoom: view ? Math.max(view.zoom - 1, 13) : 15.2,
        pitch: 58, bearing: -28, maxPitch: 75, antialias: true, attributionControl: { compact: false }
      });
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-left");
      // Wait for the style (not every tile), so a slow connection or a background tab doesn't block it.
      await new Promise((resolve, reject) => {
        if (map.isStyleLoaded()) return resolve();
        const timer = setTimeout(() => reject(new Error("The 3D map style didn't load in time (no internet?).")), 20000);
        map.once("style.load", () => { clearTimeout(timer); resolve(); });
        map.once("error", () => { if (!map.isStyleLoaded()) { clearTimeout(timer); reject(new Error("The 3D map style couldn't load.")); } });
      });
      addLayers();
      ready = true;
      if (lastCtx) render(lastCtx);
      if (lastCars) rebuildCars(lastCars.result, lastCars.enabled);
      requestAnimationFrame(animate);
      return true;
    })().catch(err => { failed = true; loading = null; throw err; });
    return loading;
  }

  function addLayers() {
    for (const t of ["signal", "stop_all", "stop_minor", "roundabout"]) map.addImage(`ctl-${t}`, iconImage(t), { pixelRatio: 2 });
    const empty = { type: "FeatureCollection", features: [] };
    for (const id of ["sim-roads", "sim-route", "sim-route-before", "sim-nodes", "sim-cars", "sim-bus"]) map.addSource(id, { type: "geojson", data: empty });
    const before = map.getLayer("building-3d") ? "building-3d" : undefined;
    const w = mult => ["interpolate", ["exponential", 1.6], ["zoom"], 12, ["*", ["get", "w"], 0.25 * mult], 15, ["*", ["get", "w"], 0.8 * mult], 18, ["*", ["get", "w"], 2.6 * mult]];
    map.addLayer({ id: "sim-road-halo", type: "line", source: "sim-roads", filter: ["==", ["get", "sel"], true],
      paint: { "line-color": COLORS.accent, "line-opacity": 0.5, "line-width": ["+", w(1), 10] }, layout: { "line-cap": "round", "line-join": "round" } }, before);
    map.addLayer({ id: "sim-road-casing", type: "line", source: "sim-roads",
      paint: { "line-color": "#ffffff", "line-opacity": 0.9, "line-width": ["+", w(1), 2.5] }, layout: { "line-cap": "round", "line-join": "round" } }, before);
    map.addLayer({ id: "sim-road-line", type: "line", source: "sim-roads", filter: ["!=", ["get", "dash"], true],
      paint: { "line-color": ["get", "color"], "line-width": w(1) }, layout: { "line-cap": "round", "line-join": "round" } }, before);
    map.addLayer({ id: "sim-road-dash", type: "line", source: "sim-roads", filter: ["==", ["get", "dash"], true],
      paint: { "line-color": ["get", "color"], "line-width": w(1), "line-dasharray": [1.2, 1.4] } }, before);
    map.addLayer({ id: "sim-bus", type: "line", source: "sim-bus",
      paint: { "line-color": COLORS.bus, "line-width": 3, "line-dasharray": [0.5, 2] }, layout: { "line-cap": "round" } }, before);
    map.addLayer({ id: "sim-route-before", type: "line", source: "sim-route-before",
      paint: { "line-color": "#1d2330", "line-width": 3, "line-opacity": 0.75, "line-dasharray": [2, 2] } }, before);
    map.addLayer({ id: "sim-route", type: "line", source: "sim-route",
      paint: { "line-color": COLORS.route, "line-width": ["interpolate", ["linear"], ["zoom"], 13, 3, 17, 7], "line-opacity": 0.95 }, layout: { "line-cap": "round", "line-join": "round" } }, before);
    map.addLayer({ id: "sim-road-hit", type: "line", source: "sim-roads", paint: { "line-color": "#000", "line-opacity": 0.01, "line-width": 18 } });
    map.addLayer({ id: "sim-nodes", type: "circle", source: "sim-nodes",
      filter: ["any", ["==", ["get", "minor"], false], [">=", ["zoom"], 15.5]],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 2.5, 16, 5, 18, 8],
        "circle-color": ["case", ["==", ["get", "sel"], true], "#ffe2c4", "#ffffff"],
        "circle-stroke-color": "#1d2330", "circle-stroke-width": ["case", ["==", ["get", "sel"], true], 3, 1.5]
      } });
    map.addLayer({ id: "sim-cars", type: "fill-extrusion", source: "sim-cars",
      paint: { "fill-extrusion-color": ["get", "color"], "fill-extrusion-height": CAR.height, "fill-extrusion-base": 0.15, "fill-extrusion-opacity": 0.95 } });
    map.addLayer({ id: "sim-controls", type: "symbol", source: "sim-nodes",
      filter: ["all", ["!=", ["get", "ctl"], "none"], ["any", ["==", ["get", "ctl"], "signal"], [">=", ["zoom"], 15.8]]],
      layout: { "icon-image": ["concat", "ctl-", ["get", "ctl"]], "icon-size": ["interpolate", ["linear"], ["zoom"], 14, 0.55, 17, 0.9],
        "icon-offset": [16, -18], "icon-allow-overlap": true, "icon-ignore-placement": true } });

    map.on("click", e => {
      const hit = map.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: ["sim-nodes", "sim-road-hit"] });
      const node = hit.find(f => f.layer.id === "sim-nodes"), road = hit.find(f => f.layer.id === "sim-road-hit");
      const ll = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      if (node) handlers.onSelectNode(node.properties.id);
      else if (road) handlers.onSelectRoad(road.properties.id, ll);
      else if (handlers.onMapClick) handlers.onMapClick(ll);
    });
    hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "map3d-tip", offset: 10 });
    const hover = e => {
      const f = e.features && e.features[0];
      if (!f) return;
      map.getCanvas().style.cursor = map.getCanvasContainer().classList.contains("picking") ? "crosshair" : "pointer";
      hoverPopup.setLngLat(e.lngLat).setText(f.properties.name).addTo(map);
    };
    const leave = () => { map.getCanvas().style.cursor = ""; hoverPopup.remove(); };
    for (const layer of ["sim-road-hit", "sim-nodes"]) { map.on("mousemove", layer, hover); map.on("mouseleave", layer, leave); }

    // "You are here"
    const venue = ROAD_GEOMETRY.landmarks && ROAD_GEOMETRY.landmarks.jrr;
    if (venue) {
      const el = document.createElement("div");
      el.className = "venue3d";
      el.innerHTML = `<div class="venue-pin"><span class="venue-dot"></span></div><div class="venue3d-label"><strong>You are here</strong><br>${venue.name}</div>`;
      new maplibregl.Marker({ element: el, anchor: "left", offset: [-13, 0] }).setLngLat(lonLat(venue.latLng)).addTo(map);
    }
  }

  // ---- Update from state + results ----
  function render(ctx) {
    lastCtx = ctx;
    if (!ready) return;
    const { state, selected, roadResult, colorKey } = ctx;
    const feats = [];
    for (const road of network.roads) {
      const pts = ROAD_GEOMETRY.roads[road.id];
      if (!pts) continue;
      const after = roadResult("scenario", road.id);
      const key = colorKey(after);
      const closed = state.closed.has(road.id);
      const lanes = state.lanes[road.id] || 0;
      const base = CLASS_WIDTH[road.highway] || (lab ? 3.5 : 7);
      feats.push({ type: "Feature", properties: {
        id: road.id, name: road.name, color: COLORS[key] || COLORS.empty, w: base + lanes * 3,
        dash: closed || key === "nocar", sel: !!(selected && selected.type === "road" && selected.id === road.id)
      }, geometry: { type: "LineString", coordinates: pts.map(lonLat) } });
    }
    map.getSource("sim-roads").setData({ type: "FeatureCollection", features: feats });

    const nodes = network.intersections.map(n => {
      const ll = ROAD_GEOMETRY.intersections[n.id];
      if (!ll) return null;
      const ctl = ctx.controlOf ? ctx.controlOf(n.id).type : "none";
      return { type: "Feature", properties: {
        id: n.id, name: n.name, ctl, minor: ctl === "none" || ctl === "stop_minor",
        sel: !!(selected && selected.type === "node" && selected.id === n.id)
      }, geometry: { type: "Point", coordinates: lonLat(ll) } };
    }).filter(Boolean);
    map.getSource("sim-nodes").setData({ type: "FeatureCollection", features: nodes });

    const bus = state.busEnabled && network.busRoute ? network.busRoute.roadIds.map(id => ROAD_GEOMETRY.roads[id]).filter(Boolean) : [];
    map.getSource("sim-bus").setData({ type: "FeatureCollection", features: bus.map(p => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: p.map(lonLat) } })) });

    const line = steps => steps.flatMap(s => { const p = ROAD_GEOMETRY.roads[s.roadId] || []; return s.dir === -1 ? [...p].reverse() : p; }).map(lonLat);
    const fc = coords => ({ type: "FeatureCollection", features: coords.length > 1 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } }] : [] });
    map.getSource("sim-route").setData(fc(ctx.route ? line(ctx.route.after) : []));
    map.getSource("sim-route-before").setData(fc(ctx.route ? line(ctx.route.before) : []));

    // Places and trip end points (DOM markers, rebuilt only when they change)
    const sel = ctx.route && ctx.route.trip;
    const key = JSON.stringify([(ctx.places || []).map(p => [p.id, p.name]), (ctx.trips || []).filter(Boolean).map(t => [t.id, t.fromLatLng, t.toLatLng]), sel && sel.id]);
    if (key !== markers.key) {
      markers.key = key;
      for (const m of [...markers.places, ...markers.trips]) m.remove();
      markers.places = (ctx.places || []).map(p => {
        const el = document.createElement("span");
        el.className = `pl ${p.builtIn ? "landmark" : "pin"}`;
        el.title = p.name;
        el.addEventListener("click", ev => { ev.stopPropagation(); if (handlers.onMapClick) handlers.onMapClick({ lat: p.latLng[0], lng: p.latLng[1] }); });
        return new maplibregl.Marker({ element: el }).setLngLat(lonLat(p.latLng)).addTo(map);
      });
      markers.trips = [];
      for (const t of ctx.trips || []) {
        if (!t || !t.fromLatLng || (t.builtIn && !(sel && sel.id === t.id))) continue;
        for (const [ll, cls, text] of [[t.fromLatLng, "a", "A"], [t.toLatLng, "b", "B"]]) {
          const el = document.createElement("span");
          el.className = `tp ${cls}`;
          el.textContent = text;
          el.style.opacity = !sel || sel.id === t.id ? "1" : "0.45";
          markers.trips.push(new maplibregl.Marker({ element: el }).setLngLat(lonLat(ll)).addTo(map));
        }
      }
    }
  }

  // ---- 3D cars ----
  function rebuildCars(result, enabled) {
    lastCars = { result, enabled };
    carsOn = enabled;
    cars = [];
    if (!ready) return;
    if (!result || !enabled) { map.getSource("sim-cars").setData({ type: "FeatureCollection", features: [] }); return; }
    let colorIndex = 0;
    const times = result.baseline.roads.map(r => r.travelMinutes).filter(t => t > 0);
    const freeFlow = times.length ? Math.min(...times) : 1;
    for (const road of result.scenario.roads) {
      const pts = ROAD_GEOMETRY.roads[road.id];
      if (!pts || road.closed || !road.carTrips || !road.travelMinutes) continue;
      const dirs = road.forward !== undefined
        ? [["forward", pts], ["backward", [...pts].reverse()]].map(([k, p]) => road[k] && road[k].cars ? { path: measure(p), cars: road[k].cars, slow: road[k].minutes / Math.max(road[k].freeMinutes, 0.01) } : null).filter(Boolean)
        : [{ path: measure(pts), cars: road.carTrips, slow: road.travelMinutes / freeFlow }];
      for (const d of dirs) {
        const count = Math.min(8, Math.round(d.cars * d.path.length / 9000));
        for (let i = 0; i < count; i++) cars.push({ path: d.path, s: (i + 0.5) / count * d.path.length, speed: 18 / Math.max(d.slow, 1), color: CAR_COLORS[colorIndex++ % CAR_COLORS.length] });
      }
    }
  }

  // Move every car dt seconds along its road and redraw the car layer.
  function stepCars(dt) {
    const feats = cars.map(c => {
      c.s = (c.s + c.speed * dt) % c.path.length;
      return { type: "Feature", properties: { color: c.color }, geometry: { type: "Polygon", coordinates: [carPolygon(pointAt(c.path, c.s))] } };
    });
    map.getSource("sim-cars").setData({ type: "FeatureCollection", features: feats });
    return feats.length;
  }

  function animate(time) {
    const dt = lastFrame === null ? 0 : Math.min((time - lastFrame) / 1000, 0.1);
    lastFrame = time;
    const visible = ready && !document.getElementById("map3d-view").hidden;
    // Every second frame is enough for small cars and keeps the GeoJSON updates cheap.
    if (visible && carsOn && cars.length && (frameSkip = (frameSkip + 1) % 2) === 0) stepCars(dt * 2);
    requestAnimationFrame(animate);
  }

  return {
    init, render, rebuildCars,
    isReady: () => ready,
    hasFailed: () => failed,
    setPicking: on => { if (map) map.getCanvasContainer().classList.toggle("picking", on); },
    refreshSize: () => { if (map) map.resize(); },
    getView: () => (map ? { lat: map.getCenter().lat, lng: map.getCenter().lng, zoom: map.getZoom() + 1 } : null),
    // Leaflet zoom z looks like MapLibre zoom z - 1; open a little closer so the buildings read as 3D.
    setView: v => { if (map && v) map.jumpTo({ center: [v.lng, v.lat], zoom: Math.max(v.zoom - 0.6, 15.2) }); },
    map: () => map,                                   // for debugging in the console
    stepCars: dt => (ready && carsOn ? stepCars(dt) : 0) // for debugging in the console
  };
})();
