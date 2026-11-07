// Confirm before approve / deny / delete.
document.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-confirm]');
  if (btn && !window.confirm(btn.getAttribute('data-confirm'))) e.preventDefault();
});
