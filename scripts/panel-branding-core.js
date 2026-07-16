export const DEFAULT_PANEL_SETTINGS = {
  panelName: "",
  panelMobile: "",
  theme: "classic",
  whatsappEnabled: false,
  whatsappNumber: "",
  whatsappCommunityUrl: "",
  newUserTestBalance: 0,
};

export const BRAND_TOKENS = ["GrowSMM", "SMM Growth", "SMM Admin"];
const PANEL_SETTINGS_CACHE_KEY = "growsmm_panel_settings_cache_v1";
const PANEL_SETTINGS_CACHE_TTL_MS = 30 * 60 * 1000;
const VALID_THEMES = ["classic", "ocean", "forest", "sunset"];
const BRAND_TEXT_ATTRIBUTES = [
  "content",
  "title",
  "aria-label",
  "alt",
  "placeholder",
  "value",
  "data-bs-original-title",
];

const SKIP_TEXT_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEXTAREA",
  "INPUT",
  "SELECT",
  "OPTION",
]);

const NODE_FILTER = globalThis.NodeFilter || {
  SHOW_TEXT: 4,
  FILTER_ACCEPT: 1,
  FILTER_REJECT: 2,
  FILTER_SKIP: 3,
};

let lastDeepSyncPanelName = "";

let firestoreDepsPromise = null;

async function loadFirestoreDeps() {
  if (firestoreDepsPromise) return firestoreDepsPromise;

  firestoreDepsPromise = Promise.all([
    import("./firebase.js"),
    import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js")
  ]).then(([firebaseMod, firestoreMod]) => ({
    db: firebaseMod.db,
    doc: firestoreMod.doc,
    getDoc: firestoreMod.getDoc
  }));

  return firestoreDepsPromise;
}

export function normalizePanelTheme(theme) {
  const value = String(theme || "").trim().toLowerCase();
  return VALID_THEMES.includes(value) ? value : DEFAULT_PANEL_SETTINGS.theme;
}

export function normalizePanelSettings(raw = {}) {
  const newUserTestBalance = Number(raw.newUserTestBalance || 0);

  return {
    panelName: String(raw.panelName || "").trim(),
    panelMobile: String(raw.panelMobile || "").trim(),
    theme: normalizePanelTheme(raw.theme),
    whatsappEnabled: Boolean(raw.whatsappEnabled),
    whatsappNumber: String(raw.whatsappNumber || "").trim(),
    whatsappCommunityUrl: String(raw.whatsappCommunityUrl || "").trim(),
    newUserTestBalance: Number.isFinite(newUserTestBalance) && newUserTestBalance > 0
      ? Number(newUserTestBalance.toFixed(2))
      : 0,
  };
}

function readPanelSettingsCacheEntry({ allowExpired = false } = {}) {
  try {
    const raw = localStorage.getItem(PANEL_SETTINGS_CACHE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const ts = Number(parsed?.ts || 0);
    if (!ts) return null;

    if (!allowExpired && Date.now() - ts > PANEL_SETTINGS_CACHE_TTL_MS) {
      return null;
    }

    return normalizePanelSettings(parsed?.data || {});
  } catch {
    return null;
  }
}

export function readCachedPanelSettings() {
  return readPanelSettingsCacheEntry();
}

export function writePanelSettingsCache(settings) {
  const normalized = normalizePanelSettings(settings);
  try {
    localStorage.setItem(
      PANEL_SETTINGS_CACHE_KEY,
      JSON.stringify({
        ts: Date.now(),
        data: normalized,
      })
    );
  } catch {
    // Ignore storage failures and still return the normalized payload.
  }
  return normalized;
}

export function clearPanelSettingsCache() {
  try {
    localStorage.removeItem(PANEL_SETTINGS_CACHE_KEY);
  } catch {
    // no-op
  }
}

export function buildWhatsappUrl(number) {
  const digits = String(number || "").replace(/[^\d]/g, "");
  if (!digits) return "";
  return `https://wa.me/${digits}`;
}

export function replaceBrandTokens(value, panelName) {
  const source = String(value ?? "");
  const target = String(panelName || "").trim();
  if (!target) return source;

  let next = source;
  for (const token of BRAND_TOKENS) {
    next = next.split(token).join(target);
  }
  return next;
}

function syncTheme(theme, storageKey = "panelTheme") {
  if (document.body) {
    document.body.setAttribute("data-theme", theme);
  }
  document.documentElement?.setAttribute("data-theme", theme);

  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    // Ignore storage failures in private mode or disabled storage contexts.
  }
}

function syncTextSelector(selector, value, hideWhenEmpty = false) {
  document.querySelectorAll(selector).forEach((el) => {
    if (hideWhenEmpty) {
      if (value) {
        el.textContent = value;
        el.classList.remove("d-none");
      } else {
        el.textContent = "";
        el.classList.add("d-none");
      }
      return;
    }

    el.textContent = value;
  });
}

function syncBrandLogos(settings) {
  const panelName = String(settings?.panelName || "").trim();
  const logoUrl = String(settings?.logoUrl || "").trim();

  document.querySelectorAll(".brand-logo").forEach((el) => {
    const img = el.querySelector("img");
    const existing = el.querySelector("[data-panel-name]");

    if (existing && panelName) {
      existing.textContent = panelName;
      // If a logo URL exists, keep the image but update its src.
      if (img && logoUrl) {
        img.src = logoUrl;
      }
      return;
    }

    if (img) {
      if (logoUrl) {
        img.src = logoUrl;
        if (panelName) {
          const text = document.createElement("span");
          text.setAttribute("data-panel-name", "");
          text.textContent = panelName;
          el.replaceChildren(img.cloneNode(true), text);
        }
        return;
      }

      if (panelName) {
        const clone = img.cloneNode(true);
        const text = document.createElement("span");
        text.setAttribute("data-panel-name", "");
        text.textContent = panelName;
        el.replaceChildren(clone, text);
        return;
      }

      return;
    }

    if (panelName) {
      el.textContent = panelName;
    }
  });
}

