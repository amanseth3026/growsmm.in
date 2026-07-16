// Enhances sidebar: wraps logo, adds close button + wallet card
(function(){
  function enhance(){
    const sb = document.getElementById('panelSidebar') || document.querySelector('.sidebar');
    if(!sb || sb.dataset.modernized) return;
    sb.dataset.modernized = '1';

    // Remove any legacy duplicates injected by panel-theme.js
    sb.querySelectorAll('.sidebar-wallet, .sidebar-close-btn').forEach((el)=>el.remove());

    // Logo row: wrap existing content in .logo-left, add close btn
    const logo = sb.querySelector('.logo');
    if(logo && !logo.querySelector('.logo-left')){
      const inner = document.createElement('span');
      inner.className = 'logo-left';
      while(logo.firstChild) inner.appendChild(logo.firstChild);
      logo.appendChild(inner);
      const close = document.createElement('button');
      close.type='button';close.className='sidebar-close';close.setAttribute('aria-label','Close menu');
      close.innerHTML='<i class="fa-solid fa-xmark"></i>';
      close.addEventListener('click', ()=>{
        sb.classList.remove('open','show','active');
        document.body.classList.remove('sidebar-open');
        const ov = document.getElementById('panelOverlay'); if(ov) ov.classList.remove('show','active');
      });
      logo.appendChild(close);
    }

    // Wallet card after logo
    if(!sb.querySelector('.wallet-card')){
      const wc = document.createElement('div');
      wc.className = 'wallet-card';
      wc.innerHTML = `
        <div class="wc-label">Wallet Balance</div>
        <div class="wc-amount" id="sidebarBalance" data-balance-target>₹0.00</div>
        <a class="wc-btn" href="addfunds.html">Add funds</a>`;
      const menu = sb.querySelector('.sidebar-menu');
      if(menu) sb.insertBefore(wc, menu); else sb.appendChild(wc);
    }
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', enhance);
  else enhance();
})();
