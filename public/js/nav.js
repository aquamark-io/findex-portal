// Mobile hamburger menu (same behavior as the joinfindex.com homepage).
(function () {
  function init() {
    var band = document.querySelector('.band');
    var btn = document.querySelector('.menu-toggle');
    var menu = document.getElementById('site-nav');
    if (!band || !btn || !menu) return;
    var mq = window.matchMedia('(max-width: 640px)');
    var isOpen = function () { return band.classList.contains('menu-open'); };
    var setOpen = function (open) {
      band.classList.toggle('menu-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    };
    btn.addEventListener('click', function () {
      setOpen(!isOpen());
      if (isOpen()) { var first = menu.querySelector('a, button'); if (first) first.focus({ preventScroll: true }); }
    });
    menu.addEventListener('click', function (e) { if (e.target.closest('a')) setOpen(false); });
    document.addEventListener('click', function (e) { if (isOpen() && !band.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isOpen()) { setOpen(false); btn.focus(); } });
    var onChange = function () { if (!mq.matches) setOpen(false); };
    if (mq.addEventListener) mq.addEventListener('change', onChange); else mq.addListener(onChange);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
