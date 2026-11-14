// Hosted deployments serve the UI and API together. Port 5501 is the local split-server setup.
const CONFIG = {
  useMock: new URLSearchParams(location.search).get("api") === "mock",
  apiBase: ["127.0.0.1", "localhost"].includes(location.hostname) && location.port === "5501"
    ? "http://127.0.0.1:8000"
    : location.origin
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
  if (CONFIG.useMock) return structuredClone(MOCK_NETWORK);
  const res = await request(`${CONFIG.apiBase}/api/network`);
  if (!res.ok) throw new Error(`GET /api/network failed (${res.status})`);
  return res.json();
}

async function fetchSimulation(scenario) {
  if (CONFIG.useMock) return mockSimulate(scenario);
  return postScenario("simulate", scenario);
}

async function postScenario(endpoint, scenario) {
  const res = await request(`${CONFIG.apiBase}/api/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(scenario)
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).detail; } catch (e) { /* no JSON body */ }
    const message = Array.isArray(detail) ? detail.map(error => error.msg).join(", ") : detail;
    throw new Error(`POST /api/${endpoint} failed (${res.status}) ${message || ""}`.trim());
  }
  return res.json();
}
