// Small UI enhancements to bring userpanel closer to admin look & behavior
function setPanelName() {
  const nameEls = document.querySelectorAll('[data-panel-name]');
  const mobileEls = document.querySelectorAll('[data-panel-mobile]');
  const title = (document.title || '').replace(/\s+-\s+.*$/, '') || 'Panel';
  nameEls.forEach(el => el.textContent = title);
  mobileEls.forEach(el => el.textContent = title);
}

function ensureMobileToggle() {
  const top = document.querySelector('.top-navbar');
  if (!top) return;
  if (top.querySelector('.mobile-toggle')) return; // already present

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mobile-toggle';
  btn.id = 'panelMobileToggle';
  btn.setAttribute('aria-label', 'Toggle menu');
  btn.innerHTML = '<i class="bi bi-list"></i>';
  btn.addEventListener('click', () => {
    if (typeof window.toggleSidebar === 'function') {
      window.toggleSidebar();
    }
  });

  top.insertBefore(btn, top.firstChild);
}

function subtleEntrance() {
  document.documentElement.style.setProperty('--panel-fade', 'opacity 360ms ease, transform 360ms ease');
  requestAnimationFrame(() => {
    document.body.classList.add('panel-effects-ready');
  });
}

function initEffects() {
  try { setPanelName(); } catch {};
  try { ensureMobileToggle(); } catch {};
  try { subtleEntrance(); } catch {};
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initEffects);
} else {
  initEffects();
}

export default {};
