// Render OSM building prisms on Leaflet's map plane. Upper road and marker
// panes keep the active scenario readable, including under tall rooflines.
const BuildingView = (() => {
  let pendingData;
  const clipZoom = 16;
  const color = {
    height: { roof: "#d8c9ae", south: "#a89981", east: "#b8a98f", outline: "#8a7962" },
    estimate: { roof: "#e5ded2", south: "#aaa394", east: "#bbb3a6", outline: "#8e8677" }
  };

  function load() {
    pendingData ??= fetch("geo/princeton-buildings.json").then(async response => {
      if (!response.ok) throw new Error("Building data is unavailable.");
      const data = await response.json();
      if (!data.buildings?.length) throw new Error("No building footprints were found.");
      return data;
    }).catch(error => { pendingData = null; throw error; });
    return pendingData;
  }

  async function create(map) {
    const data = await load();
    const canvas = L.DomUtil.create("canvas", "princeton-buildings leaflet-zoom-animated");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Building rendering is unavailable.");
    const features = data.buildings.map(building => {
      const points = building.footprint.map(point => map.project(point, clipZoom));
      return { ...building, points, bounds: L.bounds(points), latitude: building.footprint[0][0] };
    }).sort((a, b) => a.bounds.max.y - b.bounds.max.y);
    const pane = map.getPane("buildings") || map.createPane("buildings");
    pane.style.zIndex = 390;
    pane.style.pointerEvents = "none";
    let origin, zoom;

    function polygon(points, fill, outline) {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = outline;
      ctx.stroke();
    }

    function draw() {
      zoom = map.getZoom();
      const bounds = map.getPixelBounds();
      const margin = L.point(100, 100);
      const size = bounds.getSize().add(margin.multiplyBy(2));
      origin = bounds.min.subtract(margin);
      const scale = map.getZoomScale(zoom, clipZoom);
      const view = L.bounds(origin.divideBy(scale), bounds.max.add(margin).divideBy(scale));
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.ceil(size.x * ratio);
      canvas.height = Math.ceil(size.y * ratio);
      canvas.style.width = size.x + "px";
      canvas.style.height = size.y + "px";
      ctx.scale(ratio, ratio);
      ctx.lineWidth = 0.65;
      L.DomUtil.setTransform(canvas, origin.subtract(map.getPixelOrigin()));
      for (const feature of features) {
        if (!view.intersects(feature.bounds)) continue;
        const metersPerPixel = 40075016.686 * Math.cos(feature.latitude * Math.PI / 180) / map.options.crs.scale(zoom);
        const rise = Math.max(1.2, feature.meters / metersPerPixel * 0.86);
        const base = feature.points.map(point => point.multiplyBy(scale).subtract(origin));
        const roof = base.map(point => point.subtract([0, rise]));
        const style = color[feature.heightSource === "height" ? "height" : "estimate"];
        let area = 0;
        for (let i = 0; i < base.length; i++) {
          const a = base[i], b = base[(i + 1) % base.length];
          area += a.x * b.y - b.x * a.y;
        }
        for (let i = 0; i < base.length; i++) {
          const j = (i + 1) % base.length;
          if ((base[j].x - base[i].x) * area >= 0) continue;
          polygon([base[i], base[j], roof[j], roof[i]],
            base[j].y > base[i].y ? style.east : style.south, style.outline);
        }
        polygon(roof, style.roof, style.outline);
      }
    }

    function zoomAnimation(event) {
      if (!origin) return;
      L.DomUtil.setTransform(canvas, map._latLngToNewLayerPoint(map.unproject(origin, zoom), event.zoom, event.center),
        map.getZoomScale(event.zoom, zoom));
    }

    return {
      attach() {
        pane.append(canvas);
        map.on("moveend resize viewreset", draw);
        map.on("zoomanim", zoomAnimation);
        draw();
      },
      detach() {
        canvas.remove();
        map.off("moveend resize viewreset", draw);
        map.off("zoomanim", zoomAnimation);
      }
    };
  }

  return { create };
})();
