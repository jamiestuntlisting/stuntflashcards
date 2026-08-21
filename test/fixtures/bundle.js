// Simulated SPA bundle referencing its data endpoints.
const API_BASE = "https://api.example-stunts.com/v2";
async function loadRoster(filters) {
  const r = await fetch("/api/v1/performers/search?" + new URLSearchParams(filters), {
    headers: { Authorization: "Bearer " + getToken() },
  });
  return r.json();
}
const PROFILE_PATH = "/api/v1/performer_profiles";
const LEGACY = "/coordinator_dashboard/results.json";
export { loadRoster, PROFILE_PATH, LEGACY, API_BASE };
