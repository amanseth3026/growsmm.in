const AUTH_FLAG_KEY = "quickboostAdmin";
const AUTH_NAME_KEY = "quickboostAdminName";
const ADMIN_LOGIN_PATH = "admin-login.html";

const outsideClickRegistry = new Set();

function resolveElement(target) {
  if (!target) return null;
  if (typeof target === "string") return document.getElementById(target);
  return target;
}

function makeOutsideRegistryKey({
  wrapperId,
  menuToggleId,
  sidebarId
}) {
  return `${wrapperId}::${menuToggleId}::${sidebarId}`;
}

export function requireAdminAuth({
  redirectTo = ADMIN_LOGIN_PATH
} = {}) {
  if (localStorage.getItem(AUTH_FLAG_KEY) === "true") return true;
  window.location.href = redirectTo;
  return false;
}

export function clearAdminSession({
  redirectTo = ADMIN_LOGIN_PATH
} = {}) {
  try {
    localStorage.removeItem(AUTH_FLAG_KEY);
    localStorage.removeItem(AUTH_NAME_KEY);
  } catch {
    // Ignore storage issues.
  }

  try {
    sessionStorage.removeItem("smmAdminEmail");
  } catch {
    // Ignore storage issues.
  }

  if (redirectTo) {
    window.location.href = redirectTo;
  }
}

export function bindAdminLogout(target = "btnLogout", {
  redirectTo = ADMIN_LOGIN_PATH
} = {}) {
  const el = resolveElement(target);
  if (!el) return;
  if (el.dataset.adminLogoutBound === "1") return;

  el.dataset.adminLogoutBound = "1";
  el.addEventListener("click", (event) => {
    event.preventDefault();
    clearAdminSession({ redirectTo });
  });
}

export function initAdminSidebar({
  wrapperId = "wrapper",
  menuToggleId = "menu-toggle",
  overlayId = "overlay",
  closeBtnId = "sidebarCloseBtn",
  sidebarId = "sidebar-wrapper",
  closeOnOutsideClick = false,
  requireAllCoreElements = false
} = {}) {
  const wrapper = resolveElement(wrapperId);
  const menuToggle = resolveElement(menuToggleId);
  const overlay = resolveElement(overlayId);
  const closeBtn = resolveElement(closeBtnId);
  const sidebar = resolveElement(sidebarId);

  if (requireAllCoreElements && (!wrapper || !menuToggle || !overlay || !closeBtn || !sidebar)) {
    return;
  }

  if (!menuToggle || !sidebar) return;

  const closeMenu = () => {
    if (window.innerWidth <= 992) {
      sidebar.classList.remove("show");
      overlay?.classList.remove("show");
    } else {
      wrapper?.classList.remove("toggled");
    }
  };

  const toggleMenu = () => {
    if (window.innerWidth <= 992) {
      const shouldOpen = !sidebar.classList.contains("show");
      sidebar.classList.toggle("show", shouldOpen);
      overlay?.classList.toggle("show", shouldOpen);
    } else {
      wrapper?.classList.toggle("toggled");
    }
  };

  if (menuToggle.dataset.adminSidebarToggleBound !== "1") {
    menuToggle.dataset.adminSidebarToggleBound = "1";
    menuToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMenu();
    });
  }

  if (closeBtn && closeBtn.dataset.adminSidebarCloseBound !== "1") {
    closeBtn.dataset.adminSidebarCloseBound = "1";
    closeBtn.addEventListener("click", closeMenu);
  }

  if (overlay && overlay.dataset.adminSidebarOverlayBound !== "1") {
    overlay.dataset.adminSidebarOverlayBound = "1";
    overlay.addEventListener("click", closeMenu);
  }

  if (!closeOnOutsideClick) return;

  const outsideKey = makeOutsideRegistryKey({ wrapperId, menuToggleId, sidebarId });
  if (outsideClickRegistry.has(outsideKey)) return;

  outsideClickRegistry.add(outsideKey);
  document.addEventListener("click", (event) => {
    if (window.innerWidth <= 992) {
      if (!sidebar.classList.contains("show")) return;
      if (sidebar.contains(event.target) || menuToggle.contains(event.target)) return;
      closeMenu();
      return;
    }

    if (!wrapper?.classList.contains("toggled")) return;
    if (sidebar.contains(event.target) || menuToggle.contains(event.target)) return;
    closeMenu();
  });
}

export function getVisiblePageTokens(totalPages, activePage) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  if (activePage <= 2) {
    return [1, 2, 3, "...", totalPages];
  }

  if (activePage >= totalPages - 1) {
    return [1, "...", totalPages - 2, totalPages - 1, totalPages];
  }

  return [1, "...", activePage - 1, activePage, activePage + 1, "...", totalPages];
}

export function buildPageButton(labelHtml, page, {
  disabled = false,
  active = false,
  ellipsis = false
} = {}) {
  const itemClasses = [
    "page-item",
    disabled ? "disabled" : "",
    active ? "active" : "",
    ellipsis ? "ellipsis" : ""
  ].filter(Boolean).join(" ");

  if (disabled || ellipsis || !page) {
    return `<li class="${itemClasses}"><span class="page-link">${labelHtml}</span></li>`;
  }

  return `<li class="${itemClasses}"><button type="button" class="page-link" data-page="${page}">${labelHtml}</button></li>`;
}
