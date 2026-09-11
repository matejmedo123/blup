/* Správa webu Majáles — drobnosti, ktoré uľahčujú prácu.
   Nič z toho nie je nutné: každá akcia má aj obyčajný formulár. */
(function () {
  'use strict';

  /* Bočné menu na telefóne. */
  var toggle = document.getElementById('side-toggle');
  var side = document.getElementById('side');
  if (toggle && side) {
    toggle.addEventListener('click', function () {
      var open = side.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    side.addEventListener('click', function (e) {
      if (e.target.closest('a')) { side.classList.remove('is-open'); }
    });
  }

  /* Potvrdenie pri mazaní — zmazané sa nedá vrátiť. */
  document.addEventListener('submit', function (e) {
    var msg = e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) { e.preventDefault(); }
  });

  /* Výber fotky z knižnice. */
  var picker = document.getElementById('media-picker');
  if (picker) {
    var activeField = null;

    var open = function (field) {
      activeField = field;
      picker.hidden = false;
      var current = field.querySelector('input[type="hidden"]').value;
      Array.prototype.forEach.call(picker.querySelectorAll('.mediacard'), function (card) {
        card.classList.toggle('is-picked', card.getAttribute('data-id') === current);
      });
      var close = picker.querySelector('[data-picker-close]');
      if (close) { close.focus(); }
    };

    var close = function () {
      picker.hidden = true;
      if (activeField) {
        var btn = activeField.querySelector('[data-pick]');
        if (btn) { btn.focus(); }
      }
      activeField = null;
    };

    document.addEventListener('click', function (e) {
      var pick = e.target.closest('[data-pick]');
      if (pick) {
        e.preventDefault();
        open(pick.closest('.field'));
        return;
      }

      var clear = e.target.closest('[data-pick-clear]');
      if (clear) {
        e.preventDefault();
        var field = clear.closest('.field');
        field.querySelector('input[type="hidden"]').value = '';
        var box = field.querySelector('.mediapick__preview');
        box.outerHTML = '<div class="mediapick__preview">Zatiaľ bez fotky</div>';
        return;
      }

      if (e.target.closest('[data-picker-close]') || e.target === picker) {
        close();
        return;
      }

      var card = e.target.closest('.mediacard');
      if (card && activeField && picker.contains(card)) {
        activeField.querySelector('input[type="hidden"]').value = card.getAttribute('data-id');
        var preview = activeField.querySelector('.mediapick__preview');
        var img = document.createElement('img');
        img.className = 'mediapick__preview';
        img.src = card.getAttribute('data-src');
        img.alt = '';
        preview.replaceWith(img);
        close();
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !picker.hidden) { close(); }
    });
  }

  /* Počítadlo znakov pri poliach s limitom. */
  Array.prototype.forEach.call(document.querySelectorAll('[data-counter]'), function (el) {
    var max = parseInt(el.getAttribute('maxlength') || '0', 10);
    if (!max) { return; }
    var out = document.createElement('p');
    out.className = 'field__hint';
    var render = function () {
      var left = max - el.value.length;
      out.textContent = left < 40 ? 'Zostáva ' + left + ' znakov.' : '';
    };
    el.insertAdjacentElement('afterend', out);
    el.addEventListener('input', render);
    render();
  });
})();
