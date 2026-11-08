// Report form:
//  - evidence files add up across picks (the browser normally replaces the selection), shown as a list
//    with remove buttons; max 10 files, 25 MB each
//  - evidence examples for the chosen category; default-notice upload only for default reports
//  - EIN / SSN last 4 formatting; button disabled while uploading
(function () {
  var form = document.getElementById('report-form');
  if (!form) return;
  var MAX = 10, MAX_BYTES = 25 * 1024 * 1024;
  var cat = document.getElementById('category');
  var hint = document.getElementById('evidence-hint');
  var dnField = document.getElementById('default-notice-field');
  var dnInput = document.getElementById('default_notice');
  var input = document.getElementById('evidence');
  var list = document.getElementById('evidence-list');
  var picked = [];

  function sync() {
    var opt = cat.options[cat.selectedIndex];
    var req = opt && opt.getAttribute('data-req');
    var box = document.getElementById('evidence-req'), list = document.getElementById('evidence-req-list');
    hint.hidden = !!req; box.hidden = !req; list.innerHTML = '';
    var items = []; try { items = req ? JSON.parse(req) : []; } catch (e) { items = []; }
    items.forEach(function (t) {
      var li = document.createElement('li');
      if (Array.isArray(t)) { var b = document.createElement('strong'); b.textContent = t[0] + ':'; li.appendChild(b); li.appendChild(document.createTextNode(' ' + t[1])); }
      else li.textContent = t;
      list.appendChild(li);
    });
    var guide = document.getElementById('evidence-guide'), g = (opt && opt.getAttribute('data-guide')) || '';
    guide.innerHTML = '';
    g.split(/\n\s*\n/).forEach(function (para) { if (!para.trim()) return; var el = document.createElement('p'); el.textContent = para.trim(); guide.appendChild(el); });
    guide.hidden = !g;
    var repay = !!(opt && opt.getAttribute('data-repay'));
    var amountLabel = opt && opt.getAttribute('data-amount-label');
    document.getElementById('repayment-fields').hidden = !amountLabel;
    var amt = document.getElementById('payment_amount'); amt.disabled = !amountLabel; amt.required = !!amountLabel;
    if (amountLabel) document.getElementById('payment_amount_label').textContent = amountLabel;
    var delinq = !!(opt && opt.getAttribute('data-delinquency'));
    document.getElementById('delinquency-fields').hidden = !delinq;
    document.getElementById('api-note').hidden = !delinq;
    ['payment_frequency', 'missed_count'].forEach(function (id) { var el = document.getElementById(id); el.disabled = !delinq; el.required = delinq; });
    document.getElementById('description').required = !repay;
    document.getElementById('description_opt').hidden = !repay;
    document.getElementById('incident_date_label').textContent = (opt && opt.getAttribute('data-date-label')) || 'Incident date';
    document.getElementById('date_hint').textContent = !(opt && opt.value) ? '' : delinq ? 'The date of the third missed payment, within the past 90 days.' : repay ? 'Within the past 90 days.' : 'Within the past 7 years.';
    var needsNotice = opt && opt.getAttribute('data-default') === '1';
    dnField.hidden = !needsNotice;
    dnInput.disabled = !needsNotice;
    dnInput.required = needsNotice;
  }
  cat.addEventListener('change', sync);

  var canSet = typeof DataTransfer !== 'undefined';
  function size(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  function render() {
    if (canSet) {
      var dt = new DataTransfer();
      picked.forEach(function (f) { dt.items.add(f); });
      input.files = dt.files;
    }
    list.innerHTML = '';
    picked.forEach(function (f, i) {
      var li = document.createElement('li');
      var name = document.createElement('span'); name.textContent = f.name + ' ';
      var sz = document.createElement('span'); sz.className = 'muted'; sz.textContent = '(' + size(f.size) + ')';
      var rm = document.createElement('button'); rm.type = 'button'; rm.className = 'link-btn'; rm.textContent = 'Remove';
      rm.setAttribute('aria-label', 'Remove ' + f.name);
      rm.addEventListener('click', function () { picked.splice(i, 1); render(); });
      li.appendChild(name); li.appendChild(sz); li.appendChild(document.createTextNode(' ')); li.appendChild(rm);
      list.appendChild(li);
    });
    list.hidden = !picked.length;
    var label = document.getElementById('evidence-count');
    if (label) label.textContent = picked.length ? picked.length + ' of ' + MAX + ' files added' : '';
    input.setCustomValidity(picked.length || !input.required ? '' : 'Add at least one evidence file.');
  }

  input.addEventListener('change', function () {
    if (!canSet) return; // very old browsers: keep the native behavior
    var msg = '';
    Array.prototype.forEach.call(input.files, function (f) {
      if (picked.some(function (p) { return p.name === f.name && p.size === f.size; })) return;
      if (f.size > MAX_BYTES) { msg = '“' + f.name + '” is larger than 25 MB.'; return; }
      if (picked.length >= MAX) { msg = 'Up to ' + MAX + ' files per report.'; return; }
      picked.push(f);
    });
    render();
    if (msg) alert(msg);
  });

  form.addEventListener('input', function (e) {
    var t = e.target;
    if (t.name === 'subject_ssn_last4') t.value = t.value.replace(/\D/g, '').slice(0, 4);
    if (t.name === 'subject_ein') {
      var d = t.value.replace(/\D/g, '').slice(0, 9);
      t.value = d.length > 2 ? d.slice(0, 2) + '-' + d.slice(2) : d;
    }
  });

  form.addEventListener('submit', function () {
    var btn = form.querySelector('button[type="submit"]');
    setTimeout(function () { if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; } }, 0);
  });

  sync();
})();
