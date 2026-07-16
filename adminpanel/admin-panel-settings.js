import {
  applyPanelBranding,
  fetchPanelSettings as fetchBrandingSettings,
  readCachedPanelSettings,
  normalizePanelSettings,
  normalizePanelTheme,
  writePanelSettingsCache,
  clearPanelSettingsCache,
} from "../panel-branding-core.js";

export {
  normalizePanelTheme,
  normalizePanelSettings,
  readCachedPanelSettings,
  writePanelSettingsCache,
  clearPanelSettingsCache,
};

export function applyPanelSettings(settings) {
  return applyPanelBranding(settings, {
    title: document.title,
    themeStorageKey: "panelTheme",
    showWhatsappFloat: false,
  });
}

export async function fetchPanelSettings() {
  return fetchBrandingSettings();
}

export async function initPanelSettings() {
  const settings = await fetchPanelSettings();
  return applyPanelSettings(settings);
}
