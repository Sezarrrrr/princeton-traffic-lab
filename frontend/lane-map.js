let laneDraft = null;
let laneVersion = 0;

function closeLaneDraft() {
  if (!laneDraft) return;
  laneVersion++;
  laneDraft = null;
  $("lane-editor").hidden = true;
  StreetMap.previewLane([], []);
  syncTripControls();
}

function redrawLaneDraft() {
  const option = laneDraft.options[Number($("lane-options").value)];
  StreetMap.previewLane([laneDraft.startId, laneDraft.endId].filter(Boolean), option?.roadIds || []);
  $("confirm-lane").disabled = !option;
  if (option) {
    $("lane-status").textContent = `${option.street} · ${option.distanceMeters} m · ${option.roadIds.length} segments. Confirm to add one lane.`;
  }
  syncTripControls();
}

async function pickLanePoint(id) {
  if (!laneDraft.startId) {
    laneDraft.startId = id;
    $("lane-status").textContent = `Start · ${endpoints.get(id).name}. Pick the end on the same street.`;
    redrawLaneDraft();
    syncTripControls();
    return;
  }

  const version = ++laneVersion;
  laneDraft.endId = id;
  laneDraft.options = [];
  $("lane-options-label").hidden = true;
  $("lane-status").textContent = "Finding a connected stretch…";
  redrawLaneDraft();
  syncTripControls();
  try {
    const data = await postScenario("lane-preview", {
      startId: laneDraft.startId, endId: id, closedRoadIds: [...state.closed]
    });
    if (version !== laneVersion) return;
    laneDraft.options = data.options;
    if (!data.options.length) {
      $("lane-status").textContent = "No connected stretch on the same street. Pick another end point.";
      return;
    }
    $("lane-options").replaceChildren(...data.options.map((option, index) =>
      el("option", { value: index }, `${option.street} · ${option.distanceMeters} m · option ${index + 1}`)));
    $("lane-options-label").hidden = data.options.length === 1;
    redrawLaneDraft();
  } catch (error) {
    if (version === laneVersion) $("lane-status").textContent = `${error.message} Pick another end point.`;
  }
}

function setupLaneMap() {
  $("add-lane-map").hidden = CONFIG.useMock || !junctions.length || !StreetMap.isReady();
  $("add-lane-map").onclick = () => {
    if (draft) closeBusDraft();
    endpointMode = null;
    closeLaneDraft();
    laneDraft = { startId: null, endId: null, options: [] };
    $("lane-editor").hidden = false;
    $("lane-options-label").hidden = true;
    $("lane-options").replaceChildren();
    $("confirm-lane").disabled = true;
    $("lane-status").textContent = "Pick the start of the lane stretch.";
    showView("street");
    $("lane-editor").scrollIntoView({ block: "nearest" });
    syncTripControls();
  };
  $("lane-options").onchange = redrawLaneDraft;
  $("cancel-lane").onclick = closeLaneDraft;
  $("confirm-lane").onclick = () => {
    const option = laneDraft.options[Number($("lane-options").value)];
    if (!option) return;
    const { startId, endId } = laneDraft;
    const { roadIds } = option;
    closeLaneDraft();
    change(() => state.laneStretches.push({ startId, endId, roadIds }));
  };
}
