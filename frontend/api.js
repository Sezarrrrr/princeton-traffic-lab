// Talks to the backend, or to the mock files while the backend isn't ready.
// To use Sizar's FastAPI server, set useMock to false (or open the page with ?api=real).
const CONFIG = {
  useMock: !new URLSearchParams(location.search).has("api"),
  apiBase: "http://localhost:8000"
};

async function fetchNetwork() {
  if (CONFIG.useMock) return structuredClone(MOCK_NETWORK);
  const res = await fetch(`${CONFIG.apiBase}/api/network`);
  if (!res.ok) throw new Error(`GET /api/network failed (${res.status})`);
  return res.json();
}

async function fetchSimulation(scenario) {
  if (CONFIG.useMock) return mockSimulate(scenario);
  const res = await fetch(`${CONFIG.apiBase}/api/simulate`, {
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
