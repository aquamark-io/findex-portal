// Funded-business form: switch between EIN and owner details. Hidden fieldsets are disabled
// so their fields aren't required or submitted. Also formats SSN last 4 and EIN as you type.
(function () {
  var form = document.getElementById('access-form');
  if (!form) return;

  function syncIdentity() {
    var picked = form.querySelector('input[name="identity_method"]:checked');
    if (!picked) return;
    form.querySelectorAll('fieldset[data-identity]').forEach(function (el) {
      var on = el.getAttribute('data-identity') === picked.value;
      el.hidden = !on;
      el.disabled = !on;
    });
  }

  form.addEventListener('change', function (e) {
    if (e.target.name === 'identity_method') syncIdentity();
  });

  form.addEventListener('input', function (e) {
    if (e.target.name === 'ssn_last4') e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
    if (e.target.name === 'ein') {
      var d = e.target.value.replace(/\D/g, '').slice(0, 9);
      e.target.value = d.length > 2 ? d.slice(0, 2) + '-' + d.slice(2) : d;
    }
  });

  form.addEventListener('submit', function () {
    var btn = form.querySelector('button[type="submit"]');
    setTimeout(function () { if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; } }, 0);
  });

  syncIdentity();
})();
