// Shows the fields for the chosen account type. Inputs in hidden sections are disabled
// so they aren't submitted (several sections share field names).
(function () {
  var form = document.getElementById('access-form');
  if (!form) return;
  var intro = document.getElementById('intro');
  var title = document.querySelector('.title');

  function setSection(el, on) {
    el.hidden = !on;
    if (el.tagName === 'FIELDSET') el.disabled = !on;
  }

  function syncIdentity() {
    var section = form.querySelector('[data-section="merchant"]');
    var picked = form.querySelector('input[name="identity_method"]:checked');
    var method = picked ? picked.value : 'ein';
    section.querySelectorAll('[data-identity]').forEach(function (el) {
      var on = el.getAttribute('data-identity') === method;
      el.hidden = !on;
      el.querySelectorAll('input').forEach(function (i) { i.disabled = !on || section.disabled; });
    });
  }

  function sync() {
    var picked = form.querySelector('input[name="account_type"]:checked');
    var type = picked ? picked.value : 'company';
    form.querySelectorAll('[data-section]').forEach(function (el) { setSection(el, el.getAttribute('data-section') === type); });
    document.querySelectorAll('[data-show]').forEach(function (el) {
      el.hidden = el.getAttribute('data-show').split(' ').indexOf(type) === -1;
    });
    if (intro) intro.textContent = intro.getAttribute('data-' + type);
    if (title) title.textContent = type === 'company' ? 'Request Access' : 'Check My Record';
    syncIdentity();
    var url = new URL(window.location.href);
    url.searchParams.set('type', type);
    window.history.replaceState(null, '', url);
  }

  form.addEventListener('change', function (e) {
    if (e.target.name === 'account_type') sync();
    if (e.target.name === 'identity_method') syncIdentity();
  });

  // Digits only for SSN last 4; format EIN as XX-XXXXXXX.
  form.addEventListener('input', function (e) {
    if (e.target.name === 'ssn_last4') e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
    if (e.target.name === 'ein') {
      var d = e.target.value.replace(/\D/g, '').slice(0, 9);
      e.target.value = d.length > 2 ? d.slice(0, 2) + '-' + d.slice(2) : d;
    }
  });

  // Browser validation only for the visible section; the server validates everything again.
  form.noValidate = false;
  form.addEventListener('submit', function () {
    var btn = form.querySelector('button[type="submit"]');
    setTimeout(function () { if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; } }, 0);
  });

  sync();
})();
