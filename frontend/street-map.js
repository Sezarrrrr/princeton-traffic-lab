// Street-map view: Leaflet + OpenStreetMap tiles, with the simulation roads drawn on the real
// street geometry from geo/princeton-geo.js (keyed by the shared road IDs).
// The simulation numbers still come only from the API; this file just draws them.

const StreetMap = (() => {
  // ?tiles=test-fail points at a bad tile address, to rehearse the schematic fallback before the demo.
  const TILE_URL = new URLSearchParams(location.search).get("tiles") === "test-fail"
    ? "http://127.0.0.1:9/{z}/{x}/{y}.png"
    : "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const COLORS = { faster: "#19834d", slower: "#c53b32", unchanged: "#526778", closed: "#9aa1ad", empty: "#a9b0bb", accent: "#e77500" };
  const CAR_COLORS = ["#ffffff", "#f2f2f2", "#2b2f38", "#3a6fd8", "#c8372d", "#8a929e", "#e9c46a"];
  const KM_PER_MILE = 1.609344;
  const playbackRate = 3;

  let map = null;
  let initialBounds = null;
  let ready = false;
  const endpointPositions = new Map();
  const endpointPins = new Map();
  let importedRoads = [], importedHighlights, importedStyleKey;
  const importedBounds = new Map();
  let coverageCircle, customLayer, previewLayer, lanePreview, speedEditsLayer, laneLabelsLayer;
  let laneLabelsKey;
  let speedEditsKey;
  let lookupRoads, lookupPoints, pointHandlers;
  let intersections = [], pickPoints = [], pickLayer, pickTooltip;
  const customPaths = new Map();

  const importedSignals = new Map();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let vehicleLayer = null, zoomFrame = null;
  let cars = [];
  let lastFrame = null;
  let missingGeometry = [];


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
  function vehicleLegSeconds(distanceMeters, roadResult, road, forward) {
    const direction = forward ? "forward" : "backward";
    const simulated = roadResult?.directions ? roadResult.directions[direction] : roadResult;
    const limitKph = (simulated?.speedLimitMph ?? road.speedLimits?.[direction]?.mph ?? 25) * KM_PER_MILE;
    const minutes = simulated?.travelMinutes ?? 0;
    const minimumSeconds = distanceMeters * 3.6 / limitKph;
    return Math.max(minutes * 60, minimumSeconds);
  }

  function signalStops(signals) {
    return new Map((signals || []).map(signal => [signal.intersectionId, {
      ...signal, phases: new Map(signal.approaches.map(approach => [approach.roadId, approach.phase]))
    }]));
  }

  function redLightSeconds(signals, node, road, elapsed) {
    const signal = signals.get(node);
    const phase = signal?.phases.get(road.parentId ?? road.id);
    if (!phase || !signal.cycleSeconds) return 0;
    const mainGreen = signal.cycleSeconds * signal.mainGreenShare;
    const position = elapsed % signal.cycleSeconds;
    return phase === "main" ? (position < mainGreen ? 0 : signal.cycleSeconds - position)
      : Math.max(0, mainGreen - position);
  }

  function roadDistance(road) {
    const points = road.geometry || ROAD_GEOMETRY.roads[road.id];
    return points ? measure(points).length : 0;
  }
  function pointAt(path, s) { // position and heading at distance s along the path
    const { points, cum } = path;
    let lo = 1, hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid + 1;
      else hi = mid;
    }
    const i = lo;
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
  const busIcon = color => L.divIcon({
    className: "car-icon bus-icon",
    html: `<div class="car-rot"><svg width="14" height="26" viewBox="0 0 14 26" aria-hidden="true">
      <rect x="1" y="1" width="12" height="24" rx="3" fill="${color}" stroke="#fff" stroke-width="1.5"/>
      <rect x="3" y="4" width="8" height="5" rx="1" fill="#fff"/>
      <path d="M3 12h8M3 16h8M3 20h8" stroke="#fff" stroke-width="1.5"/>
    </svg></div>`,
    iconSize: [14, 26], iconAnchor: [7, 13]
  });
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
  // ---- Setup ----
  function init(network, junctions, handlers, onTilesFailed) {
    if (typeof L === "undefined") return false;
    const pointById = new Map([...network.intersections, ...(network.streetPicks || [])].map(node => [node.id, node]));
    const roads = network.roads.map(road => ({ ...road, geometry: road.geometry || ROAD_GEOMETRY.roads[road.id] }));
    lookupRoads = new Map([...roads, ...(network.pickRoads || [])].map(road => [road.id, road]));
    lookupPoints = pointById;
    pointHandlers = handlers;
    importedRoads = roads.filter(road => road.geometry?.length >= 2);
    intersections = network.intersections;
    pickPoints = junctions.filter(point => point.latLng || ROAD_GEOMETRY.intersections[point.id])
      .map(point => ({ ...point, latLng: point.latLng || ROAD_GEOMETRY.intersections[point.id] }));
    const position = point => point.latLng || ROAD_GEOMETRY.intersections[point.id];


    map = L.map("leaflet-map", { zoomSnap: 0.25, zoomDelta: 0.5, scrollWheelZoom: true, preferCanvas: false });
    for (const road of importedRoads) importedBounds.set(road.id, L.latLngBounds(road.geometry));
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
    const speedPane = map.createPane("speed-edits");
    speedPane.style.zIndex = 400;
    speedPane.style.pointerEvents = "none";
    const roadPane = map.createPane("roads"); roadPane.style.zIndex = 410;
    const carPane = map.createPane("cars"); carPane.style.zIndex = 620; carPane.style.pointerEvents = "none";
    const labelPane = map.createPane("labels"); labelPane.style.zIndex = 630; labelPane.style.pointerEvents = "none";

    customLayer = L.layerGroup().addTo(map);
    previewLayer = L.layerGroup().addTo(map);
    lanePreview = L.layerGroup().addTo(map);
    speedEditsLayer = L.layerGroup().addTo(map);
    laneLabelsLayer = L.layerGroup().addTo(map);
    if (network.coverage) {
      const { center, radiusMeters } = network.coverage;
      coverageCircle = L.circle(center, { radius: radiusMeters, color: "#3c6596", weight: 2,
        dashArray: "6 7", fillOpacity: 0.025, interactive: false }).addTo(map);
    }
    const pane = map.createPane("imported-roads");
    pane.style.zIndex = 380;
    pane.style.pointerEvents = "none";
    addImportedTiles("imported-roads", network.streetStretches || importedRoads.map(road => road.geometry));
    const pickPane = map.createPane("road-picks");
    pickPane.style.zIndex = 450;
    pickPane.style.pointerEvents = "none";
    pickLayer = addImportedTiles("road-picks", pickPoints.map(point => [point.latLng]), true);
    pickTooltip = L.tooltip({ direction: "top", offset: [0, -4] });
    const hidePickLabel = () => pickTooltip.remove();
    map.on("mousemove", event => {
      if (!map.hasLayer(pickLayer)) return;
      const pick = nearestJunction(event.containerPoint, 9);
      if (!pick) { hidePickLabel(); return; }
      const label = document.createElement("span");
      label.textContent = pick.name;
      pickTooltip.setLatLng(pick.latLng).setContent(label).addTo(map);
    });
    map.on("mouseout movestart", hidePickLabel);
    importedHighlights = L.layerGroup().addTo(map);
    map.on("click", event => pickImported(event, handlers));
    missingGeometry = roads.filter(road => !road.geometry?.length).map(road => road.id);
    for (const node of pointById.values()) {
      const ll = position(node);
      if (!ll) continue;
      endpointPositions.set(node.id, ll);
      if (!node.imported && !node.roadId) allPoints.push(ll);
    }

    for (const place of (network.locations || [])) {
      const coordinates = place.latLng || position(pointById.get(place.nodeId));
      endpointPositions.set(place.id, coordinates);
      const icon = place.venue ? venueIcon() : L.divIcon({
        className: "landmark-icon", html: "<span></span>", iconSize: [14, 14], iconAnchor: [7, 7]
      });
      L.marker(coordinates, { icon, title: place.name, alt: place.name })
        .bindTooltip(place.venue ? `You are here · ${place.name}` : place.name,
          { permanent: !!place.venue, direction: "right", offset: [12, 0], className: place.venue ? "venue-label" : "" })
        .on("click", () => handlers.onSelectEndpoint(place.id)).addTo(map);
      allPoints.push(coordinates);
    }

    vehicleLayer = L.DomUtil.create("div", "vehicle-layer leaflet-zoom-animated", carPane);
    map.on("zoomanim", ({ center, zoom }) => {
      // Keep advancing vehicles in the old map coordinates while their shared
      // layer follows the same CSS zoom transition as Leaflet's tile levels.
      zoomFrame ??= { zoom: map.getZoom(), origin: map.getPixelOrigin() };
      const origin = map.unproject(zoomFrame.origin, zoomFrame.zoom);
      L.DomUtil.setTransform(vehicleLayer, map._latLngToNewLayerPoint(origin, zoom, center),
        map.getZoomScale(zoom, zoomFrame.zoom));
    });
    map.on("zoomend viewreset", () => {
      zoomFrame = null;
      L.DomUtil.setTransform(vehicleLayer, L.point(0, 0));
      paintVehicles();
    });
    initialBounds = allPoints.length ? L.latLngBounds(allPoints) : coverageCircle.getBounds();
    map.fitBounds(initialBounds, { padding: [30, 30] });
    // The destination toolbar can wrap after its controls are populated.
    new ResizeObserver(() => {
      if (!document.getElementById("street-view").hidden) map.invalidateSize({ pan: false });
    }).observe(map.getContainer());

    ready = true;
    requestAnimationFrame(animate);
    return true;
  }

  function addImportedTiles(pane, shapes, pointsOnly = false) {
    // Index projected vertices once in fixed-size buckets at zoom 12.
    // Leaflet requests only visible tiles, then transforms the completed
    // tile levels during zoom and translates their pane during pan.
    const indexZoom = 12, tileSize = 256;
    const cells = new Map();
    const index = (bounds, feature) => {
      for (let y = Math.floor(bounds.min.y / tileSize); y <= Math.floor(bounds.max.y / tileSize); y++) {
        for (let x = Math.floor(bounds.min.x / tileSize); x <= Math.floor(bounds.max.x / tileSize); x++) {
          const key = `${x}:${y}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(feature);
        }
      }
    };
    for (const shape of shapes) {
      const points = shape.map(point => map.project(point, indexZoom));
      const bounds = L.bounds(points);
      index(bounds, { points, bounds });
    }
    const tiles = L.gridLayer({ pane, maxNativeZoom: 19, keepBuffer: 2,
      updateWhenIdle: true, updateWhenZooming: false, noWrap: true });
    tiles.createTile = coords => {
      const tile = document.createElement("canvas");
      tile.className = pointsOnly ? "road-pick-tile" : "imported-road-tile";
      tile.setAttribute("aria-hidden", "true");
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      tile.width = tile.height = tileSize * ratio;
      const ctx = tile.getContext("2d");
      const scale = map.getZoomScale(coords.z, indexZoom);
      const left = coords.x * tileSize, top = coords.y * tileSize;
      const bounds = L.bounds([(left - 3) / scale, (top - 3) / scale],
        [(left + tileSize + 3) / scale, (top + tileSize + 3) / scale]);
      const features = new Set();
      for (let y = Math.floor(bounds.min.y / tileSize); y <= Math.floor(bounds.max.y / tileSize); y++) {
        for (let x = Math.floor(bounds.min.x / tileSize); x <= Math.floor(bounds.max.x / tileSize); x++) {
          for (const feature of cells.get(`${x}:${y}`) || []) features.add(feature);
        }
      }
      ctx.scale(ratio, ratio);
      ctx.beginPath();
      for (const { points, bounds: featureBounds } of features) {
        if (!bounds.intersects(featureBounds)) continue;
        const x = points[0].x * scale - left, y = points[0].y * scale - top;
        if (pointsOnly) {
          const radius = coords.z < 14 ? 1.25 : 3;
          ctx.moveTo(x + radius, y);
          ctx.arc(x, y, radius, 0, Math.PI * 2);
        } else {
          ctx.moveTo(x, y);
          for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x * scale - left, points[i].y * scale - top);
        }
      }
      if (pointsOnly) {
        ctx.fillStyle = "#ffcf91";
        ctx.strokeStyle = "#a95622";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fill();
      } else {
        ctx.strokeStyle = "#6e8197";
        ctx.lineWidth = coords.z < 13 ? 0.85 : 2;
        ctx.lineCap = ctx.lineJoin = "round";
        ctx.stroke();
      }
      return tile;
    };
    if (!pointsOnly) tiles.addTo(map);
    return tiles;
  }

  function nearestJunction(point, radius) {
    const area = map.getBounds().pad(0.02);
    let best = radius, closest = null;
    for (const pick of pickPoints) {
      if (!area.contains(pick.latLng)) continue;
      const distance = map.latLngToContainerPoint(pick.latLng).distanceTo(point);
      if (distance < best) { best = distance; closest = pick; }
    }
    return closest;
  }

  function pickImported(event, handlers) {
    if (!importedRoads.length) return;
    const point = event.containerPoint;
    const picking = handlers.picking();
    if (picking) {
      const junction = nearestJunction(point, 9);
      if (junction) handlers.onSelectEndpoint(junction.id);
      return;
    }
    let best = 6, closest = null;
    for (const node of handlers.pickingRoad() ? [] : intersections) {
      const ll = endpointPositions.get(node.id);
      if (!ll) continue;
      const distance = map.latLngToContainerPoint(ll).distanceTo(point);
      if (distance < best) { best = distance; closest = node; }
    }
    if (closest) { handlers.onSelectNode(closest.id); return; }
    best = 10;
    const area = L.latLngBounds(map.containerPointToLatLng(point.subtract([12, 12])),
      map.containerPointToLatLng(point.add([12, 12])));
    for (const road of importedRoads) {
      if (!area.intersects(importedBounds.get(road.id))) continue;
      const points = road.geometry.map(p => map.latLngToContainerPoint(p));
      for (let i = 1; i < points.length; i++) {
        const distance = L.LineUtil.pointToSegmentDistance(point, points[i - 1], points[i]);
        if (distance < best) { best = distance; closest = road; }
      }
    }
    if (closest) {
      const start = map.latLngToContainerPoint(lookupPoints.get(closest.from).latLng);
      const end = map.latLngToContainerPoint(lookupPoints.get(closest.to).latLng);
      handlers.onSelectRoad(closest.id, point.distanceTo(start) <= point.distanceTo(end) ? closest.from : closest.to);
    }
  }

  function busPoint(layer, point, color, label, name) {
    const coordinates = endpointPositions.get(point.endpointId);
    if (!coordinates) return;
    const icon = L.divIcon({ className: point.stop ? "shuttle-stop custom-shuttle-stop" : "custom-waypoint",
      html: `<span style="background:${color}">${label}</span>`, iconSize: [16, 16], iconAnchor: [8, 20] });
    L.marker(coordinates, { icon, title: name, alt: name })
      .on("click", () => pointHandlers.onSelectEndpoint(point.endpointId)).addTo(layer);
  }

  function previewBus(points, legs, color) {
    if (!previewLayer) return;
    previewLayer.clearLayers();
    for (const id of legs.flatMap(leg => leg.roadIds)) {
      L.polyline(lookupRoads.get(id).geometry, { color, weight: 6,
        dashArray: "5 6", interactive: false, className: "bus-preview-path" }).addTo(previewLayer);
    }
    points.forEach((point, index) => busPoint(previewLayer, point, color,
      index + 1, `Bus stop ${index + 1}`));
  }

  function renderSpeedEdits(edits) {
    const key = JSON.stringify(edits);
    if (key === speedEditsKey) return;
    speedEditsKey = key;
    speedEditsLayer.clearLayers();
    for (const edit of edits) {
      const roads = edit.roadIds.map(id => lookupRoads.get(id));
      if (!roads.length || roads.some(road => !road?.geometry)) continue;

      // A preview can return the reverse traversal for a one-way street.
      // Join the ordered geometry from whichever boundary starts that traversal.
      let node = lookupPoints.has(edit.startNodeId) &&
        [roads[0].from, roads[0].to].includes(edit.startNodeId)
        ? edit.startNodeId : edit.endNodeId;
      const points = roads.flatMap((road, index) => {
        const forward = road.from === node;
        node = forward ? road.to : road.from;
        return (forward ? road.geometry : [...road.geometry].reverse()).slice(index ? 1 : 0);
      });
      const path = measure(points);
      if (!path.length) continue;
      L.polyline(points, { pane: "speed-edits", className: "speed-edit-stretch", color: "#6943a0",
        weight: 10, opacity: 0.7, dashArray: "6 4", interactive: false }).addTo(speedEditsLayer);

      for (const [id, label] of [[edit.startNodeId, "Start"], [edit.endNodeId, "End"]]) {
        const coordinates = endpointPositions.get(id);
        if (!coordinates) continue;
        L.marker(coordinates, {
          title: `${label} of speed edit`, interactive: false, keyboard: false,
          icon: L.divIcon({ className: "speed-edit-endpoint", html: label[0],
            iconSize: [20, 20], iconAnchor: [10, 20] })
        }).addTo(speedEditsLayer);
      }

      const title = `${edit.speedLimitMph} mph on ${edit.street}`;
      const details = document.createElement("div");
      details.className = "speed-edit-details";
      const heading = document.createElement("strong");
      heading.textContent = edit.street;
      details.append(heading);
      for (const line of [
        `Start · ${edit.startName}`,
        `End · ${edit.endName}`,
        `Previous limit · ${edit.previousLimits.length ? edit.previousLimits.join(", ") + " mph" : "Pending simulation"}`,
        `New limit · ${edit.speedLimitMph} mph`
      ]) {
        const row = document.createElement("div");
        row.textContent = line;
        details.append(row);
      }
      L.marker(pointAt(path, path.length / 2).latLng, {
        title, alt: title, zIndexOffset: 200,
        icon: L.divIcon({ className: "speed-edit-sign", html: `<span>${edit.speedLimitMph}</span><small>mph</small>`,
          iconSize: [32, 36], iconAnchor: [16, 42] })
      }).bindPopup(details).addTo(speedEditsLayer);
    }
  }

  // ---- Update from state + results ----
  function render(ctx) {
    if (!ready) return;
    const { state, selected, colorKey, routeIds, trafficIds, focusedBusId, customRoutes, busServices, speedEdits, laneEdits } = ctx;
    renderSpeedEdits(speedEdits);
    const labelKey = JSON.stringify(laneEdits.labels);
    if (labelKey !== laneLabelsKey) {
      laneLabelsKey = labelKey;
      laneLabelsLayer.clearLayers();
      for (const { roadIds, text } of laneEdits.labels) {
        const paths = roadIds.map(id => lookupRoads.get(id)?.geometry).filter(Boolean).map(measure);
        let distance = paths.reduce((total, path) => total + path.length, 0) / 2;
        for (const path of paths) {
          if (distance > path.length) { distance -= path.length; continue; }
          if (path.length) L.tooltip({ permanent: true, direction: "center", className: "lane-count-label" })
            .setLatLng(pointAt(path, distance).latLng).setContent(text).addTo(laneLabelsLayer);
          break;
        }
      }
    }
    if (importedHighlights) {
      const styled = [];
      for (const id of new Set([...routeIds, ...trafficIds, ...laneEdits.counts.keys(), selected?.id])) {
        if (!lookupRoads.has(id)) continue;
        const key = colorKey(id);
        const lanes = laneEdits.counts.get(id) || 0;
        if (key === "empty" && selected?.id !== id && !routeIds.has(id) && !lanes) continue;
        styled.push([id, key, routeIds.has(id), selected?.id === id, lanes]);
      }
      const styleKey = JSON.stringify(styled);
      if (styleKey !== importedStyleKey) {
        importedStyleKey = styleKey;
        importedHighlights.clearLayers();
        const opts = { pane: "roads", interactive: false, lineCap: "round", lineJoin: "round" };
        for (const [id, , onRoute, isSelected] of styled) {
          if (onRoute || isSelected) {
            L.polyline(lookupRoads.get(id).geometry, { ...opts, color: isSelected ? COLORS.accent : "#263a58",
              opacity: isSelected ? 0.65 : 0.22, weight: 7,
              className: onRoute ? "trip-path" : "" }).addTo(importedHighlights);
          }
        }
        for (const [id, key, onRoute, , lanes] of styled) {
          const points = lookupRoads.get(id).geometry;
          L.polyline(points, { ...opts, color: COLORS[key], weight: (onRoute ? 5.5 : 3.5) + lanes * 2.5,
            dashArray: key === "closed" ? "5 6" : null,
            className: `traffic-road traffic-${key} traffic-${id}` }).addTo(importedHighlights);
          if (lanes && key !== "closed") {
            L.polyline(points, { ...opts, className: "lane-divider", color: "#fff",
              weight: 1, opacity: 0.8, dashArray: "4 5" }).addTo(importedHighlights);
          }
        }
      }
    }
    for (const [id, marker] of importedSignals) {
      if (!state.signals.has(id)) { marker.remove(); importedSignals.delete(id); }
    }
    for (const id of state.signals.keys()) {
      if (importedSignals.has(id)) continue;
      const marker = L.marker(endpointPositions.get(id), { pane: "labels", icon: signalIcon(), interactive: false, keyboard: false });
      importedSignals.set(id, marker.addTo(map));
    }
    customLayer.clearLayers();
    customPaths.clear();
    for (const route of customRoutes) {
      const service = busServices.find(item => item.id === route.id);
      const operating = state.busRoutes.has(route.id) && service?.operating;
      const focused = focusedBusId === route.id;
      const ids = operating ? service.roadIds : focused && !service?.error ? route.roadIds : [];
      for (const id of ids) {
        if (!lookupRoads.has(id)) continue;
        L.polyline(lookupRoads.get(id).geometry, { color: route.color, weight: focused ? 4 : 2,
          pane: "roads",
          dashArray: "3 8", opacity: focused || operating ? 1 : 0.4,
          interactive: false, className: `bus-road-${route.id}` }).addTo(customLayer);
      }
      if (state.busRoutes.has(route.id) || focused) route.points.forEach((point, i) => busPoint(
        customLayer, point, route.color, i + 1, `${route.name} · stop ${i + 1}`));
      if (operating) customPaths.set(route.id, route);
    }
    for (const [field, letter] of [["originId", "A"], ["destinationId", "B"]]) {
      const coordinates = state.originId && state.destinationId && endpointPositions.get(state[field]);
      let pin = endpointPins.get(field);
      if (!coordinates) { pin?.remove(); continue; }
      if (!pin) {
        const icon = L.divIcon({
          className: `endpoint-pin endpoint-pin-${letter}`, html: letter, iconSize: [24, 24], iconAnchor: [12, 32]
        });
        pin = L.marker(coordinates, { pane: "labels", icon, keyboard: false, interactive: false });
        endpointPins.set(field, pin);
      }
      pin.setLatLng(coordinates).addTo(map);
    }

  }

  // Cars follow whole directed routes. Each road contributes its polyline
  // and a bounded visual speed derived from that road's own congestion.
  function carItinerary(assignment, origin, roadTimes, signals) {
    const first = lookupRoads.get(assignment.roadIds[0]);
    let node = lookupPoints.has(origin) ? origin : first?.from;
    const legs = [];
    let duration = 0, distance = 0;
    for (const id of assignment.roadIds) {
      const road = lookupRoads.get(id);
      const points = road?.geometry || ROAD_GEOMETRY.roads[id];
      if (!road || !points || (node !== road.from && node !== road.to)) return null;
      const forward = node === road.from;
      const path = measure(forward ? points : [...points].reverse());
      node = forward ? road.to : road.from;
      if (!path.length) continue;
      const seconds = vehicleLegSeconds(path.length, roadTimes.get(id), road, forward);
      const speed = path.length / seconds;
      legs.push({ path, start: duration, speed });
      duration += seconds;
      duration += redLightSeconds(signals, node, road, duration);
      distance += path.length;
    }
    return { legs, duration, distance };
  }

  function sampleItinerary(itinerary, elapsed) {
    let low = 0, high = itinerary.legs.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (itinerary.legs[middle].start <= elapsed) low = middle;
      else high = middle - 1;
    }
    const { path, start, speed } = itinerary.legs[low];
    return pointAt(path, Math.min(path.length, (elapsed - start) * speed));
  }

  function addVehicle(icon, itinerary, elapsed, bus = false) {
    const marker = L.DomUtil.create("div", `moving-vehicle ${icon.options.className}`, vehicleLayer);
    marker.innerHTML = icon.options.html;
    marker.classList.toggle("moving-bus", bus);
    cars.push({ marker, rot: marker.firstChild, itinerary, elapsed });
  }

  function rebuildCars(result, enabled, originNodeId) {
    if (!ready) return;
    vehicleLayer.replaceChildren();
    cars = [];
    lastFrame = null;
    if (!result) return;
    const signals = signalStops(result.scenario.signals);
    const roadTimes = new Map(result.scenario.roads.map(road => [road.id, road]));
    for (const service of result.scenario.busRoutes || []) {
      if (!service.operating) continue;
      const route = customPaths.get(service.id);
      if (!route) continue;
      const itinerary = carItinerary(service, service.nodeIds[0], roadTimes, signals);
      if (itinerary?.duration) addVehicle(busIcon(route.color), itinerary, itinerary.duration * 0.15, true);
    }
    if (enabled) {
      let color = 0;
      for (const assignment of result.scenario.carRoutes || []) {
        if (!assignment.carTrips || !assignment.roadIds.length) continue;
        const itinerary = carItinerary(assignment, assignment.nodeIds?.[0] || originNodeId, roadTimes, signals);
        if (!itinerary?.duration) continue;
        const count = Math.max(2, Math.min(20, Math.ceil(itinerary.distance / 220)));
        for (let i = 0; i < count; i++) {
          addVehicle(carIcon(CAR_COLORS[color++ % CAR_COLORS.length]), itinerary,
            (i + 0.5) / count * itinerary.duration);
        }
      }
    }
    paintVehicles();
  }

  function paintVehicles() {
    const zoom = zoomFrame?.zoom ?? map.getZoom();
    const origin = zoomFrame?.origin ?? map.getPixelOrigin();
    const scale = Math.min(1.15, Math.max(0.45, 2 ** (zoom - 17)));
    for (const car of cars) {
      const { itinerary, elapsed } = car;
      // Fade at the trip ends so the next departing vehicle is distinct
      // from the one that just arrived at its destination.
      const fade = Math.min(0.65, itinerary.duration * 0.15);
      const opacity = Math.min(1, elapsed / fade, (itinerary.duration - elapsed) / fade);
      const p = sampleItinerary(itinerary, elapsed);
      L.DomUtil.setTransform(car.marker, map.project(p.latLng, zoom).subtract(origin));
      car.rot.style.transform = `rotate(${p.heading}deg) scale(${scale})`;
      car.marker.style.opacity = opacity;
    }
  }

  function animate(time) {
    const elapsed = lastFrame === null ? 0 : (time - lastFrame) / 1000 * playbackRate;
    lastFrame = time;
    if (cars.length && !document.getElementById("street-view").hidden) {
      for (const car of cars) {
        if (!reducedMotion) car.elapsed = (car.elapsed + elapsed) % car.itinerary.duration;
      }
      paintVehicles();
    }
    requestAnimationFrame(animate);
  }

  function previewLane(points, roadIds, focused = false) {
      if (!lanePreview) return;
      lanePreview.clearLayers();
      for (const id of roadIds) {
        const options = focused ? { weight: 14, opacity: 0.65, pane: "speed-edits" }
          : { weight: 7, opacity: 0.85, dashArray: "6 5" };
        L.polyline(lookupRoads.get(id).geometry, { color: "#702e9d", ...options,
          interactive: false, className: focused ? "road-edit-focus" : "lane-preview-path" }).addTo(lanePreview);
      }
      points.forEach((endpointId, index) => {
        const point = endpointPositions.get(endpointId);
        if (!point) return;
        const icon = L.divIcon({ className: "lane-preview-pin",
          html: index === 0 ? "S" : "E", iconSize: [22, 22], iconAnchor: [11, 22] });
        L.marker(point, { icon, title: index === 0 ? "Street stretch start" : "Street stretch end",
          interactive: false, keyboard: false }).addTo(lanePreview);
      });
  }

  return {
    init, render, rebuildCars, previewBus, previewLane, roadDistance, vehicleLegSeconds, playbackRate, signalStops, redLightSeconds,
    focusRoadEdit(points, roadIds) {
      if (!ready) return;
      previewLane(points, roadIds, true);
      const bounds = L.latLngBounds(roadIds.flatMap(id => lookupRoads.get(id).geometry));
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [56, 56], maxZoom: 17 });
    },
    showPicks: active => {
      if (!pickLayer) return;
      if (active && !map.hasLayer(pickLayer)) pickLayer.addTo(map);
      if (!active && map.hasLayer(pickLayer)) {
        pickLayer.remove();
        pickTooltip.remove();
      }
    },
    focusBus: (route, service) => {
      if (!ready) return;
      const roadIds = service?.roadIds || route.roadIds;
      const bounds = L.latLngBounds(route.points.map(point => endpointPositions.get(point.endpointId)).filter(Boolean));
      for (const id of roadIds) {
        const road = lookupRoads.get(id);
        if (road) bounds.extend(L.latLngBounds(road.geometry));
      }
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [54, 54], maxZoom: 17 });
    },
    showCoverage: () => { if (coverageCircle) map.fitBounds(coverageCircle.getBounds(), { padding: [15, 15] }); },
    revealEndpoints: ids => {
      if (!ready || document.getElementById("street-view").hidden) return;
      const points = ids.map(id => endpointPositions.get(id)).filter(Boolean);
      if (points.length === 2 && points.some(point => !map.getBounds().pad(-0.12).contains(point))) {
        map.fitBounds(L.latLngBounds(points), { padding: [52, 52], maxZoom: 16, animate: false });
      }
    },
    isReady: () => ready,
    missing: () => missingGeometry,
    refreshSize: () => {
      if (!map) return;
      map.invalidateSize({ pan: false });
        if (initialBounds) {
        map.fitBounds(initialBounds, { padding: [30, 30], animate: false });
        initialBounds = null;
      }
    }
  };
})();
