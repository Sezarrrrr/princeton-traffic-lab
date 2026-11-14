const CUSTOM_BUS_KEY = "princeton-traffic-lab.custom-buses.v1";
const BUS_COLORS = ["#245ca5", "#a23778", "#b35c10", "#087a80", "#7040ab", "#926015"];
const STOP_LABELS = ["Start", "End"];
const busColor = index => BUS_COLORS[index] || `hsl(${Math.round(index * 137.508) % 360} 65% 37%)`;
let draftStop = null;
function nextBusColor() {
  const used = new Set(customRoutes.map(route => route.color));
  for (let index = 0; ; index++) {
    const color = busColor(index);
    if (!used.has(color)) return color;
  }
}
let customRoutes = [];
let draft = null;
let preview = null;
let draftRevision = 0;
let draftTimer = null;

function loadCustomRoutes() {
  try {
    const savedShare = localStorage.getItem(CUSTOM_BUS_KEY + ".share");
    if (savedShare !== null && /^\d+$/.test(savedShare) && Number(savedShare) <= 50) state.busPercent = Number(savedShare);
    const saved = JSON.parse(localStorage.getItem(CUSTOM_BUS_KEY) || "[]");
    customRoutes = [];
    for (const route of saved) {
      const stops = route.points?.filter(point => point.stop);
      if (!stops || stops.length < 2) continue;
      const points = [stops[0], stops.at(-1)];
      if (!points.every(point => endpoints.has(point.endpointId))) continue;
      const migrated = route.points.length !== 2;
      const color = nextBusColor();
      customRoutes.push({ ...route, color: saved.some(other => other !== route && other.color === route.color)
        ? color : route.color || color,
        points, stopIds: points.map(point => point.endpointId),
        roadIds: migrated ? [] : (route.roadIds || []).filter(id => roadsById.has(id)) });
    }
    for (const route of customRoutes) if (route.enabled) state.busRoutes.add(route.id);
  } catch (error) {
    $("bus-storage").textContent = "Saved shuttle routes could not be loaded.";
  }
}

function persistCustomRoutes() {
  try {
    const routes = customRoutes.map(route => ({ ...route, enabled: state.busRoutes.has(route.id) }));
    localStorage.setItem(CUSTOM_BUS_KEY, JSON.stringify(routes));
    localStorage.setItem(CUSTOM_BUS_KEY + ".share", String(state.busPercent));
    $("bus-storage").textContent = "";
  } catch (error) {
    $("bus-storage").textContent = "Browser storage is unavailable. These changes will last until refresh.";
  }
}

function startBusDraft(route) {
  closeLaneDraft();
  if (!route && customRoutes.length >= 24) {
    $("bus-storage").textContent = "Delete a custom route before adding another. This demo supports 24 saved routes.";
    return;
  }
  endpointMode = null;
  draft = route ? { id: route.id, name: route.name, color: route.color,
    points: route.points.map(point => ({ ...point })) }
    : { id: "custom_" + crypto.randomUUID().replaceAll("-", ""), name: "", color: nextBusColor(), points: [] };
  draftStop = route ? null : 0;
  $("bus-route-name").value = draft.name;
  $("bus-editor").hidden = false;
  $("bus-editor").scrollIntoView({ block: "nearest" });
  $("bus-route-name").focus({ preventScroll: true });
  syncTripControls();
  updateBusDraft();
}

function closeBusDraft() {
  draftRevision++;
  clearTimeout(draftTimer);
  draft = preview = draftStop = null;
  $("bus-editor").hidden = true;
  syncTripControls();
  renderDraftPath();
}

function addDraftPoint(endpointId) {
  if (!draft || draftStop === null || !endpoints.has(endpointId)) return;
  const other = draft.points[1 - draftStop];
  if (other && endpointNode(other.endpointId) === endpointNode(endpointId)) {
    $("bus-preview-status").textContent = "Choose a different junction for each stop.";
    return;
  }
  draft.points[draftStop] = { endpointId, stop: true };
  draftStop = draft.points.length === 1 ? 1 : null;
  syncTripControls();
  updateBusDraft();
}

function renderDraftPath() {
  StreetMap.previewBus(draft?.points || [], preview?.roadIds || [], draft?.color);
  renderSchematicCustomBuses();
}

function updateBusDraft() {
  const version = ++draftRevision;
  clearTimeout(draftTimer);
  preview = null;
  renderDraftPath();
  $("save-bus").disabled = true;
  const list = $("bus-draft-points");
  list.replaceChildren();
  for (const [index, label] of STOP_LABELS.entries()) {
    const point = draft.points[index];
    const item = el("li");
    const name = point ? endpoints.get(point.endpointId).name : "Choose on map";
    const button = el("button", { type: "button", "aria-label": `Change ${label.toLowerCase()} stop`,
      "aria-pressed": String(draftStop === index) }, point ? "Change" : "Pick");
    button.disabled = index === 1 && !draft.points[0];
    button.onclick = () => {
      endpointMode = null;
      draftStop = index;
      syncTripControls();
      updateBusDraft();
    };
    item.append(el("span", {}, `${label} · ${name}`), button);
    list.append(item);
  }
  const status = $("bus-preview-status");
  if (draftStop !== null || draft.points.length < 2) {
    status.textContent = `Click the map to choose the bus ${STOP_LABELS[draftStop ?? 0].toLowerCase()} stop.`;
    return;
  }
  status.textContent = "Calculating shuttle path…";
  draftTimer = setTimeout(async () => {
    try {
      const plan = await postScenario("bus-preview", {
        route: { ...draft, name: draft.name.trim() || "Untitled route" }, closedRoadIds: [...state.closed]
      });
      if (version !== draftRevision) return;
      if (plan.error) { status.textContent = plan.error; return; }
      preview = plan;
      renderDraftPath();
      $("save-bus").disabled = !draft.name.trim();
      status.textContent = `${plan.stopIds.length} stops · ${plan.roadIds.length} road segments${plan.detoured ? " · detour around closure" : ""}`;
    } catch (error) {
      if (version === draftRevision) status.textContent = error.message;
    }
  }, 100);
}

function setupBusEditor() {
  $("create-bus").hidden = !network.demo && !network.defaults;
  $("create-bus").addEventListener("click", () => startBusDraft());
  $("cancel-bus").addEventListener("click", closeBusDraft);
  $("bus-route-name").addEventListener("input", event => {
    draft.name = event.target.value;
    $("save-bus").disabled = !preview || !draft.name.trim();
  });
  $("save-bus").addEventListener("click", () => {
    if (!preview || !draft.name.trim()) return;
    const route = { ...draft, name: draft.name.trim(),
      stopIds: preview.stopIds, roadIds: preview.roadIds };
    const index = customRoutes.findIndex(item => item.id === route.id);
    if (index < 0) customRoutes.push(route);
    else customRoutes[index] = route;
    closeBusDraft();
    change(() => {
      state.busRoutes.add(route.id);
      persistCustomRoutes();
    });
  });
}
