function runWhenIdle(callback, timeout = 1200) {
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(callback, { timeout });
    return;
  }
  window.setTimeout(callback, 300);
}

async function initSiteBranding() {
  const branding = await import("./panel-branding-core.js");
  const showWhatsappFloat = !document.querySelector(".splash-shell");

  const applySettings = (settings) => {
    branding.applyPanelBranding(settings, {
      title: document.title,
      themeStorageKey: "panelTheme",
      showWhatsappFloat
    });
    if (document.querySelector(".splash-shell") && settings?.panelName) {
      document.title = settings.panelName;
    }
  };

  const cached = branding.readCachedPanelSettings();
  if (cached) {
    applySettings(cached);
    // Refresh in background so next navigation sees latest panel settings.
    runWhenIdle(async () => {
      try {
        const fresh = await branding.fetchPanelSettings({ forceRefresh: true });
        applySettings(fresh);
      } catch (err) {
        console.warn("Site branding refresh failed:", err);
      }
    }, 1800);
    return cached;
  }

  // No cache: defer network/Firebase work until browser is less busy.
  runWhenIdle(async () => {
    try {
      const settings = await branding.fetchPanelSettings();
      applySettings(settings);
    } catch (err) {
      console.warn("Site branding init failed:", err);
    }
  }, 900);

  return null;
}

function boot() {
  initSiteBranding().catch((err) => {
    console.warn("Site branding init failed:", err);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
