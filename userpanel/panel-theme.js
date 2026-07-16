(function () {
  function byId(id) {
    return document.getElementById(id);
  }

  function runWhenIdle(task) {
    if (typeof task !== "function") return;
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(task, { timeout: 1200 });
    } else {
      setTimeout(task, 180);
    }
  }

  function optimizeImages() {
    const images = document.querySelectorAll("img");
    images.forEach((img, index) => {
      if (!img.getAttribute("decoding")) {
        img.setAttribute("decoding", "async");
      }
      if (!img.getAttribute("loading") && index > 0 && !img.closest(".logo")) {
        img.setAttribute("loading", "lazy");
      }
      if (!img.getAttribute("fetchpriority")) {
        img.setAttribute("fetchpriority", index === 0 ? "high" : "low");
      }
    });
  }

  const sidebar = byId("panelSidebar");
  const overlay = byId("panelOverlay");
  const toggleBtn = byId("panelMobileToggle");
  const prefetchedRoutes = new Set();
  let deferredInstallPrompt = null;
  let walletObserver = null;

  function ensureSidebarWidgets() {
    if (!sidebar) return;

    const logo = sidebar.querySelector(".logo");
    const menu = sidebar.querySelector(".sidebar-menu");
    

    // Close button + wallet card are injected by modern-sidebar.js (single source of truth).
    // Remove any legacy duplicates in case they were rendered by an older build.
    sidebar.querySelectorAll(".sidebar-close-btn").forEach((el) => el.remove());
    sidebar.querySelectorAll(".sidebar-wallet").forEach((el) => el.remove());

    let footer = sidebar.querySelector(".sidebar-footer");
    if (!footer) {
      footer = document.createElement("div");
      footer.className = "sidebar-footer";
      if (menu?.nextSibling) {
        sidebar.insertBefore(footer, menu.nextSibling);
      } else {
        sidebar.appendChild(footer);
      }
    }

    // Remove any existing logout/menu link variants (different path styles)
    const menuLogoutLink = sidebar.querySelector('.sidebar-menu a[href*="#logout"]');
    if (menuLogoutLink) {
      menuLogoutLink.closest("li")?.remove();
    }

    // Only append a single signout link if no other logout link (any href variant) exists
    if (footer && !footer.querySelector('a[href*="#logout"]')) {
      const signoutLink = document.createElement("a");
      signoutLink.href = "account.html#logout";
      signoutLink.className = "sidebar-signout-link";
      signoutLink.innerHTML = '<i class="fa-solid fa-right-from-bracket"></i> Log out';
      footer.appendChild(signoutLink);
    }

    sidebar.querySelectorAll(".sidebar-menu [data-community-link]").forEach((communityLink) => {
      communityLink.closest("li")?.remove();
    });
  }

  function setSidebarWalletAmount(value) {
    const amountEl = byId("sidebarWalletAmount");
    if (!amountEl) return;
    const clean = String(value || "").trim();
    if (!clean || clean.toLowerCase().includes("loading")) return;
    amountEl.textContent = clean.includes("₹") ? clean : `₹${clean}`;
  }

  function setupSidebarWalletSync() {
    setSidebarWalletAmount("0.00");
    const userBalanceEl = byId("userBalance");
    if (!userBalanceEl) return;

    setSidebarWalletAmount(userBalanceEl.textContent);

    if (walletObserver) {
      walletObserver.disconnect();
    }
    walletObserver = new MutationObserver(() => {
      setSidebarWalletAmount(userBalanceEl.textContent);
    });
    walletObserver.observe(userBalanceEl, {
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  function toggleSidebar(forceOpen) {
    if (!sidebar || !overlay) return;

    const shouldOpen =
      typeof forceOpen === "boolean"
        ? forceOpen
        : !sidebar.classList.contains("show");

    sidebar.classList.toggle("show", shouldOpen);
    overlay.classList.toggle("show", shouldOpen);
  }

  function closeSidebar() {
    toggleSidebar(false);
  }

  function setActiveSidebarLink() {
    const current = (location.pathname || "").split("/").pop().toLowerCase();
    const links = document.querySelectorAll(".sidebar-menu a[href], .sidebar-footer a[href]");
    links.forEach((link) => {
      const href = (link.getAttribute("href") || "").split("/").pop().toLowerCase();
      link.classList.toggle("active", !!current && current === href);
    });
  }

  function ensurePwaTags() {
    if (!document.querySelector('link[rel="manifest"]')) {
      const manifestLink = document.createElement("link");
      manifestLink.rel = "manifest";
      manifestLink.href = "/manifest.webmanifest";
      document.head.appendChild(manifestLink);
    }

    if (!document.querySelector('meta[name="theme-color"]')) {
      const themeColor = document.createElement("meta");
      themeColor.name = "theme-color";
      themeColor.content = "#0f172a";
      document.head.appendChild(themeColor);
    }
  }

  function ensureConnectionHints() {
    const origins = [
      "https://www.gstatic.com",
      "https://cdn.jsdelivr.net",
      "https://cdnjs.cloudflare.com"
    ];

    origins.forEach((origin) => {
      const existing = document.querySelector(`link[rel="preconnect"][href="${origin}"]`);
      if (!existing) {
        const preconnect = document.createElement("link");
        preconnect.rel = "preconnect";
        preconnect.href = origin;
        if (origin === "https://www.gstatic.com") {
          preconnect.crossOrigin = "anonymous";
        }
        document.head.appendChild(preconnect);
      }

      const dnsPrefetch = document.querySelector(`link[rel="dns-prefetch"][href="${origin}"]`);
      if (!dnsPrefetch) {
        const dns = document.createElement("link");
        dns.rel = "dns-prefetch";
        dns.href = origin;
        document.head.appendChild(dns);
      }
    });
  }

  function ensureInstallMenuItem() {
    const menu = document.querySelector(".sidebar-menu");
    if (!menu) return null;

    let installLink = menu.querySelector("[data-install-app]");
    if (installLink) return installLink;

    const installLi = document.createElement("li");
    installLi.innerHTML =
      '<a href="#" data-install-app><i class="fa-solid fa-download"></i> Install App</a>';

    const privacyLink = menu.querySelector('a[href="privacy-details.html"]');
    if (privacyLink && privacyLink.parentElement) {
      menu.insertBefore(installLi, privacyLink.parentElement);
    } else {
      menu.appendChild(installLi);
    }

    installLink = installLi.querySelector("[data-install-app]");
    return installLink;
  }

  function removeInstallMenuItem() {
    const menu = document.querySelector(".sidebar-menu");
    if (!menu) return;

    const installLink = menu.querySelector("[data-install-app]");
    if (!installLink) return;

    const installItem = installLink.closest("li");
    if (installItem && installItem.parentElement === menu) {
      installItem.remove();
      return;
    }

    installLink.remove();
  }

  function setInstallLabel(installLink, label) {
    if (!installLink) return;
    const icon = installLink.querySelector("i");
    installLink.textContent = "";
    if (icon) installLink.appendChild(icon);
    installLink.appendChild(document.createTextNode(` ${label}`));
  }

  function isStandaloneMode() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;

    const register = function () {
      runWhenIdle(function () {
        navigator.serviceWorker
          .register("/sw.js", { updateViaCache: "none" })
          .then(function (registration) {
            return registration.update().catch(function () {});
          })
          .catch(function (err) {
            console.warn("Service worker registration failed:", err);
          });
      });
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
    }
  }

  function prefetchRoute(href) {
    if (!href) return;

    let resolved;
    try {
      resolved = new URL(href, location.href);
    } catch {
      return;
    }

    if (resolved.origin !== location.origin) return;
    if (prefetchedRoutes.has(resolved.pathname)) return;

    prefetchedRoutes.add(resolved.pathname);

    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = resolved.href;
    link.as = "document";
    document.head.appendChild(link);
  }

  function setupRoutePrefetch() {
    const sidebarLinks = document.querySelectorAll(".sidebar-menu a[href], .sidebar-footer a[href]");
    sidebarLinks.forEach((link) => {
      const href = link.getAttribute("href") || "";
      if (!href || href.startsWith("#") || href.startsWith("http")) return;

      const runPrefetch = function () {
        prefetchRoute(href);
      };

      link.addEventListener("mouseenter", runPrefetch, { once: true, passive: true });
      link.addEventListener("focus", runPrefetch, { once: true });
      link.addEventListener("touchstart", runPrefetch, { once: true, passive: true });
    });
  }

  function setupInstallApp() {
    if (isStandaloneMode()) {
      try {
        localStorage.setItem("smmGrowthAppInstalled", "1");
      } catch {
        // Ignore storage failures; standalone mode still hides the button.
      }
      removeInstallMenuItem();
      return;
    }

    if (localStorage.getItem("smmGrowthAppInstalled") === "1") {
      removeInstallMenuItem();
      return;
    }

    const installLink = ensureInstallMenuItem();
    if (!installLink) return;

    setInstallLabel(installLink, "Install App");

    installLink.addEventListener("click", async function (event) {
      event.preventDefault();

      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        try {
          await deferredInstallPrompt.userChoice;
        } catch (err) {
          console.warn("Install prompt failed:", err);
        }
        deferredInstallPrompt = null;
        return;
      }

      const ua = navigator.userAgent.toLowerCase();
      const isIOS = /iphone|ipad|ipod/.test(ua);
      if (isIOS) {
        alert('iPhone/iPad me Share button dabao aur "Add to Home Screen" select karo.');
        return;
      }

      if (!window.isSecureContext) {
        alert("Install app ke liye HTTPS required hai.");
        return;
      }

      alert('Agar prompt nahi aa raha, browser menu me "Install app" ya "Add to Home Screen" use karein.');
    });

    window.addEventListener("beforeinstallprompt", function (event) {
      event.preventDefault();
      deferredInstallPrompt = event;
      setInstallLabel(installLink, "Install App");
    });

    window.addEventListener("appinstalled", function () {
      deferredInstallPrompt = null;
      try {
        localStorage.setItem("smmGrowthAppInstalled", "1");
      } catch {
        // Ignore storage failures; the current session will still hide the button.
      }
      removeInstallMenuItem();
    });
  }

  if (toggleBtn) {
    toggleBtn.addEventListener("click", function () {
      toggleSidebar();
    });
  }

  if (overlay) {
    overlay.addEventListener("click", closeSidebar);
  }

  ensureSidebarWidgets();
  setupSidebarWalletSync();
  optimizeImages();
  ensureConnectionHints();
  ensurePwaTags();
  registerServiceWorker();
  runWhenIdle(setupInstallApp);
  runWhenIdle(setupRoutePrefetch);

  // Load shared balance loader to populate wallet balance across pages
  try {
    if (typeof window !== 'undefined') {
      import('./balance-loader.js').catch(() => {});
    }
  } catch (e) {
    // ignore import errors
  }

  document.querySelectorAll(".sidebar-menu a, .sidebar-footer a").forEach((link) => {
    link.addEventListener("click", function () {
      if (window.innerWidth <= 992) closeSidebar();
    });
  });

  window.toggleSidebar = toggleSidebar;
  setActiveSidebarLink();
})();
