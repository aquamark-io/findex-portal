// Report form: show evidence examples for the chosen category, show the default-notice upload only for
// default reports, format EIN / SSN last 4, and disable the button while uploading.
(function () {
  var form = document.getElementById('report-form');
  if (!form) return;
  var cat = document.getElementById('category');
  var hint = document.getElementById('evidence-hint');
  var dnField = document.getElementById('default-notice-field');
  var dnInput = document.getElementById('default_notice');

  function sync() {
    var opt = cat.options[cat.selectedIndex];
    hint.textContent = opt && opt.getAttribute('data-hint') ? 'Examples: ' + opt.getAttribute('data-hint') : 'Choose a category to see examples of acceptable evidence.';
    var needsNotice = opt && opt.getAttribute('data-default') === '1';
    dnField.hidden = !needsNotice;
    dnInput.disabled = !needsNotice;
    dnInput.required = needsNotice;
  }
  cat.addEventListener('change', sync);

  form.addEventListener('input', function (e) {
    var t = e.target;
    if (t.name === 'subject_ssn_last4') t.value = t.value.replace(/\D/g, '').slice(0, 4);
    if (t.name === 'subject_ein') {
      var d = t.value.replace(/\D/g, '').slice(0, 9);
      t.value = d.length > 2 ? d.slice(0, 2) + '-' + d.slice(2) : d;
    }
  });

  var files = document.getElementById('evidence');
  files.addEventListener('change', function () {
    var msg = '';
    if (files.files.length > 10) msg = 'Up to 10 files per report.';
    for (var i = 0; i < files.files.length && !msg; i++) if (files.files[i].size > 25 * 1024 * 1024) msg = '“' + files.files[i].name + '” is larger than 25 MB.';
    files.setCustomValidity(msg);
    if (msg) files.reportValidity();
  });

  form.addEventListener('submit', function () {
    var btn = form.querySelector('button[type="submit"]');
    setTimeout(function () { if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; } }, 0);
  });

  sync();
})();
