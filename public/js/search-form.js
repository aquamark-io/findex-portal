// Search form: show the employment certification + authorization upload only for employment screening,
// and format ZIP / EIN.
(function () {
  var form = document.getElementById('search-form');
  if (!form) return;
  var purpose = document.getElementById('purpose');
  var emp = document.getElementById('employment-fields');
  function sync() { if (!emp || !purpose) return; var on = purpose.value === 'employment'; emp.hidden = !on; emp.disabled = !on; }
  if (purpose) purpose.addEventListener('change', sync);
  form.addEventListener('input', function (e) {
    var t = e.target;
    if (t.name === 'zip') t.value = t.value.replace(/\D/g, '').slice(0, 5);
    if (t.name === 'ein') { var d = t.value.replace(/\D/g, '').slice(0, 9); t.value = d.length > 2 ? d.slice(0, 2) + '-' + d.slice(2) : d; }
  });
  form.addEventListener('submit', function () {
    var btn = form.querySelector('button[type="submit"]');
    setTimeout(function () { if (btn) { btn.disabled = true; btn.textContent = 'Searching…'; } }, 0);
  });
  sync();
})();
