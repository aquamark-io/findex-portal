// Sign-up form helpers:
//  - funded business: switch between EIN and owner details (hidden fieldsets are disabled)
//  - format phone as (415) 555-1212 and SSN last 4 / EIN as you type
//  - check email, phone, and (for companies) email-vs-website domain when leaving a field and on submit,
//    with the message shown under the field. The server checks everything again.
(function () {
  var form = document.getElementById('access-form');
  if (!form) return;
  var isCompany = (form.querySelector('input[name="account_type"]') || {}).value === 'company';
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

  function syncIdentity() {
    var picked = form.querySelector('input[name="identity_method"]:checked');
    if (!picked) return;
    form.querySelectorAll('fieldset[data-identity]').forEach(function (el) {
      var on = el.getAttribute('data-identity') === picked.value;
      el.hidden = !on;
      el.disabled = !on;
    });
  }

  function showError(input, msg) {
    input.setCustomValidity(msg || '');
    var field = input.closest('.field');
    if (!field) return;
    var el = field.querySelector('.field-error');
    if (msg) {
      if (!el) { el = document.createElement('p'); el.className = 'field-error'; el.setAttribute('role', 'alert'); field.appendChild(el); }
      el.textContent = msg;
      input.setAttribute('aria-invalid', 'true');
    } else {
      if (el) el.remove();
      input.removeAttribute('aria-invalid');
    }
  }

  function siteDomain() {
    var site = form.querySelector('input[name="website"]');
    if (!site || !site.value.trim()) return '';
    var v = site.value.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[\/?#:]/)[0];
    return v.replace(/^www\./, '');
  }

  function checkEmail() {
    var input = form.querySelector('input[name="email"]');
    if (!input) return true;
    var v = input.value.trim().toLowerCase();
    if (!v) { showError(input, ''); return true; } // "required" handles empty
    if (!EMAIL_RE.test(v)) { showError(input, 'Enter a valid email address, like name@company.com.'); return false; }
    if (isCompany) {
      var emailDomain = v.split('@')[1], d = siteDomain();
      if (d && !(emailDomain === d || emailDomain.slice(-(d.length + 1)) === '.' + d || d.slice(-(emailDomain.length + 1)) === '.' + emailDomain)) {
        showError(input, 'Must match website domain (' + d + ').'); return false;
      }
    }
    showError(input, ''); return true;
  }

  function phoneDigits(v) {
    var d = v.replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    return d;
  }

  function checkPhone() {
    var input = form.querySelector('input[name="phone"]');
    if (!input) return true;
    var v = input.value.trim();
    if (!v) { showError(input, ''); return true; }
    var ok = v[0] === '+' ? (function (n) { return n >= 8 && n <= 15; })(v.replace(/\D/g, '').length) : phoneDigits(v).length === 10;
    showError(input, ok ? '' : 'Enter a 10-digit phone number, or start with + and a country code.');
    return ok;
  }

  function formatPhone(input) {
    var v = input.value;
    if (v.trim()[0] === '+') return; // international: leave as typed
    var d = phoneDigits(v).slice(0, 10);
    var out = d.length > 6 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6)
      : d.length > 3 ? '(' + d.slice(0, 3) + ') ' + d.slice(3)
      : d;
    input.value = out;
  }

  form.addEventListener('change', function (e) {
    if (e.target.name === 'identity_method') syncIdentity();
  });

  form.addEventListener('input', function (e) {
    var t = e.target;
    if (t.name === 'ssn_last4') t.value = t.value.replace(/\D/g, '').slice(0, 4);
    if (t.name === 'ein') {
      var d = t.value.replace(/\D/g, '').slice(0, 9);
      t.value = d.length > 2 ? d.slice(0, 2) + '-' + d.slice(2) : d;
    }
    if (t.name === 'phone') formatPhone(t);
    // Clear an error as soon as the field becomes valid.
    if (t.name === 'email' && t.getAttribute('aria-invalid')) checkEmail();
    if (t.name === 'phone' && t.getAttribute('aria-invalid')) checkPhone();
    if (t.name === 'website' && isCompany) { var em = form.querySelector('input[name="email"]'); if (em && em.getAttribute('aria-invalid')) checkEmail(); }
  });

  form.addEventListener('focusout', function (e) {
    if (e.target.name === 'email') checkEmail();
    if (e.target.name === 'phone') checkPhone();
    if (e.target.name === 'website' && isCompany) { var em = form.querySelector('input[name="email"]'); if (em && em.value) checkEmail(); }
  });

  form.addEventListener('submit', function (e) {
    var ok = checkEmail() & checkPhone();
    if (!ok) {
      e.preventDefault();
      var bad = form.querySelector('[aria-invalid="true"]');
      if (bad) bad.focus();
      return;
    }
    var btn = form.querySelector('button[type="submit"]');
    setTimeout(function () { if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; } }, 0);
  });

  syncIdentity();
})();
