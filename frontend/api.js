// Talks to the backend, or to the in-browser simulator (sim/engine.js).
// Default: the in-browser simulator on the expanded network, with custom trips and intersection
// controls. Open the page with ?api=real to use Sizar's FastAPI server instead (core network,
// closures and extra lanes).
const CONFIG = {
  useLocal: !new URLSearchParams(location.search).has("api"),
  apiBase: "http://localhost:8000"
};

// fetch() only throws when the server can't be reached at all (not running, wrong port,
// or blocked by the browser because the backend hasn't enabled CORS).
async function request(url, options) {
  try {
    return await fetch(url, options);
  } catch (err) {
    throw new Error(`can't reach the backend at ${CONFIG.apiBase}. Is it running, with CORS enabled?`);
  }
}

async function fetchNetwork() {
  if (CONFIG.useLocal) return LocalSim.network();
  const res = await request(`${CONFIG.apiBase}/api/network`);
  if (!res.ok) throw new Error(`GET /api/network failed (${res.status})`);
  return res.json();
}

async function fetchSimulation(scenario) {
  if (CONFIG.useLocal) return LocalSim.simulate(scenario);
  const res = await request(`${CONFIG.apiBase}/api/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(scenario)
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).detail; } catch (e) { /* no JSON body */ }
    throw new Error(`POST /api/simulate failed (${res.status}) ${detail || ""}`.trim());
  }
  return res.json();
}
