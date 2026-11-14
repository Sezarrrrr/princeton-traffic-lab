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

function redrawLaneDraft(resetLimit = false) {
  const option = laneDraft.options[Number($("lane-options").value)];
  const speedMode = laneDraft.mode === "speed";
  const input = $("speed-limit-mph");
  $("speed-limit-label").hidden = !speedMode || !option;
  if (speedMode && option && resetLimit) input.value = Math.round(option.speedLimitsMph[0]);
  StreetMap.previewLane([laneDraft.startId, laneDraft.endId].filter(Boolean), option?.roadIds || []);
  $("confirm-lane").disabled = !option || (speedMode && !validSpeedLimit());
  if (option) {
    const limitInfo = speedMode
      ? `Original limits: ${option.speedLimitsMph.map(mph => Number(mph.toFixed(1))).join(", ")} mph.`
      : "Adds capacity. The speed limit and free-flow time stay the same.";
    $("lane-status").textContent = `${option.street} · ${option.distanceMeters} m · ${option.roadIds.length} segments. ${limitInfo}`;
  }
  syncTripControls();
}

function validSpeedLimit() {
  const input = $("speed-limit-mph");
  return input.value !== "" && input.checkValidity();
}

async function pickLanePoint(id) {
  if (!laneDraft.startId) {
    laneDraft.startId = id;
    $("lane-status").textContent = `Start · ${endpoints.get(id).name}. Pick the end on the same street.`;
    redrawLaneDraft();
    return;
  }

  const version = ++laneVersion;
  laneDraft.endId = id;
  laneDraft.options = [];
  $("lane-options-label").hidden = true;
  $("lane-status").textContent = "Finding a connected stretch…";
  redrawLaneDraft();
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
    redrawLaneDraft(true);
  } catch (error) {
    if (version === laneVersion) $("lane-status").textContent = `${error.message} Pick another end point.`;
  }
}

function startLaneDraft(mode) {
  laneDraft = { mode, startId: null, endId: null, options: [] };
  $("lane-editor").hidden = false;
  $("lane-options-label").hidden = true;
  $("lane-options").replaceChildren();
  $("speed-limit-label").hidden = true;
  $("confirm-lane").disabled = true;
  $("confirm-lane").textContent = mode === "speed" ? "Apply speed limit" : "Confirm extra lane";
  $("lane-status").textContent = "";
  syncTripControls();
}

function setupLaneMap() {
  $("lane-options").onchange = () => redrawLaneDraft(true);
  $("speed-limit-mph").oninput = () => { $("confirm-lane").disabled = !validSpeedLimit(); };
  $("confirm-lane").onclick = () => {
    const option = laneDraft.options[Number($("lane-options").value)];
    if (!option) return;
    const { startId, endId, mode } = laneDraft;
    const { roadIds } = option;
    if (mode === "speed" && !validSpeedLimit()) return;
    const speedLimitMph = $("speed-limit-mph").valueAsNumber;
    cancelMapTool();
    change(() => {
      if (mode === "speed") {
        state.speedStretches.push({ startId, endId, roadIds, speedLimitMph });
      } else {
        state.laneStretches.push({ startId, endId, roadIds });
      }
    });
  };
}