function syncBrandTitles(panelName) {
  const cleanName = String(panelName || "").trim();
  if (!cleanName) return;

  document.querySelectorAll(".brand-title").forEach((el) => {
    el.textContent = cleanName;
  });
}

function syncDocumentTitle(title, panelName) {
  const cleanName = String(panelName || "").trim();
  if (!cleanName) return;

  const sourceTitle = String(title || document.title || "").trim();
  if (!sourceTitle) {
    document.title = cleanName;
    return;
  }

  document.title = replaceBrandTokens(sourceTitle, cleanName);
}

function syncPanelTextNodes(root, panelName) {
  const cleanName = String(panelName || "").trim();
  if (!cleanName || !root) return;

  const walker = document.createTreeWalker(
    root,
    NODE_FILTER.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || SKIP_TEXT_TAGS.has(parent.tagName)) {
          return NODE_FILTER.FILTER_REJECT;
        }

        const text = String(node.nodeValue || "");
        if (!BRAND_TOKENS.some((token) => text.includes(token))) {
          return NODE_FILTER.FILTER_SKIP;
        }

        return NODE_FILTER.FILTER_ACCEPT;
      },
    }
  );

  const nodes = [];
  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }

  nodes.forEach((node) => {
    node.nodeValue = replaceBrandTokens(node.nodeValue, cleanName);
  });
}

function syncAttributes(root, panelName) {
  const cleanName = String(panelName || "").trim();
  if (!cleanName || !root) return;

  const elements = typeof root.querySelectorAll === "function" ? root.querySelectorAll("*") : [];
  elements.forEach((el) => {
    if (el.tagName === "SCRIPT" && String(el.getAttribute("type") || "").toLowerCase() === "application/ld+json") {
      const nextJson = replaceBrandTokens(el.textContent || "", cleanName);
      if (nextJson !== el.textContent) {
        el.textContent = nextJson;
      }
      return;
    }

    for (const attr of BRAND_TEXT_ATTRIBUTES) {
      if (!el.hasAttribute(attr)) continue;
      const current = el.getAttribute(attr) || "";
      const next = replaceBrandTokens(current, cleanName);
      if (next !== current) {
        el.setAttribute(attr, next);
      }
    }
  });
}

function syncWhatsappData(settings) {
  const digits = String(settings.whatsappNumber || "").replace(/[^\d]/g, "");
  const waLink = buildWhatsappUrl(settings.whatsappNumber);

  syncTextSelector("[data-whatsapp-number]", digits);

  document.querySelectorAll("[data-whatsapp-link]").forEach((el) => {
    if (waLink) {
      el.setAttribute("href", waLink);
    } else {
      el.removeAttribute("href");
    }
  });

  document.querySelectorAll("[data-community-link]").forEach((el) => {
    if (settings.whatsappCommunityUrl) {
      el.setAttribute("href", settings.whatsappCommunityUrl);
      el.classList.remove("d-none");
    } else {
      el.classList.add("d-none");
    }
  });
}

function syncWhatsappFloat(settings, floatButtonId = "whatsappFloat") {
  const existing = document.getElementById(floatButtonId);
  const enabled = Boolean(settings.whatsappEnabled);
  const url = buildWhatsappUrl(settings.whatsappNumber);

  if (!enabled || !url) {
    if (existing) existing.remove();
    return;
  }

  if (existing) {
    existing.href = url;
    return;
  }

  const btn = document.createElement("a");
  btn.id = floatButtonId;
  btn.href = url;
  btn.target = "_blank";
  btn.rel = "noopener";
  btn.className = "whatsapp-float";
  btn.innerHTML = '<i class="bi bi-whatsapp"></i>';
  document.body.appendChild(btn);
}

export function applyPanelBranding(settings, options = {}) {
  const normalized = normalizePanelSettings(settings);
  const panelName = String(normalized.panelName || "").trim();

  syncTheme(normalized.theme, options.themeStorageKey || "panelTheme");
  syncTextSelector(options.panelNameSelector || "[data-panel-name]", panelName);
  syncTextSelector(options.panelMobileSelector || "[data-panel-mobile]", normalized.panelMobile, true);
  syncWhatsappData(normalized);
  syncBrandLogos(settings);
  syncBrandTitles(panelName);
  syncDocumentTitle(options.title || document.title, panelName);

  if (panelName && panelName !== lastDeepSyncPanelName) {
    syncPanelTextNodes(options.root || document.body, panelName);
    syncAttributes(options.root || document, panelName);
    lastDeepSyncPanelName = panelName;
  }

  if (options.showWhatsappFloat !== false) {
    syncWhatsappFloat(normalized, options.floatButtonId || "whatsappFloat");
  }

  return normalized;
}

export async function fetchPanelSettings({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = readPanelSettingsCacheEntry();
    if (cached) return cached;
  }

  try {
    const deps = await loadFirestoreDeps();
    const snap = await deps.getDoc(deps.doc(deps.db, "meta", "panel_settings"));
    if (snap.exists()) {
      return writePanelSettingsCache(snap.data());
    }
  } catch (err) {
    console.warn("Failed to fetch panel settings:", err);
  }

  return readPanelSettingsCacheEntry({ allowExpired: true }) || normalizePanelSettings(DEFAULT_PANEL_SETTINGS);
}
