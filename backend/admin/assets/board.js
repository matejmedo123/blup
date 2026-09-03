/* ENZO admin — živá nástenka objednávok.
   Ťahá stav každých 10 sekúnd, pri novej objednávke pípne.

   Na telefóne sa tri stĺpce nezmestia vedľa seba a pod sebou by obsluha
   k „pripraveným“ scrollovala cez celú obrazovku. Preto sú na úzkom
   displeji stĺpce záložky s počtami a vidno vždy jednu. Na tablete
   a počítači ostávajú tri stĺpce vedľa seba. */
(function () {
  "use strict";

  var POLL_MS = 10000;
  var seen = new Set();
  var firstLoad = true;
  var audioCtx = null;

  /* Stav objednávky → stĺpec nástenky. Stavov je viac než stĺpcov:
     obsluhu zaujíma, či sa objednávka ešte robí, nie jemný odtieň. */
  var COLUMN_OF = {
    received: "received",
    accepted: "working",
    preparing: "working",
    ready: "ready",
    delivering: "ready",
    picked_up: "ready",
  };

  var el = {
    pulse: document.getElementById("pulse"),
    last: document.getElementById("lastUpdate"),
    sound: document.getElementById("soundOn"),
    board: document.getElementById("board"),
    tabs: document.getElementById("boardTabs"),
    cols: {
      received: document.getElementById("col-received"),
      working: document.getElementById("col-working"),
      ready: document.getElementById("col-ready"),
    },
    counts: {
      received: document.getElementById("c-received"),
      working: document.getElementById("c-working"),
      ready: document.getElementById("c-ready"),
    },
    tabCounts: {
      received: document.getElementById("t-received"),
      working: document.getElementById("t-working"),
      ready: document.getElementById("t-ready"),
    },
  };

  /* ---------- zvuk ---------- */
  function beep() {
    if (!el.sound || !el.sound.checked) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      [0, 0.18].forEach(function (offset) {
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.type = "square";
        osc.frequency.value = offset ? 1046 : 784;
        gain.gain.setValueAtTime(0.0001, audioCtx.currentTime + offset);
        gain.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + offset + 0.16);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(audioCtx.currentTime + offset);
        osc.stop(audioCtx.currentTime + offset + 0.18);
      });
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
    } catch (e) {
      /* zvuk je len pomôcka — keď sa nedá, nič sa nedeje */
    }
  }

  /* ---------- pomocné ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function money(v) {
    return v.toFixed(2).replace(".", ",") + " €";
  }

  function minutesUntil(iso) {
    if (!iso) return null;
    return Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  }

  function timeAgo(iso) {
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return "práve teraz";
    if (mins < 60) return "pred " + mins + " min";
    return "pred " + Math.floor(mins / 60) + " h";
  }

  /* ---------- akcie podľa stavu ---------- */
  function actionsHtml(o) {
    var detail = '<a class="btn btn-sm btn-ghost" href="order.php?id=' + o.id + '">Detail</a>';

    if (o.status === "received") {
      var mins = [15, 20, 25, 30, 45, 60]
        .map(function (m) {
          return '<button type="button" data-mins="' + m + '">' + m + "′</button>";
        })
        .join("");
      return (
        '<div class="mins" data-order="' + o.id + '">' + mins + "</div>" +
        '<div class="order-actions">' +
        '<button class="btn btn-gold" data-act="accept" data-order="' + o.id + '">Prijať</button>' +
        '<button class="btn btn-sm btn-danger" data-act="reject" data-order="' + o.id + '">Odmietnuť</button>' +
        detail +
        "</div>"
      );
    }

    if (o.status === "accepted") {
      return (
        '<div class="order-actions">' +
        '<button class="btn" data-act="preparing" data-order="' + o.id + '">Na platni</button>' +
        '<button class="btn btn-gold" data-act="ready" data-order="' + o.id + '">Hotové</button>' +
        detail +
        "</div>"
      );
    }

    if (o.status === "preparing") {
      return (
        '<div class="order-actions">' +
        '<button class="btn btn-gold" data-act="ready" data-order="' + o.id + '">Hotové</button>' +
        detail +
        "</div>"
      );
    }

    if (o.status === "ready") {
      // Ďalší krok závisí od toho, či si to zákazník vyzdvihne alebo vezieme.
      var next =
        o.orderType === "pickup"
          ? '<button class="btn btn-gold" data-act="picked_up" data-order="' + o.id + '">Vyzdvihnuté</button>'
          : '<button class="btn btn-gold" data-act="delivering" data-order="' + o.id + '">Kuriér vyrazil</button>';
      return (
        '<div class="order-actions">' +
        next +
        '<button class="btn" data-act="complete" data-order="' + o.id + '">Vybavené</button>' +
        detail +
        "</div>"
      );
    }

    if (o.status === "delivering" || o.status === "picked_up") {
      return (
        '<div class="order-actions">' +
        '<button class="btn btn-gold" data-act="complete" data-order="' + o.id + '">Vybavené</button>' +
        detail +
        "</div>"
      );
    }

    return '<div class="order-actions">' + detail + "</div>";
  }

  /* ---------- vykreslenie karty ---------- */
  function cardHtml(o) {
    var isNew = o.status === "received";

    var items = o.items
      .map(function (i) {
        var extras = i.extras.length
          ? '<div class="item-extra">+ ' + esc(i.extras.join(", ")) + "</div>"
          : "";
        var note = i.note ? '<div class="item-note">„' + esc(i.note) + "“</div>" : "";
        return "<li><strong>" + i.quantity + "×</strong> " + esc(i.name) + extras + note + "</li>";
      })
      .join("");

    var timing = "";
    if (o.readyAt) {
      var left = minutesUntil(o.readyAt);
      var late = left < 0;
      timing =
        '<span class="countdown' + (late ? " late" : "") + '">' +
        (late ? "meškáme " + Math.abs(left) + " min" : "o " + left + " min") +
        " · " + esc(o.readyAtLabel) +
        "</span>";
    }

    var statusNote =
      o.status === "delivering"
        ? '<span class="badge badge-ready">Na ceste</span>'
        : o.status === "picked_up"
        ? '<span class="badge badge-ready">Vyzdvihnuté</span>'
        : "";

    var pay =
      o.paymentMethod === "card"
        ? o.paymentStatus === "paid"
          ? "Karta · zaplatené"
          : "Karta · čaká"
        : "Hotovosť";

    return (
      '<div class="order-card' + (isNew ? " new" : "") + '" id="ord-' + o.id + '">' +
      '<div class="order-card-head">' +
      '<span class="order-num">#' + esc(o.orderNumber) + "</span>" +
      '<span class="order-total">' + money(o.total) + "</span>" +
      "</div>" +
      '<div class="order-meta">' +
      "<span>" + (o.orderType === "pickup" ? "Osobný odber" : "Rozvoz") + "</span>" +
      '<span class="badge badge-' + (o.paymentStatus === "paid" ? "paid" : "unpaid") + '">' + pay + "</span>" +
      statusNote +
      "<span>" + esc(timeAgo(o.createdAt)) + "</span>" +
      timing +
      "</div>" +
      '<div class="order-items"><ul>' + items + "</ul></div>" +
      '<div class="order-meta" style="margin-top:8px">' +
      "<span>" + esc(o.customerName) + "</span>" +
      '<a href="tel:' + esc(o.phone) + '" class="phone-link">' + esc(o.phone) + "</a>" +
      (o.pickupTime ? "<span>Odber: " + esc(o.pickupTime) + "</span>" : "") +
      "</div>" +
      (o.note ? '<div class="order-note">„' + esc(o.note) + "“</div>" : "") +
      actionsHtml(o) +
      "</div>"
    );
  }

  /* ---------- záložky na telefóne ---------- */
  var activeTab = "received";

  function applyTab() {
    if (!el.board) return;
    el.board.setAttribute("data-active", activeTab);
    if (!el.tabs) return;
    el.tabs.querySelectorAll("button").forEach(function (b) {
      var on = b.getAttribute("data-tab") === activeTab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  if (el.tabs) {
    el.tabs.addEventListener("click", function (ev) {
      var btn = ev.target.closest("button[data-tab]");
      if (!btn) return;
      activeTab = btn.getAttribute("data-tab");
      applyTab();
    });
  }

  /* ---------- načítanie ---------- */
  function render(orders) {
    var groups = { received: [], working: [], ready: [] };
    orders.forEach(function (o) {
      var col = COLUMN_OF[o.status];
      if (col) groups[col].push(o);
    });

    Object.keys(groups).forEach(function (key) {
      var list = groups[key];
      if (el.counts[key]) el.counts[key].textContent = String(list.length);
      if (el.tabCounts[key]) el.tabCounts[key].textContent = String(list.length);
      if (el.cols[key]) {
        el.cols[key].innerHTML = list.length
          ? list.map(cardHtml).join("")
          : '<p class="hint" style="padding:10px 4px">Zatiaľ nič.</p>';
      }
    });

    // nová objednávka od minulého ťahania → pípni
    var fresh = orders.filter(function (o) {
      return o.status === "received" && !seen.has(o.id);
    });
    orders.forEach(function (o) {
      seen.add(o.id);
    });
    if (!firstLoad && fresh.length) {
      beep();
      document.title = "(" + fresh.length + ") Nová objednávka · ENZO admin";
      // Na telefóne prehodíme na stĺpec s novými — inak by ju obsluha
      // nemusela vôbec zbadať.
      activeTab = "received";
      applyTab();
    }
    firstLoad = false;
  }

  function poll() {
    fetch("api.php?action=board", { credentials: "same-origin" })
      .then(function (r) {
        if (r.status === 401) {
          location.href = "index.php";
          throw new Error("odhlásené");
        }
        return r.json();
      })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || "chyba");
        render(res.data.orders);
        el.pulse.className = "badge badge-ready";
        el.pulse.textContent = "Spojenie v poriadku";
        el.last.textContent = "Obnovené " + new Date().toLocaleTimeString("sk-SK");
      })
      .catch(function () {
        el.pulse.className = "badge badge-cancelled";
        el.pulse.textContent = "Bez spojenia — skúšam znova";
      });
  }

  /* ---------- akcie ---------- */
  var CONFIRM_TEXT = {
    reject: "Naozaj odmietnuť objednávku? Zákazníkovi pošleme e-mail.",
    complete: "Označiť objednávku ako vybavenú?",
  };

  document.addEventListener("click", function (ev) {
    var minBtn = ev.target.closest(".mins button");
    if (minBtn) {
      minBtn.parentElement.querySelectorAll("button").forEach(function (b) {
        b.classList.remove("sel");
      });
      minBtn.classList.add("sel");
      return;
    }

    var btn = ev.target.closest("button[data-act]");
    if (!btn) return;

    var id = btn.getAttribute("data-order");
    var act = btn.getAttribute("data-act");
    var body = { action: act, id: Number(id), _csrf: CSRF };

    if (act === "accept") {
      var picker = document.querySelector('.mins[data-order="' + id + '"] button.sel');
      body.minutes = picker ? Number(picker.getAttribute("data-mins")) : DEFAULT_MINS;
    }
    if (act === "reject") {
      var reason = prompt("Prečo objednávku odmietame? (zákazník to uvidí)", "Máme plno, nestíhame");
      if (reason === null) return;
      body.reason = reason;
    }
    if (CONFIRM_TEXT[act] && act !== "reject" && !confirm(CONFIRM_TEXT[act])) return;

    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Ukladám…";

    fetch("api.php", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (res) {
        if (!res.ok) {
          // Keď objednávku medzitým spracoval kolega, netreba paniku —
          // stačí povedať čo sa stalo a načítať aktuálny stav.
          throw new Error(res.error || "Nepodarilo sa uložiť.");
        }
        poll();
      })
      .catch(function (e) {
        alert(e.message);
        btn.disabled = false;
        btn.textContent = original;
        poll();
      });
  });

  // po interakcii vyčistíme počítadlo v titulku
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) {
      document.title = "Objednávky · ENZO admin";
      poll();
    }
  });

  applyTab();
  poll();
  setInterval(poll, POLL_MS);
})();
