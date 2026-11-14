const CUSTOM_BUS_KEY = "princeton-traffic-lab.custom-buses.v1";
const BUS_COLORS = ["#245ca5", "#a23778", "#b35c10", "#087a80", "#7040ab", "#926015"];
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
    const saved = JSON.parse(localStorage.getItem(CUSTOM_BUS_KEY) || "[]");
    customRoutes = [];
    for (const route of saved) {
      const stops = route.points?.filter(point => point.stop);
      if (!stops || stops.length < 2) continue;
      const points = stops;
      if (!points.every(point => endpoints.has(point.endpointId))) continue;
      const migrated = route.points.length !== points.length;
      const color = nextBusColor();
      customRoutes.push({ ...route, color: saved.some(other => other !== route && other.color === route.color)
        ? color : route.color || color,
        points, stopIds: points.map(point => point.endpointId),
        roadIds: migrated ? [] : (route.roadIds || []).filter(id => roadsById.has(id)) });
    }
  } catch (error) {
    $("bus-storage").textContent = "Saved shuttle routes could not be loaded.";
  }
}

function persistCustomRoutes() {
  try {
    const routes = customRoutes.map(({ enabled, ...route }) => route);
    localStorage.setItem(CUSTOM_BUS_KEY, JSON.stringify(routes));
    $("bus-storage").textContent = "";
  } catch (error) {
    $("bus-storage").textContent = "Browser storage is unavailable. These changes will last until refresh.";
  }
}

function startBusDraft(route) {
  if (!route && customRoutes.length >= 24) {
    $("bus-storage").textContent = "Delete a custom route before adding another. This demo supports 24 saved routes.";
    return;
  }
  draft = route ? { id: route.id, name: route.name, color: route.color,
    points: route.points.map(point => ({ ...point })) }
    : { id: "custom_" + crypto.randomUUID().replaceAll("-", ""), name: "", color: nextBusColor(), points: [] };
  draftStop = route ? null : 0;
  $("bus-route-name").value = draft.name;
  $("bus-editor").hidden = false;
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
  if (draft.points.some((point, index) =>
    index !== draftStop && endpointNode(point.endpointId) === endpointNode(endpointId))) {
    $("bus-preview-status").textContent = "Choose a different junction for each stop.";
    return;
  }
  draft.points[draftStop] = { endpointId, stop: true };
  draftStop = draft.points.length === 1 ? 1 : null;
  syncTripControls();
  updateBusDraft();
}

function renderDraftPath() {
  StreetMap.previewBus(draft?.points || [], preview?.legs || [], draft?.color);
  renderSchematicCustomBuses();
}

function pickBusStop(index) {
  draftStop = index;
  syncTripControls();
  updateBusDraft();
}

function updateBusDraft() {
  const version = ++draftRevision;
  clearTimeout(draftTimer);
  preview = null;
  renderDraftPath();
  $("save-bus").disabled = true;
  const count = draft.points.length;
  $("add-bus-stop").hidden = count < 2;
  $("add-bus-stop").disabled = draftStop !== null;
  const list = $("bus-draft-points");
  list.replaceChildren();
  for (let index = 0; index < Math.max(2, count, (draftStop ?? -1) + 1); index++) {
    const point = draft.points[index];
    const item = el("li");
    const name = point ? endpoints.get(point.endpointId).name : "Choose on map";
    const button = el("button", { type: "button", "aria-label": `Pick stop ${index + 1}`,
      "aria-pressed": String(draftStop === index) }, point ? "Change" : "Pick");
    button.disabled = index > count;
    button.onclick = () => pickBusStop(index);
    const actions = el("div", { class: "bus-stop-actions" });
    actions.append(button);
    if (point) {
      for (const [offset, symbol, direction] of [[-1, "↑", "up"], [1, "↓", "down"]]) {
        const target = index + offset;
        const move = el("button", { type: "button", "aria-label": `Move stop ${index + 1} ${direction}` }, symbol);
        move.disabled = target < 0 || target >= count;
        move.onclick = () => {
          [draft.points[index], draft.points[target]] = [draft.points[target], draft.points[index]];
          pickBusStop(null);
        };
        actions.append(move);
      }
      const remove = el("button", { type: "button", "aria-label": `Remove stop ${index + 1}` }, "Remove");
      remove.disabled = count <= 2;
      remove.onclick = () => {
        draft.points.splice(index, 1);
        pickBusStop(null);
      };
      actions.append(remove);
    }
    item.append(el("span", {}, name), actions);
    list.append(item);
  }
  const status = $("bus-preview-status");
  if (draftStop !== null || draft.points.length < 2) {
    status.textContent = "";
    return;
  }
  status.textContent = "Calculating shuttle path…";
  draftTimer = setTimeout(async () => {
    try {
      const plan = await postScenario("bus-preview", {
        route: { ...draft, name: draft.name.trim() || "Untitled route" }, closedRoadIds: [...state.closed]
      });
      if (version !== draftRevision) return;
      preview = plan;
      renderDraftPath();
      if (plan.error) { status.textContent = plan.error; return; }
      $("save-bus").disabled = !draft.name.trim();
      status.textContent = `${plan.stopIds.length} stops · ${plan.roadIds.length} road segments${plan.detoured ? " · detour around closure" : ""}`;
    } catch (error) {
      if (version === draftRevision) status.textContent = error.message;
    }
  }, 100);
}

function setupBusEditor() {
  $("add-bus-stop").onclick = () => pickBusStop(draft.points.length);
  $("bus-route-name").addEventListener("input", event => {
    draft.name = event.target.value;
    $("save-bus").disabled = !preview || !!preview.error || !draft.name.trim();
  });
  $("save-bus").addEventListener("click", () => {
    if (!preview || preview.error || !draft.name.trim()) return;
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
