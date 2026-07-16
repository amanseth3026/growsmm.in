/* Perf boost — runs on every page.
   - Lazy-load offscreen images
   - Async decode
   - Preconnect to firebase/gstatic
   - Defer non-critical work
*/
(function () {
  try {
    // Preconnect hints
    const heads = [
      { rel: "preconnect", href: "https://www.gstatic.com", crossOrigin: "" },
      { rel: "preconnect", href: "https://firestore.googleapis.com", crossOrigin: "" },
      { rel: "preconnect", href: "https://identitytoolkit.googleapis.com", crossOrigin: "" },
      { rel: "dns-prefetch", href: "https://fonts.googleapis.com" },
      { rel: "dns-prefetch", href: "https://fonts.gstatic.com" }
    ];
    heads.forEach(h => {
      if (document.head.querySelector(`link[rel="${h.rel}"][href="${h.href}"]`)) return;
      const l = document.createElement("link");
      Object.assign(l, h);
      document.head.appendChild(l);
    });

    // Lazy-load & async decode for images
    const applyImg = (img) => {
      if (!img.loading) img.loading = "lazy";
      if (!img.decoding) img.decoding = "async";
      if (img.fetchPriority == null && img.dataset.priority !== "high") img.fetchPriority = "low";
    };
    document.querySelectorAll("img").forEach(applyImg);
    new MutationObserver(muts => {
      muts.forEach(m => m.addedNodes.forEach(n => {
        if (n.nodeType !== 1) return;
        if (n.tagName === "IMG") applyImg(n);
        n.querySelectorAll && n.querySelectorAll("img").forEach(applyImg);
      }));
    }).observe(document.documentElement, { childList: true, subtree: true });

    // Passive listeners for smoother scroll
    const origAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, opts) {
      if (type === "touchstart" || type === "touchmove" || type === "wheel") {
        if (opts == null || opts === false) opts = { passive: true };
        else if (typeof opts === "object" && opts.passive === undefined) opts = { ...opts, passive: true };
      }
      return origAdd.call(this, type, fn, opts);
    };
  } catch (e) { /* no-op */ }
})();
