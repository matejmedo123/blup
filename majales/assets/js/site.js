/* =============================================================================
   Majáles Nitra — správanie stránky
   Stránka funguje aj bez tohto súboru: obsah je v HTML, odpovede na otázky
   sa dajú rozkliknúť až po načítaní, ale nič podstatné sa nestratí.
   ============================================================================= */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* --------------------------------------------------------- Postupné zjavenie */

  var revealables = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window) || reduceMotion) {
    document.documentElement.classList.remove('js');
    document.body.classList.remove('js');
  } else {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.05 });

    Array.prototype.forEach.call(revealables, function (el) { observer.observe(el); });
  }
  // Signál pre poistku v hlavičke: skript sa načítal, obsah sa zjaví.
  window.__majalesReady = true;

  /* ------------------------------------------------------- Video v hlavičke */

  var hero = document.getElementById('hero-video');
  if (hero && hero.getAttribute('data-src')) {
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    var pomalePripojenie = !!conn && (conn.saveData === true || /(^|-)2g$/.test(conn.effectiveType || ''));
    // Na úzkej obrazovke je video aj tak orezané na pár percent plochy —
    // nestojí za to sťahovať ho cez mobilné dáta.
    var vhodne = window.innerWidth >= 768 && !pomalePripojenie && !reduceMotion;

    if (vhodne) {
      hero.src = hero.getAttribute('data-src');
      hero.load();
      var prehraj = hero.play();
      // Niektoré prehliadače odmietnu automatické prehratie — nevadí,
      // ostane prvý snímok ako obrázok. Chybu len ticho zhltneme.
      if (prehraj && typeof prehraj.catch === 'function') { prehraj.catch(function () {}); }
    } else {
      hero.remove();
    }
  }

  /* ------------------------------------------------------------------ Odpočet */

  var cd = document.getElementById('countdown');
  if (cd) {
    var target = new Date(cd.getAttribute('data-target')).getTime();
    var fields = {
      days:  cd.querySelector('[data-cd="days"]'),
      hours: cd.querySelector('[data-cd="hours"]'),
      mins:  cd.querySelector('[data-cd="mins"]'),
      secs:  cd.querySelector('[data-cd="secs"]')
    };
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };

    var tick = function () {
      var diff = Math.max(0, target - Date.now());
      var d = Math.floor(diff / 86400000);
      var h = Math.floor((diff % 86400000) / 3600000);
      var m = Math.floor((diff % 3600000) / 60000);
      var s = Math.floor((diff % 60000) / 1000);

      if (fields.days)  fields.days.textContent  = String(d);
      if (fields.hours) fields.hours.textContent = pad(h);
      if (fields.mins)  fields.mins.textContent  = pad(m);
      if (fields.secs)  fields.secs.textContent  = pad(s);

      if (diff === 0) { clearInterval(timer); cd.hidden = true; }
    };
    var timer = setInterval(tick, 1000);
    tick();
  }

  /* ------------------------------------------------------------ Ukazovateľ scrollu */

  var bar = document.getElementById('progress');
  if (bar) {
    var lastPct = -1;
    var onScroll = function (force) {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var pct = max > 0 ? (window.scrollY / max) * 100 : 0;
      // Pár pixelov od konca stránky doťahujeme na plných 100 %, nech
      // pás nekončí na 99 % kvôli zaokrúhľovaniu.
      var atEdge = max <= 0 || window.scrollY >= max - 2 || window.scrollY <= 2;
      if (max > 0 && window.scrollY >= max - 2) { pct = 100; }
      // Na kraji stránky kreslíme vždy, inak až pri viditeľnej zmene —
      // bez toho by brzda zhltla práve to posledné doťiahnutie na 100 %.
      if (force === true || atEdge || Math.abs(pct - lastPct) > 0.5) {
        lastPct = pct;
        bar.style.width = pct.toFixed(1) + '%';
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });

    // Fotky sa načítavajú až keď sa k nim doscrolluje a stránka tým rastie.
    // Bez tohto by pás ostal visieť na starej hodnote.
    if ('ResizeObserver' in window) {
      new ResizeObserver(function () { onScroll(true); }).observe(document.body);
    }
    onScroll(true);
  }

  /* ------------------------------------------------------------- Mobilné menu */

  var burger = document.getElementById('burger');
  var menu = document.getElementById('menu');
  if (burger && menu) {
    var setMenu = function (open) {
      menu.hidden = !open;
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      burger.firstElementChild.textContent = open ? '✕' : '☰';
      burger.lastElementChild.textContent = open ? 'Zavrieť menu' : 'Otvoriť menu';
    };
    burger.addEventListener('click', function () { setMenu(menu.hidden); });
    menu.addEventListener('click', function (e) {
      if (e.target.closest('a')) { setMenu(false); }
    });
    document.addEventListener('click', function (e) {
      if (!menu.hidden && !menu.contains(e.target) && !burger.contains(e.target)) { setMenu(false); }
    });
    window.addEventListener('majales:escape', function () { setMenu(false); });
  }

  /* ------------------------------------------------- Modály: zamknutie a fokus */

  var openDialog = null;
  var lastFocused = null;

  var lockScroll = function (lock) {
    if (lock) {
      // Bez tohto by stránka po skrytí posuvníka poskočila do strany.
      var gap = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.paddingRight = gap > 0 ? gap + 'px' : '';
      document.body.classList.add('is-locked');
    } else {
      document.body.classList.remove('is-locked');
      document.body.style.paddingRight = '';
    }
  };

  var focusables = function (root) {
    return Array.prototype.filter.call(
      root.querySelectorAll('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])'),
      function (el) { return el.offsetParent !== null || el === document.activeElement; }
    );
  };

  var openOverlay = function (el) {
    lastFocused = document.activeElement;
    el.hidden = false;
    openDialog = el;
    lockScroll(true);
    var f = focusables(el);
    if (f.length) { f[0].focus(); }
  };

  var closeOverlay = function () {
    if (!openDialog) { return; }
    openDialog.hidden = true;
    openDialog = null;
    lockScroll(false);
    if (lastFocused && lastFocused.focus) { lastFocused.focus(); }
  };

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      window.dispatchEvent(new CustomEvent('majales:escape'));
      closeOverlay();
      return;
    }
    // Fokus nesmie vyskočiť z otvoreného modálu von na stránku.
    if (e.key === 'Tab' && openDialog) {
      var f = focusables(openDialog);
      if (!f.length) { return; }
      var first = f[0];
      var last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-close]')) { closeOverlay(); return; }
    // Klik mimo obsahu modálu ho zavrie; klik dovnútra nie.
    if (openDialog && e.target === openDialog) { closeOverlay(); }
  });

  /* ---------------------------------------------------------------- Lightbox */

  var lightbox = document.getElementById('lightbox');
  var lightboxImg = document.getElementById('lightbox-img');
  if (lightbox && lightboxImg) {
    document.addEventListener('click', function (e) {
      var item = e.target.closest('.gallery__item');
      if (!item) { return; }
      lightboxImg.src = item.getAttribute('data-photo');
      lightboxImg.alt = item.getAttribute('data-caption') || '';
      openOverlay(lightbox);
    });
  }

  /* ----------------------------------------------------------- Modál interpreta */

  var modal = document.getElementById('artist-modal');
  var dataEl = document.getElementById('artists-data');
  if (modal && dataEl) {
    var artists = {};
    try {
      JSON.parse(dataEl.textContent || '[]').forEach(function (a) { artists[a.slug] = a; });
    } catch (err) {
      artists = {};
    }

    var icons = {
      facebook:  '<path d="M22 12a10 10 0 1 0-11.6 9.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.3c-1.2 0-1.6.8-1.6 1.6V12h2.8l-.4 2.9h-2.4v7A10 10 0 0 0 22 12Z"/>',
      spotify:   '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.3 14.5a.7.7 0 0 1-1 .2c-2.6-1.6-5.9-2-9.8-1.1a.7.7 0 0 1-.3-1.4c4.2-1 7.9-.5 10.8 1.3.3.2.4.7.3 1Zm1.2-2.7a.9.9 0 0 1-1.2.3c-3-1.8-7.5-2.4-11-1.3a.9.9 0 0 1-.5-1.7c4-1.2 9-.6 12.4 1.5.4.2.5.8.3 1.2Zm.1-2.9c-3.5-2.1-9.4-2.3-12.8-1.3a1 1 0 0 1-.6-2c3.9-1.2 10.4-1 14.5 1.4a1 1 0 0 1-1.1 1.9Z"/>',
      youtube:   '<path d="M23 7.2s-.2-1.6-.9-2.3c-.9-.9-1.9-.9-2.3-1C16.6 3.6 12 3.6 12 3.6s-4.6 0-7.8.3c-.4.1-1.4.1-2.3 1-.7.7-.9 2.3-.9 2.3S.8 9.1.8 11v1.8c0 1.9.2 3.8.2 3.8s.2 1.6.9 2.3c.9.9 2 .9 2.5 1 1.8.2 7.6.3 7.6.3s4.6 0 7.8-.4c.4-.1 1.4-.1 2.3-1 .7-.7.9-2.3.9-2.3s.2-1.9.2-3.8V11c0-1.9-.2-3.8-.2-3.8ZM9.7 15V8.4l6.1 3.3-6.1 3.3Z"/>'
    };
    var labels = { facebook: 'Facebook', instagram: 'Instagram', spotify: 'Spotify', youtube: 'YouTube' };

    var iconMarkup = function (net) {
      if (net === 'instagram') {
        return '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#FFF200" stroke-width="2" aria-hidden="true">'
          + '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/>'
          + '<circle cx="17.2" cy="6.8" r="1.2" fill="#FFF200" stroke="none"/></svg>';
      }
      return icons[net]
        ? '<svg width="26" height="26" viewBox="0 0 24 24" fill="#FFF200" aria-hidden="true">' + icons[net] + '</svg>'
        : '';
    };

    var tagEl = document.getElementById('artist-tag');
    var nameEl = document.getElementById('artist-name');
    var descEl = document.getElementById('artist-desc');
    var socialEl = document.getElementById('artist-social');

    document.addEventListener('click', function (e) {
      var card = e.target.closest('.artist');
      if (!card) { return; }
      var a = artists[card.getAttribute('data-artist')];
      if (!a) { return; }

      tagEl.textContent = a.tag;
      tagEl.hidden = !a.tag;
      nameEl.textContent = a.name;
      descEl.textContent = a.bio;
      descEl.hidden = !a.bio;

      socialEl.textContent = '';
      (a.socials || []).forEach(function (pair) {
        var markup = iconMarkup(pair[0]);
        if (!markup) { return; }
        var link = document.createElement('a');
        link.href = pair[1];
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        // Odkaz dostane text pre čítačku a ikonu ako obrázok.
        var vh = document.createElement('span');
        vh.className = 'vh';
        vh.textContent = labels[pair[0]] || pair[0];
        link.appendChild(vh);
        link.insertAdjacentHTML('beforeend', markup);
        socialEl.appendChild(link);
      });

      openOverlay(modal);
    });
  }

  /* --------------------------------------------------------- Časté otázky */

  document.addEventListener('click', function (e) {
    var head = e.target.closest('.faq__q');
    if (!head) { return; }
    var answer = document.getElementById(head.getAttribute('aria-controls'));
    if (!answer) { return; }
    var open = head.getAttribute('aria-expanded') === 'true';
    head.setAttribute('aria-expanded', open ? 'false' : 'true');
    answer.hidden = open;
    head.querySelector('.faq__mark').textContent = open ? '+' : '–';
  });

  /* ------------------------------------------------------- Odber noviniek */

  var form = document.getElementById('subscribe');
  if (form) {
    var status = document.getElementById('subscribe-status');
    var button = form.querySelector('button');
    var input = form.querySelector('input[type="email"]');
    var defaultLabel = button.textContent;
    var done = false;

    var say = function (text, isError) {
      status.textContent = text;
      status.className = 'footer__status' + (isError ? ' footer__status--err' : '');
    };

    var confetti = function () {
      if (reduceMotion) { return; }
      var colors = ['#FFF200', '#8DC63F', '#2BA9E1', '#ffffff'];
      var box = document.createElement('div');
      box.className = 'confetti';
      box.setAttribute('aria-hidden', 'true');
      for (var i = 0; i < 36; i++) {
        var piece = document.createElement('i');
        piece.style.left = (Math.random() * 100).toFixed(1) + '%';
        piece.style.background = colors[i % colors.length];
        piece.style.animationDuration = (2 + Math.random() * 1.6).toFixed(2) + 's';
        piece.style.animationDelay = (Math.random() * 0.6).toFixed(2) + 's';
        box.appendChild(piece);
      }
      document.body.appendChild(box);
      setTimeout(function () { box.remove(); }, 5000);
    };

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = input.value.trim();
      if (!/.+@.+\..+/.test(email)) {
        button.textContent = 'ZADAJ EMAIL';
        say('Zadaj e-mail v tvare meno@domena.sk.', true);
        input.focus();
        return;
      }

      button.disabled = true;
      button.textContent = '…';
      say('Posielam…', false);

      var body = new FormData();
      body.append('email', email);

      fetch(form.action, { method: 'POST', body: body, headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          button.disabled = false;
          if (res.data && res.data.ok) {
            button.textContent = 'ĎAKUJEME!';
            say(res.data.message || 'Ďakujeme! Ozveme sa s novinkami.', false);
            if (!done) { confetti(); done = true; }
            input.value = '';
          } else {
            button.textContent = defaultLabel;
            say((res.data && res.data.error) || 'Nepodarilo sa prihlásiť. Skús to o chvíľu.', true);
          }
        })
        .catch(function () {
          button.disabled = false;
          button.textContent = defaultLabel;
          say('Nepodarilo sa spojiť so serverom. Skús to o chvíľu.', true);
        });
    });

    input.addEventListener('input', function () {
      if (button.textContent === 'ZADAJ EMAIL') {
        button.textContent = defaultLabel;
        say('', false);
      }
    });
  }
})();
