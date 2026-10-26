// Client-side pre-check for the attachment size. This is a convenience only:
// the server enforces the limit.
(function () {
  'use strict';

  var input = document.getElementById('attachment');
  var error = document.getElementById('attachment-error');
  if (!input || !error) return;

  var max = Number(input.getAttribute('data-max-bytes'));
  if (!max) return;

  input.addEventListener('change', function () {
    var file = input.files && input.files[0];
    if (file && file.size > max) {
      input.value = '';
      input.setAttribute('aria-invalid', 'true');
      error.textContent = 'Attachment must be 10 MB or smaller.';
      error.hidden = false;
    } else {
      input.removeAttribute('aria-invalid');
      error.textContent = '';
      error.hidden = true;
    }
  });
})();
