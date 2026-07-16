/* Modern chrome injector — replaces legacy nav/footer on public pages
   and adds a footer bar to userpanel pages. */
(function(){
  'use strict';

  var isPanel = document.body && document.body.classList.contains('panel-theme');
  var path = (location.pathname || '').toLowerCase();

  document.body.classList.add('mc-ready');

  /* Ensure Space Grotesk + Inter are loaded */
  if(!document.querySelector('link[href*="Space+Grotesk"]')){
    var pc1=document.createElement('link');pc1.rel='preconnect';pc1.href='https://fonts.googleapis.com';document.head.appendChild(pc1);
    var pc2=document.createElement('link');pc2.rel='preconnect';pc2.href='https://fonts.gstatic.com';pc2.crossOrigin='';document.head.appendChild(pc2);
    var f=document.createElement('link');f.rel='stylesheet';f.href='https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap';document.head.appendChild(f);
  }
  if(!document.querySelector('link[href*="bootstrap-icons"]')){
    var bi=document.createElement('link');bi.rel='stylesheet';bi.href='https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.1/font/bootstrap-icons.css';document.head.appendChild(bi);
  }

  /* ========== PUBLIC PAGES ========== */
  if(!isPanel){
    var navLinks = [
      {href:'/index.html', label:'Home', match:['/','/index.html']},
      {href:'/pages/services.html', label:'Services', match:['/pages/services.html']},
      {href:'/pages/api.html', label:'API', match:['/pages/api.html','/pages/api-test.html']},
      {href:'/pages/blog.html', label:'Blog', match:['/pages/blog.html','/blog']},
      {href:'/userpanel/account.html', label:'Dashboard', match:['/userpanel/']}
    ];
    var isActive = function(l){
      return l.match.some(function(m){ return path===m || (m.endsWith('/')?path.indexOf(m)===0:path===m); });
    };

    var navHTML =
      '<div class="mc-navwrap" id="mcNav">'+
      '<div class="mc-nav">'+
        '<a class="mc-brand" href="/"><img src="/logo.png" alt="GrowSMM"><span data-panel-name>GrowSMM</span></a>'+
        '<button class="mc-toggler" id="mcTog" aria-label="Menu"><i class="bi bi-list"></i></button>'+
        '<nav class="mc-menu" id="mcMenu">'+
          navLinks.map(function(l){return '<a href="'+l.href+'"'+(isActive(l)?' class="active"':'')+'>'+l.label+'</a>';}).join('')+
        '</nav>'+
        '<div class="mc-cta">'+
          '<a href="/pages/signup.html" class="mc-btn-ghost"><i class="bi bi-person-plus"></i> Sign up</a>'+
          '<a href="/userpanel/account.html" class="mc-btn-grad"><i class="bi bi-box-arrow-in-right"></i> Login</a>'+
        '</div>'+
      '</div></div>';

    var footerHTML =
      '<footer class="mc-footer" id="mcFooter"><div class="mc-footer-inner">'+
        '<div class="mc-footer-grid">'+
          '<div>'+
            '<a class="mc-brand" href="/"><img src="/logo.png" alt="GrowSMM"><span>GrowSMM</span></a>'+
            '<p class="about">India\'s most trusted & affordable SMM Panel. Instant Instagram, YouTube, Telegram growth with a secure API and 24/7 support.</p>'+
            '<div class="mc-social">'+
              '<a href="https://wa.me/919219102061" aria-label="WhatsApp" target="_blank" rel="noopener"><i class="bi bi-whatsapp"></i></a>'+
              '<a href="mailto:support@growsmm.in" aria-label="Email"><i class="bi bi-envelope"></i></a>'+
              '<a href="https://t.me/growsmm" aria-label="Telegram" target="_blank" rel="noopener"><i class="bi bi-telegram"></i></a>'+
              '<a href="https://instagram.com/growsmm" aria-label="Instagram" target="_blank" rel="noopener"><i class="bi bi-instagram"></i></a>'+
            '</div>'+
          '</div>'+
          '<div><h5>Product</h5>'+
            '<a href="/pages/services.html">Services</a>'+
            '<a href="/pages/api.html">API Docs</a>'+
            '<a href="/pages/signup.html">Sign Up</a>'+
            '<a href="/userpanel/account.html">Dashboard</a>'+
          '</div>'+
          '<div><h5>Resources</h5>'+
            '<a href="/pages/blog.html">Blog</a>'+
            '<a href="/pages/blog.html">Guides</a>'+
            '<a href="/faq">FAQs</a>'+
            '<a href="mailto:support@growsmm.in">Support</a>'+
          '</div>'+
          '<div><h5>Contact</h5>'+
            '<a href="https://wa.me/919219102061"><i class="bi bi-whatsapp me-2"></i>+91 9219102061</a>'+
            '<a href="mailto:support@growsmm.in"><i class="bi bi-envelope me-2"></i>support@growsmm.in</a>'+
            '<div class="mc-badges" style="margin-top:14px">'+
              '<span class="mc-badge"><span class="dot"></span> All systems online</span>'+
            '</div>'+
          '</div>'+
        '</div>'+
        '<div class="mc-footer-bottom">'+
          '<div>© '+new Date().getFullYear()+' GrowSMM. All rights reserved.</div>'+
          '<div class="mc-badges">'+
            '<span class="mc-badge">Secure UPI · Cards · Wallets</span>'+
            '<span class="mc-badge">Made in India</span>'+
          '</div>'+
        '</div>'+
      '</div></footer>';

    /* Replace existing nav */
    var oldNav = document.querySelector('nav.navbar, header.site-header, .top-nav');
    if(oldNav){
      var holder=document.createElement('div');holder.innerHTML=navHTML;
      oldNav.parentNode.replaceChild(holder.firstElementChild, oldNav);
    } else {
      document.body.insertAdjacentHTML('afterbegin', navHTML);
    }
    /* Replace existing footer */
    var oldFooter = document.querySelector('footer:not(.mc-footer)');
    if(oldFooter){
      var fh=document.createElement('div');fh.innerHTML=footerHTML;
      oldFooter.parentNode.replaceChild(fh.firstElementChild, oldFooter);
    } else {
      document.body.insertAdjacentHTML('beforeend', footerHTML);
    }

    /* Interactions */
    var tog=document.getElementById('mcTog'), menu=document.getElementById('mcMenu');
    if(tog&&menu){ tog.addEventListener('click',function(){ menu.classList.toggle('open'); }); }
    var nav=document.getElementById('mcNav');
    if(nav){ window.addEventListener('scroll',function(){ nav.classList.toggle('scrolled', window.scrollY>10); },{passive:true}); }
  }

  /* ========== USER PANEL: add footer bar & polish ========== */
  if(isPanel){
    if(!document.querySelector('.mc-panel-footer')){
      var main=document.querySelector('.main-content')||document.body;
      var pf=document.createElement('div');
      pf.className='mc-panel-footer';
      pf.innerHTML=
        '<div>© '+new Date().getFullYear()+' <strong style="color:#fff">GrowSMM</strong> · India\'s trusted SMM Panel</div>'+
        '<div class="links">'+
          '<a href="/pages/services.html">Services</a>'+
          '<a href="/userpanel/api.html">API</a>'+
          '<a href="/userpanel/help.html">Support</a>'+
          '<a href="/userpanel/privacy-details.html">Privacy</a>'+
        '</div>';
      main.appendChild(pf);
    }
  }
})();
