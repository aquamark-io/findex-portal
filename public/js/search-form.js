// Search form: show the employment certification + authorization upload only for employment screening,
// and format SSN last 4 / EIN.
(function () {
  var form = document.getElementById('search-form');
  if (!form) return;
  var purpose = document.getElementById('purpose');
  var emp = document.getElementById('employment-fields');
  function sync() { if (!emp) return; var on = purpose.value === 'employment'; emp.hidden = !on; emp.disabled = !on; }
  purpose.addEventListener('change', sync);
  form.addEventListener('input', function (e) {
    var t = e.target;
    if (t.name === 'ssn_last4') t.value = t.value.replace(/\D/g, '').slice(0, 4);
    if (t.name === 'ein') { var d = t.value.replace(/\D/g, '').slice(0, 9); t.value = d.length > 2 ? d.slice(0, 2) + '-' + d.slice(2) : d; }
  });
  form.addEventListener('submit', function () {
    var btn = form.querySelector('button[type="submit"]');
    setTimeout(function () { if (btn) { btn.disabled = true; btn.textContent = 'Searching…'; } }, 0);
  });
  sync();
})();
