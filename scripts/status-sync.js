const PANEL_SETTINGS_STORAGE_KEY = "panelSettings";
const DEFAULT_LAST_RUN_KEY = "panelMaintenanceLastRunAtShared";
const DEFAULT_SYNC_KEY_FIELDS = ["syncKey", "maintenanceKey", "cronKey"];

function readStoredPanelSettings(storageKey = PANEL_SETTINGS_STORAGE_KEY) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function getPanelMaintenanceKey({
  storageKey = PANEL_SETTINGS_STORAGE_KEY,
  keyFields = DEFAULT_SYNC_KEY_FIELDS
} = {}) {
  const settings = readStoredPanelSettings(storageKey);
  for (const field of keyFields) {
    const value = String(settings?.[field] || "").trim();
    if (value) return value;
  }
  return "";
}

export function appendMaintenanceKey(endpoint, options = {}) {
  const base = String(endpoint || "").trim();
  if (!base) return "";

  const key = getPanelMaintenanceKey(options);
  if (!key) return base;

  const joiner = base.includes("?") ? "&" : "?";
  return `${base}${joiner}key=${encodeURIComponent(key)}`;
}

export function shouldTriggerSharedSync({
  minGapMs = 5 * 60 * 1000,
  storageKey = DEFAULT_LAST_RUN_KEY,
  now = Date.now()
} = {}) {
  try {
    const lastRun = Number(localStorage.getItem(storageKey) || 0);
    if (lastRun && now - lastRun < Number(minGapMs || 0)) {
      return false;
    }
    localStorage.setItem(storageKey, String(now));
    return true;
  } catch {
    // If storage is blocked, allow the sync call instead of failing the UI path.
    return true;
  }
}
