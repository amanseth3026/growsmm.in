import { initPanelSettings } from "./admin-panel-settings.js";
import {
  appendMaintenanceKey,
  shouldTriggerSharedSync
} from "../scripts/status-sync.js";
import { bindAdminLogout } from "./admin-ui-common.js";

const STATUS_SYNC_MIN_GAP_MS = 5 * 60 * 1000;
const ADMIN_MENU_ITEMS = [
  { href: "admin-dashboard.html", icon: "bi-speedometer2", label: "Dashboard" },
  { href: "admin-orders.html", icon: "bi-box-seam", label: "Orders" },
  { href: "admin-users.html", icon: "bi-people", label: "Users" },
  { href: "admin-payments.html", icon: "bi-wallet2", label: "Payments" },
  { href: "admin-cash-type.html", icon: "bi-cash-coin", label: "Cash Type" },
  { href: "admin-categories.html", icon: "bi-list-ul", label: "Categories" },
  { href: "admin-services.html", icon: "bi-gear", label: "Services" },
  { href: "admin-manual-services.html", icon: "bi-tools", label: "Manual Services" },
  { href: "admin-broadcast.html", icon: "bi-megaphone", label: "Announcements" },
  { href: "admin-analytics.html", icon: "bi-bar-chart-line", label: "Analytics" },
  { href: "admin-settings.html", icon: "bi-sliders", label: "Settings" }
];

function fireAndForget(endpoint) {
  fetch(endpoint, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    keepalive: true
  }).catch((err) => {
    console.warn(`Admin background sync failed for ${endpoint}:`, err?.message || err);
  });
}

function shouldTriggerStatusSync() {
  return shouldTriggerSharedSync({ minGapMs: STATUS_SYNC_MIN_GAP_MS });
}

function currentAdminPage() {
  const path = String(window.location.pathname || "");
  const file = path.split("/").pop() || "";
  return file.toLowerCase();
}

function normalizeAdminSidebar() {
  const list = document.querySelector("#sidebar-wrapper .list-group");
  if (!list) return;

  const page = currentAdminPage();
  const menuHtml = ADMIN_MENU_ITEMS.map((item) => {
    const active = page === String(item.href || "").toLowerCase() ? " active" : "";
    return `<a href="${item.href}" class="list-group-item${active}"><i class="bi ${item.icon}"></i> ${item.label}</a>`;
  }).join("");

  list.innerHTML = `${menuHtml}<a href="#" id="btnLogout" class="list-group-item text-danger"><i class="bi bi-box-arrow-right"></i> Logout</a>`;
}

function normalizeMenuButton() {
  const menuBtn = document.getElementById("menu-toggle");
  if (!menuBtn) return;
  menuBtn.innerHTML = '<i class="bi bi-list"></i> Menu';
  menuBtn.setAttribute("aria-label", "Toggle menu");
  menuBtn.title = "Menu";
}

function removeAdminWhatsappFloat() {
  document.getElementById("whatsappFloat")?.remove();
  document.querySelectorAll(".whatsapp-float").forEach((el) => el.remove());
}

(function runAdminBackgroundSync() {
  normalizeAdminSidebar();
  normalizeMenuButton();
  removeAdminWhatsappFloat();
  bindAdminLogout("btnLogout");

  initPanelSettings().catch((err) => {
    console.warn("Admin panel settings init failed:", err);
  });

  removeAdminWhatsappFloat();
  if (shouldTriggerStatusSync()) {
    fireAndForget(appendMaintenanceKey("/api/status-check"));
  }
})();
