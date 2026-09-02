/* ENZO admin — živá nástenka objednávok.
   Ťahá stav každých 10 sekúnd, pri novej objednávke pípne. */
(function () {
  "use strict";

  var POLL_MS = 10000;
  var seen = new Set();
  var firstLoad = true;
  var audioCtx = null;

  var el = {
    pulse: document.getElementById("pulse"),
    last: document.getElementById("lastUpdate"),
    sound: document.getElementById("soundOn"),
    cols: {
      received: document.getElementById("col-received"),
      confirmed: document.getElementById("col-confirmed"),
      ready: document.getElementById("col-ready"),
    },
    counts: {
      received: document.getElementById("c-received"),
      confirmed: document.getElementById("c-confirmed"),
      ready: document.getElementById("c-ready"),
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

  /* ---------- vykreslenie karty ---------- */
  function cardHtml(o) {
    var isNew = o.status === "received";
    var items = o.items
      .map(function (i) {
        var extras = i.extras.length
          ? '<div style="font-size:12px;color:#6E625B">+ ' + esc(i.extras.join(", ")) + "</div>"
          : "";
        var note = i.note
          ? '<div style="font-size:12px;color:#7A1E1E;font-style:italic">„' + esc(i.note) + "“</div>"
          : "";
        return "<li><strong>" + i.quantity + "×</strong> " + esc(i.name) + extras + note + "</li>";
      })
      .join("");

    var timing = "";
    if (o.readyAt) {
      var left = minutesUntil(o.readyAt);
      var late = left < 0;
      timing =
        '<span class="countdown' +
        (late ? " late" : "") +
        '">' +
        (late ? "meškáme " + Math.abs(left) + " min" : "o " + left + " min") +
        " · " +
        esc(o.readyAtLabel) +
        "</span>";
    }

    var actions = "";
    if (o.status === "received") {
      actions =
        '<div class="mins" data-order="' +
        o.id +
        '">' +
        [15, 20, 25, 30, 45, 60]
          .map(function (m) {
            return '<button type="button" data-mins="' + m + '">' + m + "′</button>";
          })
          .join("") +
        "</div>" +
        '<div class="order-actions">' +
        '<button class="btn btn-gold" data-act="confirm" data-order="' +
        o.id +
        '">Potvrdiť čas</button>' +
        '<a class="btn btn-sm btn-ghost" href="order.php?id=' +
        o.id +
        '">Detail</a>' +
        "</div>";
    } else if (o.status === "confirmed") {
      actions =
        '<div class="order-actions">' +
        '<button class="btn btn-gold" data-act="ready" data-order="' +
        o.id +
        '">' +
        (o.orderType === "pickup" ? "Pripravené" : "Kuriér vyrazil") +
        "</button>" +
        '<a class="btn btn-sm btn-ghost" href="order.php?id=' +
        o.id +
        '">Detail</a>' +
        "</div>";
    } else if (o.status === "ready") {
      actions =
        '<div class="order-actions">' +
        '<button class="btn" data-act="complete" data-order="' +
        o.id +
        '">Vybavené</button>' +
        '<a class="btn btn-sm btn-ghost" href="order.php?id=' +
        o.id +
        '">Detail</a>' +
        "</div>";
    }

    return (
      '<div class="order-card' +
      (isNew ? " new" : "") +
      '" id="ord-' +
      o.id +
      '">' +
      '<div class="order-card-head">' +
      '<span class="order-num">#' +
      esc(o.orderNumber) +
      "</span>" +
      '<span class="order-total">' +
      money(o.total) +
      "</span>" +
      "</div>" +
      '<div class="order-meta">' +
      "<span>" +
      (o.orderType === "pickup" ? "Osobný odber" : "Rozvoz") +
      "</span>" +
      '<span class="badge badge-' +
      (o.paymentStatus === "paid" ? "paid" : "unpaid") +
      '">' +
      (o.paymentMethod === "card" ? (o.paymentStatus === "paid" ? "Karta · zaplatené" : "Karta · čaká") : "Hotovosť") +
      "</span>" +
      "<span>" +
      esc(timeAgo(o.createdAt)) +
      "</span>" +
      timing +
      "</div>" +
      '<div class="order-items"><ul>' +
      items +
      "</ul></div>" +
      '<div class="order-meta" style="margin-top:8px">' +
      "<span>" +
      esc(o.customerName) +
      "</span><span>" +
      esc(o.phone) +
      "</span>" +
      (o.pickupTime ? "<span>Odber: " + esc(o.pickupTime) + "</span>" : "") +
      "</div>" +
      (o.note ? '<div style="margin-top:6px;font-size:13px;color:#7A1E1E">„' + esc(o.note) + "“</div>" : "") +
      actions +
      "</div>"
    );
  }

  /* ---------- načítanie ---------- */
  function render(orders) {
    var groups = { received: [], confirmed: [], ready: [] };
    orders.forEach(function (o) {
      if (groups[o.status]) groups[o.status].push(o);
    });

    Object.keys(groups).forEach(function (key) {
      var list = groups[key];
      el.counts[key].textContent = String(list.length);
      el.cols[key].innerHTML = list.length
        ? list.map(cardHtml).join("")
        : '<p class="hint" style="padding:10px 4px">Zatiaľ nič.</p>';
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

    if (act === "confirm") {
      var picker = document.querySelector('.mins[data-order="' + id + '"] button.sel');
      body.minutes = picker ? Number(picker.getAttribute("data-mins")) : DEFAULT_MINS;
    }
    if (act === "complete" && !confirm("Označiť objednávku ako vybavenú?")) return;

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
        if (!res.ok) throw new Error(res.error || "Nepodarilo sa uložiť.");
        poll();
      })
      .catch(function (e) {
        alert(e.message);
        btn.disabled = false;
        poll();
      });
  });

  // po interakcii vyčistíme počítadlo v titulku
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) document.title = "Objednávky · ENZO admin";
  });

  poll();
  setInterval(poll, POLL_MS);
})();
