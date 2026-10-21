/* Trader dashboard — vanilla JS, no libraries. All data is inserted with textContent / setAttribute;
   nothing from the API is ever parsed as HTML. */
(function () {
  'use strict';

  var CSRF = (document.querySelector('meta[name="trader-csrf"]') || {}).content || '';
  var TABS = ['overview', 'trades', 'bot', 'checks', 'brain', 'news', 'setups', 'reports'];
  var SVGNS = 'http://www.w3.org/2000/svg';
  var ASSET_LABEL = { stock: 'Stocks', crypto: 'Crypto', meme: 'Meme coins' };
  var REFRESH_MS = 10000;

  var S = {
    tab: 'overview', summary: null, busy: false, charts: [],
    filters: {
      trades: { asset: '', status: '', setup: '' },
      news: { asset: '', symbol: '', kind: '' },
      decisions: '',
      range: 'all'
    },
    expanded: {}, tradeCache: {}
  };

  // ---------------------------------------------------------------- DOM helpers
  function h(tag, attrs) {
    var el = document.createElement(tag);
    setAttrs(el, attrs);
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function sv(tag, attrs) {
    var el = document.createElementNS(SVGNS, tag);
    setAttrs(el, attrs);
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function setAttrs(el, attrs) {
    if (!attrs) return;
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.setAttribute('class', v);
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    });
  }
  function append(el, kid) {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function $(id) { return document.getElementById(id); }
  function safeUrl(u) { u = String(u || '').trim(); return /^https?:\/\//i.test(u) ? u : ''; }
  function link(url, text, cls) {
    var u = safeUrl(url);
    return u ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', class: cls || null }, text)
             : h('span', { class: cls || null }, text);
  }
  function reportHref(name) {
    name = String(name || '').split('/').pop();
    return /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/.test(name) ? '/reports/' + encodeURIComponent(name) : '';
  }
  function reportLink(name, text) {
    var href = reportHref(name);
    return href ? h('a', { href: href, target: '_blank', rel: 'noopener' }, text || 'Open report') : null;
  }
  function setWidth(el, pct) { el.style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + '%'; return el; }

  // ---------------------------------------------------------------- formatting
  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  function money(v, signed) {
    v = num(v);
    if (v === null) return '—';
    var a = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (v < 0 ? '−' : (signed && v > 0 ? '+' : '')) + '$' + a;
  }
  function price(v) {
    v = num(v);
    if (v === null) return '—';
    var a = Math.abs(v), s;
    if (a >= 1) s = a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    else if (a >= 0.01) s = a.toFixed(4);
    else if (a === 0) s = '0.00';
    else s = a.toFixed(Math.min(12, Math.max(4, -Math.floor(Math.log10(a)) + 3)));
    return (v < 0 ? '−' : '') + '$' + s;
  }
  function pct(v, signed, d) {
    v = num(v);
    if (v === null) return '—';
    return (v < 0 ? '−' : (signed && v > 0 ? '+' : '')) + Math.abs(v).toFixed(d === undefined ? 1 : d) + '%';
  }
  function rr(v) { v = num(v); return v === null ? '—' : (v < 0 ? '−' : (v > 0 ? '+' : '')) + Math.abs(v).toFixed(2) + 'R'; }
  function tone(v) { v = num(v); return v === null || v === 0 ? '' : (v > 0 ? 'up' : 'down'); }
  function qty(v, unit) {
    v = num(v);
    if (v === null) return '—';
    if (unit === 'usd') return money(v);
    var s = Math.abs(v) >= 1 ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) : String(+v.toFixed(8));
    return s + (unit && unit !== 'usd' ? ' ' + unit : '');
  }
  function nowMs() { return S.summary && S.summary.now ? Date.parse(S.summary.now) : Date.now(); }
  function ago(iso, realClock) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return '—';
    var d = ((realClock ? Date.now() : nowMs()) - t) / 1000;
    if (d < -60) return 'in ' + dur(-d);
    if (d < 45) return 'just now';
    return dur(d) + ' ago';
  }
  function dur(sec) {
    if (sec < 3600) return Math.max(1, Math.round(sec / 60)) + 'm';
    if (sec < 86400) return Math.round(sec / 3600) + 'h';
    return Math.round(sec / 86400) + 'd';
  }
  function hm(iso, withDate) {
    var t = new Date(iso);
    if (!isFinite(t.getTime())) return '—';
    var time = t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    var sameDay = new Date(nowMs()).toDateString() === t.toDateString();
    return (withDate || !sameDay) ? t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + time : time;
  }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  // the viewer's own clock and time zone — the server sends UTC ISO times
  var TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'; } catch (e) { return 'local time'; } })();
  function localDT(iso) {
    var t = new Date(iso);
    if (!isFinite(t.getTime())) return '—';
    return t.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function secs(n) { n = num(n); return n === null ? '—' : (n < 90 ? Math.round(n) + 's' : dur(n)); }

  // ---------------------------------------------------------------- API
  function api(path) {
    return fetch(path, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
      if (r.status === 401) { location.href = '/login'; throw new Error('sign in'); }
      if (!r.ok) throw new Error(path + ' → HTTP ' + r.status);
      return r.json();
    });
  }
  function post(path, body) {
    return fetch(path, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Trader-CSRF': CSRF },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  // ---------------------------------------------------------------- small UI pieces
  function tile(label, value, sub, cls) {
    return h('div', { class: 'tile' }, h('div', { class: 'k', text: label }),
      h('div', { class: 'v ' + (cls || ''), text: value }), sub ? h('div', { class: 's', text: sub }) : null);
  }
  function card(title, meta, body, extraCls) {
    return h('section', { class: 'card ' + (extraCls || '') },
      h('div', { class: 'card-h' }, h('h2', { text: title }), meta ? (meta instanceof Node ? meta : h('span', { class: 'meta', text: meta })) : null),
      body);
  }
  function empty(text, code) {
    return h('div', { class: 'empty' }, text, code ? [' ', h('code', { text: code })] : null);
  }
  function st(text, color) { return h('span', { class: 'st ' + (color || ''), text: text }); }
  function statusColor(s) {
    return ({ triggered: 'green', taken: 'green', running: 'green', go: 'green', closed: '', open: 'blue', watching: 'blue',
      forming: 'amber', paused: 'amber', wait: 'amber', flag: 'purple', skipped: '', extended: '', invalidated: 'red',
      expired: '', error: 'red', killed: 'red', 'no-go': 'red', blocked: 'red', incomplete: 'amber', live: 'red' })[String(s || '').toLowerCase()] || '';
  }
  function chips(options, current, onPick) {
    return h('div', { class: 'chips', role: 'group' }, options.map(function (o) {
      return h('button', { class: 'chip', type: 'button', 'aria-pressed': String(o[0] === current),
        onclick: function () { onPick(o[0]); } }, o[1]);
    }));
  }
  function stars(n) {
    n = Math.max(0, Math.min(3, num(n) || 0));
    var el = h('span', { class: 'stars', title: 'importance ' + n + '/3' });
    for (var i = 1; i <= 3; i++) append(el, h('span', { class: i <= n ? '' : 'off', text: '★' }));
    return el;
  }
  function toast(msg) {
    var t = h('div', { class: 'toast', role: 'status', text: msg });
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }
  function srcClass(src) {
    src = String(src || '').toLowerCase();
    if (src === 'x' || src === 'twitter') return 'src-x';
    if (src.indexOf('stocktwits') >= 0) return 'src-stocktwits';
    if (src.indexOf('sec') === 0) return 'src-sec';
    if (src.indexOf('yahoo') >= 0 || src.indexOf('google') >= 0) return 'src-yahoo';
    if (/coindesk|cointelegraph|block/.test(src)) return 'src-crypto';
    if (src.indexOf('dex') >= 0) return 'src-dex';
    return 'src-other';
  }

  // ---------------------------------------------------------------- charts
  function niceTicks(lo, hi, n) {
    if (!(hi > lo)) { hi = lo + (Math.abs(lo) * 0.01 || 1); }
    var raw = (hi - lo) / Math.max(n, 1), mag = Math.pow(10, Math.floor(Math.log10(raw))), step = mag;
    [1, 2, 2.5, 5, 10].some(function (m) { if (raw <= m * mag) { step = m * mag; return true; } return false; });
    var out = [];
    for (var v = Math.ceil(lo / step) * step; v <= hi + 1e-9 && out.length < 12; v += step) out.push(v);
    return out;
  }
  function shortMoney(v) {
    var a = Math.abs(v), s;
    if (a >= 1e6) s = '$' + (a / 1e6).toFixed(2) + 'M';
    else if (a >= 1e4) s = '$' + (a / 1e3).toFixed(1) + 'k';
    else s = '$' + a.toLocaleString('en-US', { maximumFractionDigits: a >= 100 ? 0 : 2 });
    return (v < 0 ? '−' : '') + s;
  }
  function mountChart(box, draw) {
    S.charts.push({ box: box, draw: draw });
    requestAnimationFrame(function () { if (box.isConnected) draw(box); });
    return box;
  }
  var uid = 0;

  function lineChart(points, opts) {
    var box = h('div', { class: 'chart' });
    return mountChart(box, function (b) { drawLine(b, points, opts || {}); });
  }
  function drawLine(box, pts, o) {
    clear(box);
    var W = Math.max(280, box.clientWidth || 600), H = o.height || (W < 500 ? 190 : 230);
    var pad = { l: W < 500 ? 50 : 62, r: 10, t: 12, b: 24 };
    var xs = pts.map(function (p) { return Date.parse(p.t); }), ys = pts.map(function (p) { return p.v; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    if (x1 === x0) { x0 -= 3600e3; x1 += 3600e3; }
    var lo = Math.min.apply(null, ys.concat(o.base !== undefined ? [o.base] : [])),
        hi = Math.max.apply(null, ys.concat(o.base !== undefined ? [o.base] : []));
    var span = (hi - lo) || Math.abs(hi) * 0.01 || 1;
    lo -= span * 0.08; hi += span * 0.08;
    function X(t) { return pad.l + (t - x0) / (x1 - x0) * (W - pad.l - pad.r); }
    function Y(v) { return pad.t + (hi - v) / (hi - lo) * (H - pad.t - pad.b); }
    var id = 'g' + (++uid);
    var rising = ys[ys.length - 1] >= ys[0];
    var color = o.color || (rising ? 'var(--green)' : 'var(--red)');
    var svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', 'aria-label': o.label || 'chart' });
    var defs = sv('defs', null, sv('linearGradient', { id: id, x1: 0, y1: 0, x2: 0, y2: 1 },
      sv('stop', { offset: '0%', 'stop-color': rising ? '#2ec27e' : '#f2555a', 'stop-opacity': 0.28 }),
      sv('stop', { offset: '100%', 'stop-color': rising ? '#2ec27e' : '#f2555a', 'stop-opacity': 0 })));
    svg.appendChild(defs);
    niceTicks(lo, hi, 4).forEach(function (v) {
      svg.appendChild(sv('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v) }));
      svg.appendChild(sv('text', { x: pad.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, (o.fmt || shortMoney)(v)));
    });
    var multiDay = (x1 - x0) > 36 * 3600e3, ticks = W < 500 ? 3 : 5;
    for (var k = 0; k < ticks; k++) {
      var t = x0 + (x1 - x0) * k / (ticks - 1);
      var d = new Date(t);
      var lab = multiDay ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
                         : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      svg.appendChild(sv('text', { x: X(t), y: H - 6, 'text-anchor': k === 0 ? 'start' : (k === ticks - 1 ? 'end' : 'middle') }, lab));
    }
    if (o.base !== undefined) svg.appendChild(sv('line', { class: 'zero', x1: pad.l, x2: W - pad.r, y1: Y(o.base), y2: Y(o.base) }));
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + X(xs[i]).toFixed(1) + ' ' + Y(p.v).toFixed(1); }).join(' ');
    var area = line + ' L' + X(xs[xs.length - 1]).toFixed(1) + ' ' + (H - pad.b) + ' L' + X(xs[0]).toFixed(1) + ' ' + (H - pad.b) + ' Z';
    svg.appendChild(sv('path', { d: area, fill: 'url(#' + id + ')', stroke: 'none' }));
    svg.appendChild(sv('path', { d: line, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    var cross = sv('line', { class: 'cross', x1: 0, x2: 0, y1: pad.t, y2: H - pad.b, visibility: 'hidden' });
    var dot = sv('circle', { r: 4, fill: color, stroke: 'var(--panel)', 'stroke-width': 2, visibility: 'hidden' });
    svg.appendChild(cross); svg.appendChild(dot);
    var tip = h('div', { class: 'tip', hidden: true });
    var hit = sv('rect', { x: pad.l, y: 0, width: W - pad.l - pad.r, height: H, fill: 'transparent' });
    function move(ev) {
      var r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * (W / r.width);
      var best = 0, bd = Infinity;
      for (var i = 0; i < xs.length; i++) { var dd = Math.abs(X(xs[i]) - px); if (dd < bd) { bd = dd; best = i; } }
      var cx = X(xs[best]), cy = Y(pts[best].v);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.textContent = (o.tipFmt || money)(pts[best].v) + ' · ' + hm(pts[best].t, true);
      tip.style.left = (cx * r.width / W) + 'px';
      tip.style.top = (cy * r.height / H) + 'px';
    }
    function leave() { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; }
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', leave);
    svg.appendChild(hit);
    box.appendChild(svg);
    box.appendChild(tip);
  }

  function barChart(rows) {
    var box = h('div', { class: 'chart' });
    return mountChart(box, function (b) { drawBars(b, rows); });
  }
  function drawBars(box, rows) {
    clear(box);
    var W = Math.max(260, box.clientWidth || 400), H = W < 500 ? 170 : 210;
    var pad = { l: W < 500 ? 48 : 56, r: 8, t: 10, b: 24 };
    var vals = rows.map(function (r) { return r.pnl; });
    var lo = Math.min(0, Math.min.apply(null, vals)), hi = Math.max(0, Math.max.apply(null, vals));
    var span = (hi - lo) || 1; lo -= span * 0.1; hi += span * 0.1;
    function Y(v) { return pad.t + (hi - v) / (hi - lo) * (H - pad.t - pad.b); }
    var n = rows.length, bw = (W - pad.l - pad.r) / n;
    var svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', 'aria-label': 'daily P&L' });
    niceTicks(lo, hi, 4).forEach(function (v) {
      svg.appendChild(sv('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v) }));
      svg.appendChild(sv('text', { x: pad.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, shortMoney(v)));
    });
    svg.appendChild(sv('line', { class: 'zero', x1: pad.l, x2: W - pad.r, y1: Y(0), y2: Y(0) }));
    rows.forEach(function (r, i) {
      var x = pad.l + i * bw + bw * 0.18, w = Math.max(2, bw * 0.64);
      var y = Math.min(Y(r.pnl), Y(0)), hgt = Math.max(1.5, Math.abs(Y(r.pnl) - Y(0)));
      var rect = sv('rect', { x: x, y: y, width: w, height: hgt, rx: 3, fill: r.pnl >= 0 ? 'var(--green)' : 'var(--red)', opacity: 0.85 },
        sv('title', null, r.date + ': ' + money(r.pnl, true)));
      svg.appendChild(rect);
    });
    var step = Math.max(1, Math.ceil(n / (W < 500 ? 3 : 6)));
    rows.forEach(function (r, i) {
      if (i % step && i !== n - 1) return;
      var d = new Date(r.date + 'T12:00:00Z');
      svg.appendChild(sv('text', { x: pad.l + (i + 0.5) * bw, y: H - 6, 'text-anchor': i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle') },
        d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })));
    });
    box.appendChild(svg);
  }

  function candleChart(candles, lines, markers) {
    var box = h('div', { class: 'chart' });
    return mountChart(box, function (b) { drawCandles(b, candles, lines || [], markers || []); });
  }
  function drawCandles(box, cs, lines, markers) {
    clear(box);
    var W = Math.max(280, box.clientWidth || 600), H = W < 500 ? 230 : 300;
    var longest = lines.reduce(function (m, l) { return Math.max(m, (l.label + ' ' + price(l.price)).length); }, 8);
    var pad = { l: 6, r: Math.min(150, Math.round(longest * 6.9) + 12), t: 12, b: 24 }, volH = Math.round(H * 0.14);
    var plotH = H - pad.t - pad.b - volH;
    var lows = cs.map(function (c) { return c[3]; }), highs = cs.map(function (c) { return c[2]; });
    lines.forEach(function (l) { if (num(l.price) !== null) { lows.push(l.price); highs.push(l.price); } });
    var lo = Math.min.apply(null, lows), hi = Math.max.apply(null, highs), span = (hi - lo) || hi * 0.01 || 1;
    lo -= span * 0.05; hi += span * 0.05;
    var n = cs.length, bw = (W - pad.l - pad.r) / n;
    function X(i) { return pad.l + (i + 0.5) * bw; }
    function Y(p) { return pad.t + (hi - p) / (hi - lo) * plotH; }
    var vmax = Math.max.apply(null, cs.map(function (c) { return c[5] || 0; })) || 1;
    var svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', 'aria-label': 'price chart' });
    niceTicks(lo, hi, 4).forEach(function (v) {
      svg.appendChild(sv('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v) }));
    });
    cs.forEach(function (c, i) {
      var up = c[4] >= c[1], col = up ? 'var(--green)' : 'var(--red)', x = X(i);
      svg.appendChild(sv('line', { x1: x, x2: x, y1: Y(c[2]), y2: Y(c[3]), stroke: col, 'stroke-width': 1 }));
      var top = Y(Math.max(c[1], c[4])), bot = Y(Math.min(c[1], c[4]));
      svg.appendChild(sv('rect', { x: x - Math.max(bw * 0.34, 0.6), y: top, width: Math.max(bw * 0.68, 1.2),
        height: Math.max(bot - top, 0.9), fill: col }));
      var vh = (c[5] || 0) / vmax * (volH - 4);
      svg.appendChild(sv('rect', { x: x - Math.max(bw * 0.34, 0.6), y: H - pad.b - vh, width: Math.max(bw * 0.68, 1.2),
        height: vh, fill: col, opacity: 0.25 }));
    });
    var labelYs = [];
    lines.forEach(function (l) {
      if (num(l.price) === null) return;
      var y = Y(l.price);
      svg.appendChild(sv('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, stroke: l.color, 'stroke-width': 1.4,
        'stroke-dasharray': l.dash ? '5 4' : null }));
      labelYs.push({ y: y, l: l });
    });
    labelYs.sort(function (a, b) { return a.y - b.y; });
    var last = -1e9;
    labelYs.forEach(function (o) {
      var y = Math.max(o.y, last + 13); last = y;
      svg.appendChild(sv('text', { x: W - pad.r + 6, y: y + 4, fill: o.l.color }, o.l.label + ' ' + price(o.l.price)));
    });
    markers.forEach(function (m) {
      var t = Date.parse(m.t) / 1000, idx = -1;
      for (var i = 0; i < n; i++) { if (cs[i][0] <= t) idx = i; }
      if (idx < 0) return;
      var x = X(idx), y = Y(m.price), up = m.shape !== 'down';
      var pts = up ? [x, y + 5, x - 6, y + 15, x + 6, y + 15] : [x, y - 5, x - 6, y - 15, x + 6, y - 15];
      svg.appendChild(sv('polygon', { points: pts.join(' '), fill: m.color }));
    });
    var ticks = W < 500 ? 3 : 5;
    for (var k = 0; k < ticks && n > 1; k++) {
      var i2 = Math.round(k * (n - 1) / (ticks - 1));
      var d = new Date(cs[i2][0] * 1000);
      svg.appendChild(sv('text', { x: X(i2), y: H - 6, 'text-anchor': k === 0 ? 'start' : (k === ticks - 1 ? 'end' : 'middle') },
        d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })));
    }
    box.appendChild(svg);
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      S.charts = S.charts.filter(function (c) { return c.box.isConnected; });
      S.charts.forEach(function (c) { c.draw(c.box); });
    }, 150);
  });

  // ---------------------------------------------------------------- top bar, banner, footer
  function renderTop() {
    var s = S.summary || {};
    var m = s.mode || {};
    var badge = $('mode-badge');
    badge.textContent = m.mode === 'live' ? 'LIVE · real money' : (m.mode === 'paper' ? 'Paper' : 'Simulator');
    badge.className = 'badge' + (m.mode === 'live' ? ' live' : '');
    badge.title = m.mode === 'live' ? 'Real-money orders are enabled in your config files'
      : (m.mode === 'paper' ? 'Paper account at ' + (m.broker || 'the broker') + ' — no real money' : 'Local simulator — no account, no real money');
    $('live-stripe').hidden = m.mode !== 'live';
    document.body.classList.toggle('live', m.mode === 'live');
    var bot = s.bot || {};
    var p = pillState(s);
    $('bot-dot').className = 'dot ' + p[0];
    $('bot-txt').textContent = p[1];
    $('bot-pill').title = 'Autopilot: ' + p[1] + (bot.message ? ' — ' + bot.message : '');
    var a = s.account || {};
    $('top-equity').textContent = a.equity !== undefined && a.equity !== null ? money(a.equity) : '—';
    var today = $('top-today');
    today.textContent = money(a.pnl_today, true);
    today.className = 'v ' + tone(a.pnl_today);
    var disc = $('disclaimer');
    disc.textContent = s.disclaimer || 'Educational tool, not financial advice.';
    disc.className = 'disc' + (s.has_meme ? ' meme' : '');
    $('foot-meta').textContent = 'State folder: ' + (s.home || '?') + (s.offline ? ' · offline fixtures, clock pinned to ' + s.now : '');
    var st_ = s.stats || {};
    $('count-trades').textContent = st_.closed ? String(st_.closed) : '';
    $('count-bot').textContent = bot.today && bot.today.trades_opened ? String(bot.today.trades_opened) : '';
  }
  // heartbeat first: a "running" state.json means nothing if nobody has written it for an hour
  function continuous(hl) { return hl.runner === 'daemon' || hl.runner === 'dashboard'; }
  function pillState(s) {
    var bot = s.bot || {}, hl = s.health || {};
    var status = String(bot.status || 'unknown');
    if (hl.state === 'stale' && continuous(hl)) return ['stale', 'No heartbeat · ' + ago(hl.at)];
    if (hl.state === 'stale') return ['idle', 'Idle · last run ' + ago(hl.at)];
    if (hl.state === 'stopped') return ['stopped', 'Stopped · ' + hm(hl.at)];
    var at = hl.at || bot.last_cycle;
    return [status.replace(/\s+/g, '-'), cap(status) + (at ? ' · ' + hm(at) : '')];
  }
  function setBanner(text, kind) {
    var b = $('banner');
    if (!text) { b.hidden = true; return; }
    b.hidden = false;
    b.className = 'banner ' + (kind || '');
    b.textContent = text;
  }
  function backgroundBanner() {
    var s = S.summary || {};
    var srv = s.server || {};
    var ap = srv.autopilot || {};
    if (ap.thread && ap.last_error) return ['Autopilot loop error: ' + ap.last_error, 'error'];
    if ((s.mode || {}).mode === 'live') return ['LIVE MODE — the autopilot can place real-money orders. Use KILL on the Bot tab to stop everything.', 'error'];
    if (s.bot && s.bot.status === 'killed') return ['The kill switch is on — the autopilot cancelled orders and stopped. Resume it on the Bot tab.', 'error'];
    var ln = s.learned || {};
    if (ln.drawdown_pause) return ['Paused by the drawdown guard: equity is ' + pct(ln.drawdown_pct) + ' below its peak (limit ' + pct(ln.max_drawdown_pct) +
      '). Look at what went wrong, then Resume on the Bot tab — resuming starts a new peak.', 'error'];
    var hl = s.health || {};
    if (hl.state === 'stale' && continuous(hl)) return ['The bot has not checked in for ' + secs(hl.age_sec) + ' (expected every ' + secs((hl.stale_after_sec || 180) / 3) +
      '). Is it still running? On a VPS: sudo systemctl status trader-autopilot', ''];
    if (s.offline) return ['Offline demo — synthetic fixture data, clock pinned to ' + hm(s.now, true) + '.', 'info'];
    return [null];
  }

  // ---------------------------------------------------------------- views
  function head(title, sub, right) {
    return h('div', { class: 'view-head' }, h('div', null, h('h1', { text: title }), sub ? h('div', { class: 'sub', text: sub }) : null), right || null);
  }

  function positionRows(list) {
    if (!list.length) return empty('No open positions.');
    return h('div', { class: 'rows' }, list.map(function (p) {
      var unit = p.qty_unit || (p.asset === 'stock' ? 'sh' : '');
      return h('div', { class: 'row' },
        h('div', { class: 'title' }, st(ASSET_LABEL[p.asset] ? p.asset : 'pos', p.asset === 'meme' ? 'purple' : 'blue'),
          h('span', { class: 'sym', text: p.symbol || '?' }), p.riding ? st('riding the trend', 'green') : null),
        h('div', { class: 'right' }, h('div', { class: 'big ' + tone(p.unrealized_pl), text: money(p.unrealized_pl, true) }),
          h('div', { class: 'sm', text: 'last ' + price(p.last) })),
        h('div', { class: 'detail', text: qty(p.qty, unit === 'usd' ? 'usd' : unit) + ' @ ' + price(p.avg_entry) +
          (p.stop ? ' · stop ' + price(p.stop) : '') + (p.target ? ' · target ' + price(p.target) : '') +
          (p.opened_at ? ' · since ' + hm(p.opened_at) : '') }),
        p.story ? h('div', { class: 'detail', text: p.story }) : null);
    }));
  }

  function reasonKind(r) {
    r = String(r || '').toLowerCase();
    if (/^ai\b|ai desk|claude/.test(r)) return ['AI', 'purple'];
    if (/news|headline|filing|8-k|sec edgar/.test(r)) return ['news', 'amber'];
    if (/learn|adapt|cooldown|cooling|loss streak|losses in a row|drawdown|sits out|paused setup/.test(r)) return ['learned', 'blue'];
    if (/^risk\b/.test(r)) return ['risk', 'red'];
    if (/^desk\b/.test(r)) return ['desk', ''];
    return null;
  }
  function reasonItem(r) {
    var k = reasonKind(r);
    return h('li', null, k ? h('span', { class: 'rk ' + k[1], text: k[0] }) : null, String(r));
  }
  function decisionRow(d, compact) {
    var action = String(d.action || '?');
    var color = action === 'taken' ? 'green' : (action === 'error' ? 'red' : '');
    var reasons = (d.reasons || []).slice(0, compact ? 1 : 6);
    var right = d.entry ? h('div', { class: 'right' }, h('div', { class: 'big', text: price(d.entry) }),
      h('div', { class: 'sm', text: (d.stop ? 'stop ' + price(d.stop) : '') + (d.target ? ' · tgt ' + price(d.target) : '') })) : h('div', { class: 'right' });
    var mid = h('div', null,
      h('div', { class: 'title' }, h('span', { class: 'sym', text: d.symbol || '?' }), h('span', { class: 'muted', text: d.setup || '' }), st(action, color),
        d.desk && d.desk.status ? st('desk ' + d.desk.status, statusColor(d.desk.status)) : null),
      reasons.length ? h('ul', { class: 'reasons' }, reasons.map(reasonItem)) : null,
      !compact && d.gates && d.gates.length ? h('details', { class: 'gates' }, h('summary', { text: 'Gates (' + d.gates.length + ')' }),
        h('ul', { class: 'checklist' }, d.gates.map(function (g) {
          return h('li', null, h('span', { class: 'mark ' + (g.ok ? 'up' : 'down'), text: g.ok ? '✓' : '✗' }),
            h('span', null, h('b', { text: g.name || '' }), ' ', h('span', { class: 'muted', text: g.detail || '' })));
        }))) : null,
      !compact && (d.order_id || d.broker_order_id) ? h('div', { class: 'small faint mono', text: 'order ' + (d.broker_order_id || d.order_id) + (d.qty ? ' · qty ' + d.qty : '') }) : null);
    if (compact) {
      var first = (d.reasons || [])[0] || '';
      var fk = reasonKind(first);
      return h('div', { class: 'row' },
        h('div', { class: 'title' }, h('span', { class: 'sym', text: d.symbol || '?' }), h('span', { class: 'muted', text: d.setup || '' }), st(action, color)),
        h('div', { class: 'right' }, h('div', { class: 'sm', text: hm(d.at) })),
        h('div', { class: 'detail' }, fk ? h('span', { class: 'rk ' + fk[1], text: fk[0] }) : null, first + ((d.reasons || []).length > 1 ? ' (+' + (d.reasons.length - 1) + ' more)' : '') +
          (d.entry ? ' · entry ' + price(d.entry) : '')));
    }
    return h('div', { class: 'row' }, h('div', { class: 'time', text: hm(d.at) }), mid, right);
  }

  function newsCard(i) {
    var src = String(i.source || '?');
    var tags = (i.tags || []).slice(0, 5);
    var metrics = i.metrics || {};
    return h('article', { class: 'news' },
      h('div', { class: 'top' }, h('span', { class: 'src ' + srcClass(src), text: src === 'X' ? '𝕏' : src }),
        i.author ? h('span', { class: 'mono', text: i.author }) : null,
        i.symbol ? h('span', { class: 'tag', text: String(i.symbol).length > 14 ? String(i.symbol).slice(0, 12) + '…' : i.symbol }) : null,
        h('span', { text: ago(i.published) }), stars(i.importance)),
      h('div', { class: 'title' }, link(i.url, i.title || '(untitled)')),
      i.why ? h('div', { class: 'why', text: i.why }) : null,
      (tags.length || i.sentiment || metrics.likes || metrics.reposts) ? h('div', { class: 'bottom' },
        i.sentiment ? st(i.sentiment, i.sentiment === 'bullish' ? 'green' : (i.sentiment === 'bearish' ? 'red' : '')) : null,
        tags.map(function (t) { return h('span', { class: 'tag', text: t }); }),
        metrics.likes ? h('span', { text: '♥ ' + metrics.likes }) : null,
        metrics.reposts ? h('span', { text: '⟳ ' + metrics.reposts }) : null) : null);
  }

  function renderOverview() {
    return Promise.all([api('/api/equity?range=' + encodeURIComponent(S.filters.range)), api('/api/positions'), api('/api/decisions?limit=5'), api('/api/news'), api('/api/desk')])
      .then(function (r) {
        var eq = r[0], pos = r[1].positions || [], dec = r[2].decisions || [], news = r[3].items || [], desk = r[4].desk || [];
        var s = S.summary, a = s.account || {}, st_ = s.stats || {};
        var unreal = pos.reduce(function (acc, p) { return acc + (num(p.unrealized_pl) || 0); }, 0);
        var frag = [head('Overview', s.bot && s.bot.message ? s.bot.message : 'Account, trades and what the bot is doing')];
        frag.push(h('div', { class: 'tiles' },
          tile('Equity', money(a.equity), (a.starting_cash ? 'start ' + money(a.starting_cash) : '') +
            (a.borrowed ? ' · borrowed ' + money(a.borrowed) : '') + (a.interest_paid ? ' · interest ' + money(a.interest_paid) : '') || null),
          tile('P&L today', money(a.pnl_today, true), a.equity && a.pnl_today !== null ? pct(100 * a.pnl_today / (a.equity - a.pnl_today), true, 2) : null, tone(a.pnl_today)),
          tile('P&L total', money(a.pnl_total, true), a.starting_cash && a.pnl_total !== null ? pct(100 * a.pnl_total / a.starting_cash, true, 2) : null, tone(a.pnl_total)),
          tile('Win rate', st_.win_rate === null || st_.win_rate === undefined ? '—' : pct(100 * st_.win_rate, false, 0), (st_.wins || 0) + 'W · ' + (st_.losses || 0) + 'L of ' + (st_.closed || 0)),
          tile('Expectancy', rr(st_.expectancy_r), 'per closed trade, after costs', tone(st_.expectancy_r)),
          tile('Open positions', String(pos.length), pos.length ? money(unreal, true) + ' unrealized' : 'flat', pos.length ? tone(unreal) : '')));
        var pts = (eq.points || []).filter(function (p) { return num(p.v) !== null; });
        var eqBody = pts.length >= 2 ? lineChart(pts, { base: eq.start, label: 'equity curve' })
          : empty('No equity history yet — start the autopilot (python3 app/server.py --autopilot) or run the demo:', 'python3 scripts/demo.py');
        var daily = eq.daily || [];
        var dayBody = daily.length ? barChart(daily) : empty('Daily P&L appears after the first closed trade.');
        var rangeChips = h('div', { class: 'chips mini', role: 'group', 'aria-label': 'Equity range' },
          [['1d', '1D'], ['1w', '1W'], ['1m', '1M'], ['all', 'All']].map(function (o) {
            return h('button', { class: 'chip', type: 'button', 'aria-pressed': String(S.filters.range === o[0]),
              onclick: function () { S.filters.range = o[0]; refresh(); } }, o[1]);
          }));
        frag.push(h('div', { class: 'grid-2' },
          card('Equity', rangeChips, h('div', null, eqBody, h('div', { class: 'small faint', text: eq.source === 'broker' ? 'Broker snapshots · ' + pts.length + ' points' : 'Built from closed journal trades' }))),
          card('Daily P&L', daily.length ? daily.length + (daily.length === 1 ? ' day' : ' days') : null, dayBody)));
        var decBody = dec.length ? h('div', { class: 'rows' }, dec.map(function (d) { return decisionRow(d, true); }))
          : empty(s.bot && s.bot.installed ? 'The autopilot has not looked at any setup yet.' : 'The autopilot is not installed yet.');
        frag.push(h('div', { class: 'grid-even' },
          card('Open positions', pos.length ? pos.length + ' open' : null, positionRows(pos)),
          card('Latest bot decisions', null, decBody)));
        var top = news.slice().sort(function (x, y) {
          return (num(y.importance) || 0) - (num(x.importance) || 0) || String(y.published || '').localeCompare(String(x.published || ''));
        }).slice(0, 5);
        var newsBody = top.length ? h('div', { class: 'feed' }, top.map(newsCard)) : empty('No news yet — run', 'python3 trader-news/news.py');
        var deskBody = desk.length ? h('div', { class: 'rows' }, desk.slice(0, 6).map(function (d) {
          return h('div', { class: 'row' }, h('div', { class: 'title' }, h('span', { class: 'sym', text: d.symbol || d.id }), st(d.status || '?', statusColor(d.status))),
            h('div', { class: 'right' }, reportLink(d.report, 'Report')),
            h('div', { class: 'detail', text: (d.headline || '') + ' · ' + (d.objections || 0) + ' objections' }));
        })) : empty('No desk reviews yet — ask Claude to run /trader-desk on a setup.');
        frag.push(h('div', { class: 'grid-even' }, card('Top news', null, newsBody), card('Desk verdicts', null, deskBody)));
        return frag;
      });
  }

  function renderTrades() {
    var f = S.filters.trades;
    var q = '?asset=' + encodeURIComponent(f.asset) + '&status=' + encodeURIComponent(f.status) + '&setup=' + encodeURIComponent(f.setup);
    return api('/api/trades' + q).then(function (d) {
      var trades = d.trades || [], st_ = d.stats || {};
      var frag = [head('Trades', (st_.closed || 0) + ' closed · ' + (st_.open || 0) + ' open — every trade the journal knows about')];
      frag.push(h('div', { class: 'tiles' },
        tile('Total P&L', money(st_.pnl_total, true), 'closed trades', tone(st_.pnl_total)),
        tile('Win rate', st_.win_rate === null || st_.win_rate === undefined ? '—' : pct(100 * st_.win_rate, false, 0), (st_.wins || 0) + (st_.wins === 1 ? ' win · ' : ' wins · ') + (st_.losses || 0) + (st_.losses === 1 ? ' loss' : ' losses')),
        tile('Expectancy', rr(st_.expectancy_r), 'average R after costs', tone(st_.expectancy_r)),
        tile('Profit factor', st_.profit_factor === null || st_.profit_factor === undefined ? (st_.wins && !st_.losses ? '∞' : '—') : st_.profit_factor.toFixed(2), 'gross win ÷ gross loss')));
      frag.push(chips([['', 'All assets'], ['stock', 'Stocks'], ['crypto', 'Crypto'], ['meme', 'Meme']], f.asset, function (v) { f.asset = v; refresh(); }));
      frag.push(chips([['', 'Open + closed'], ['open', 'Open'], ['closed', 'Closed']], f.status, function (v) { f.status = v; refresh(); }));
      if ((d.setups || []).length > 1) frag.push(chips([['', 'All setups']].concat(d.setups.map(function (x) { return [x, x]; })), f.setup, function (v) { f.setup = v; refresh(); }));
      if (!trades.length) {
        frag.push(card('Trades', null, empty('No trades yet — start the autopilot or run the demo:', 'python3 scripts/demo.py')));
        return frag;
      }
      var list = h('div', { class: 'rows' });
      trades.forEach(function (t) { list.appendChild(tradeRow(t)); });
      frag.push(card('Journal', trades.length + ' shown', list));
      return frag;
    });
  }

  function tradeRow(t) {
    var entry = t.entry || {}, exit = t.exit || {};
    var unit = t.qty_unit === 'shares' ? 'sh' : (t.qty_unit || '');
    var open = !!S.expanded[t.id];
    var row = h('div', { class: 'row clickable', tabindex: 0, role: 'button', 'aria-expanded': String(open) },
      h('div', { class: 'title' }, st(t.asset || '?', t.asset === 'meme' ? 'purple' : (t.asset === 'crypto' ? 'amber' : 'blue')),
        h('span', { class: 'sym', text: t.display || t.symbol || '?' }), h('span', { class: 'muted', text: t.setup || '' }),
        st(t.status || '?', statusColor(t.status)), t.source === 'autopilot' ? st('auto', 'blue') : null),
      h('div', { class: 'right' }, h('div', { class: 'big ' + tone(t.r_net !== undefined && t.r_net !== null ? t.r_net : t.r_multiple),
        text: t.status === 'closed' ? rr(t.r_net !== undefined && t.r_net !== null ? t.r_net : t.r_multiple) : 'open' }),
        h('div', { class: 'sm ' + tone(t.pnl_usd), text: t.status === 'closed' ? money(t.pnl_usd, true) : (entry.time ? 'since ' + hm(entry.time) : '') })),
      h('div', { class: 'detail', text: price(entry.price) + (exit && exit.price ? ' → ' + price(exit.price) + ' (' + (exit.reason || '?') + ')' : '') +
        ' · ' + hm(entry.time, true) + (exit && exit.time ? ' → ' + hm(exit.time) : '') + ' · ' + qty(t.qty, unit === 'usd' ? 'usd' : unit) +
        (t.broker ? ' · ' + t.broker : '') + (t.paper === false ? ' · LIVE' : '') }));
    function toggle() {
      S.expanded[t.id] = !S.expanded[t.id];
      if (S.expanded[t.id]) row.appendChild(tradeDetail(t)); else { var ex = row.querySelector('.expand'); if (ex) ex.remove(); }
      row.setAttribute('aria-expanded', String(!!S.expanded[t.id]));
    }
    row.addEventListener('click', function (ev) { if (ev.target.closest('.expand')) return; toggle(); });
    row.addEventListener('keydown', function (ev) { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === row) { ev.preventDefault(); toggle(); } });
    if (open) row.appendChild(tradeDetail(t));
    return row;
  }

  function tradeDetail(t) {
    var box = h('div', { class: 'expand' }, h('div', { class: 'skel' }), h('div', { class: 'skel' }));
    var cached = S.tradeCache[t.id];
    var p = cached && Date.now() - cached.at < 60000 ? Promise.resolve(cached.data)
      : api('/api/trade/' + encodeURIComponent(t.id)).then(function (d) { S.tradeCache[t.id] = { at: Date.now(), data: d }; return d; });
    p.then(function (d) {
      clear(box);
      var tr = d.trade || t, entry = tr.entry || {}, exit = tr.exit || {};
      if ((d.candles || []).length > 3) {
        box.appendChild(candleChart(d.candles,
          [{ price: tr.target, label: 'Target', color: 'var(--green)', dash: true }, { price: entry.price, label: 'Entry', color: 'var(--blue)' },
           { price: tr.stop, label: 'Stop', color: 'var(--red)', dash: true }].concat(exit && exit.price ? [{ price: exit.price, label: 'Exit', color: 'var(--amber)' }] : []),
          [{ t: entry.time, price: entry.price, color: 'var(--blue)', shape: 'up' }].concat(exit && exit.time ? [{ t: exit.time, price: exit.price, color: 'var(--amber)', shape: 'down' }] : [])));
        box.appendChild(h('div', { class: 'legend' }, h('span', null, h('i', { class: 'lg-b' }), 'entry'), h('span', null, h('i', { class: 'lg-a' }), 'exit'),
          h('span', { class: 'faint', text: (d.candles_source || '') + ' · 5-min bars' })));
      } else {
        box.appendChild(h('div', { class: 'small faint', text: d.candles_error ? 'Chart unavailable: ' + d.candles_error : 'No candles for this trade.' }));
      }
      var kv = h('div', { class: 'kvgrid' });
      [['Entry', price(entry.price) + ' · ' + hm(entry.time, true)], ['Exit', exit && exit.price ? price(exit.price) + ' · ' + (exit.reason || '') : 'open'],
       ['Stop', price(tr.stop)], ['Target', price(tr.target)], ['Qty', qty(tr.qty, tr.qty_unit === 'usd' ? 'usd' : tr.qty_unit)],
       ['R (net)', rr(tr.r_net !== undefined && tr.r_net !== null ? tr.r_net : tr.r_multiple)], ['P&L', money(tr.pnl_usd, true)],
       ['Fees + slippage', money((num(tr.fees_usd) || 0) + (num(tr.slippage_usd) || 0))], ['Source', (tr.source || 'manual') + (tr.broker ? ' · ' + tr.broker : '')],
       ['Mode', tr.paper === false ? 'LIVE' : 'paper']].forEach(function (p2) {
        kv.appendChild(h('div', null, h('div', { class: 'k', text: p2[0] }), h('div', { class: 'v', text: p2[1] })));
      });
      box.appendChild(kv);
      var rl = reportLink(tr.chart, 'Open the trade report ↗');
      if (rl) box.appendChild(h('p', { class: 'small' }, rl));
    }).catch(function (e) { clear(box); box.appendChild(h('div', { class: 'small down', text: 'Could not load the trade: ' + e.message })); });
    return box;
  }

  function renderBot() {
    return api('/api/decisions?limit=200').then(function (d) {
      var s = S.summary, bot = s.bot || {}, m = s.mode || {}, ctl = s.control || {}, cfg = s.autopilot_config || {}, srv = (s.server || {}).autopilot || {};
      var hl = s.health || {}, daemonUp = hl.state === 'alive' && hl.runner === 'daemon';
      var frag = [head('Autopilot', bot.installed ? (bot.message || 'Trades for you within your gates and limits') : 'Not installed yet')];
      var status = String(bot.status || 'unknown');
      var paused = ctl.paused || status === 'paused' || status === 'killed';
      var controls = h('div', { class: 'btn-row' },
        h('button', { class: 'btn' + (paused ? ' btn-primary' : ''), type: 'button', onclick: function () { control(paused ? 'resume' : 'pause'); } }, paused ? '▶ Resume' : '❚❚ Pause'),
        h('button', { class: 'btn', type: 'button', onclick: function () { control('run_once'); } }, '↻ Run once'),
        h('button', { class: 'btn btn-danger', type: 'button', onclick: killDialog }, '■ KILL'));
      var stats = h('div', { class: 'kvgrid' });
      var beat = hl.state === 'never' ? 'never' : (hl.state + (hl.at ? ' · ' + ago(hl.at) : ''));
      [['Heartbeat', beat], ['Runner', hl.runner ? hl.runner + (hl.pid ? ' · pid ' + hl.pid : '') + (hl.host ? ' @ ' + hl.host : '') : '—'],
       ['Last cycle', bot.last_cycle ? hm(bot.last_cycle) + ' (' + ago(bot.last_cycle) + ')' : '—'], ['Next cycle', bot.next_cycle ? hm(bot.next_cycle) : '—'],
       ['Cycles', hl.cycle !== undefined && hl.cycle !== null ? String(hl.cycle) : (bot.cycles !== undefined && bot.cycles !== null ? String(bot.cycles) : '—')],
       ['Interval', bot.interval_sec ? bot.interval_sec + ' s' : '—'],
       ['Loop in this server', srv.thread ? (srv.deferred_to_daemon ? 'idle — daemon trades' : 'on') : 'off'],
       ['Control', ctl.kill ? 'KILL' : (ctl.paused ? 'paused' : 'normal') + (ctl.updated_at ? ' · ' + hm(ctl.updated_at) : '')]]
        .forEach(function (p) { stats.appendChild(h('div', null, h('div', { class: 'k', text: p[0] }), h('div', { class: 'v', text: p[1] }))); });
      var errs = (bot.last_errors || []).slice().reverse();
      var statusCard = card('Status', null, h('div', null,
        h('div', { class: 'status-big' }, h('span', { class: 'dot ' + status.replace(/\s+/g, '-') }), h('span', { text: status })),
        stats, h('div', { class: 'gap' }), controls,
        !bot.installed ? h('p', { class: 'small muted', text: 'trader-autopilot/ is not installed next to this app yet — the buttons still write autopilot/control.json.' }) : null,
        daemonUp ? h('p', { class: 'small muted', text: 'A separate 24/7 daemon is trading' + (hl.host ? ' on ' + hl.host : '') + ' — this page shows it and the buttons control it.' })
          : (!srv.thread ? h('p', { class: 'small muted' }, 'No loop is running in this server. Start one with ', h('code', { text: 'python3 app/server.py --autopilot' }), ' or run the 24/7 daemon: ', h('code', { text: 'python3 trader-autopilot/autopilot.py daemon --approve' }), '.') : null),
        errs.length ? h('div', { class: 'small' }, h('div', { class: 'muted', text: 'Recent errors' }),
          h('ul', { class: 'reasons' }, errs.map(function (e) { return h('li', { class: 'down', text: hm(e.at) + ' — ' + (e.error || '') }); }))) : null));
      var reqs = h('ul', { class: 'checklist' }, (m.live_requirements || []).map(function (r) {
        return h('li', null, h('span', { class: 'mark ' + (r.ok ? 'up' : 'faint'), text: r.ok ? '✓' : '○' }), h('span', { text: r.name }));
      }));
      var modeText = m.mode === 'live' ? 'LIVE — orders use real money at ' + (m.broker || 'the broker') + '.'
        : (m.mode === 'paper' ? 'PAPER — orders go to your ' + (m.broker || 'broker') + ' paper account. No real money.'
          : 'SIMULATOR — a local paper book fills orders against market data. No account, no real money.');
      var sec = s.secrets || {};
      var modeCard = card('Mode', null, h('div', null,
        h('p', { text: modeText }),
        h('p', { class: 'small muted', text: 'Live trading is switched on only by editing trader/config.json and trader/secrets.env yourself — there is deliberately no button for it here. It needs every item below:' }),
        reqs,
        h('div', { class: 'kvgrid' },
          h('div', null, h('div', { class: 'k', text: 'Alpaca paper keys' }), h('div', { class: 'v', text: sec.alpaca_paper ? 'set' : 'not set' })),
          h('div', null, h('div', { class: 'k', text: 'Alpaca live keys' }), h('div', { class: 'v', text: sec.alpaca_live ? 'set' : 'not set' })),
          h('div', null, h('div', { class: 'k', text: 'X API token' }), h('div', { class: 'v', text: sec.x_token ? 'set' : 'not set' })))));
      frag.push(h('div', { class: 'grid-even' }, statusCard, hoursCard(s.sessions || {})));
      var today = bot.today || {};
      frag.push(h('div', { class: 'tiles' },
        tile('Opened today', String(today.trades_opened || 0), cfg.max_new_trades_per_day ? 'max ' + cfg.max_new_trades_per_day + ' per day' : null),
        tile('Skipped today', String(today.skipped || 0), 'setups that failed a gate'),
        tile('Realized today', money(today.realized_pnl, true), null, tone(today.realized_pnl)),
        tile('Kill switch', today.kill_reason ? 'tripped' : 'off', today.kill_reason || (cfg.flatten_on_kill ? 'flattens positions' : 'cancels orders only'), today.kill_reason ? 'down' : '')));
      var g = cfg.gates || {};
      var gateList = h('ul', { class: 'checklist' },
        h('li', null, h('span', { class: 'mark', text: '1' }), h('span', { text: 'Fresh trigger: the setup fired on the last ' + (g.max_trigger_age_bars || 1) + ' closed bar(s)' })),
        h('li', null, h('span', { class: 'mark', text: '2' }), h('span', { text: 'Backtest edge: ≥ ' + (g.min_backtest_triggers || 10) + ' past triggers and expectancy ≥ ' + rr(g.min_backtest_expectancy_r || 0) + ' after costs' })),
        h('li', null, h('span', { class: 'mark', text: '3' }), h('span', { text: 'Time Machine: expected value ≥ ' + rr(g.min_tm_ev_r || 0) + ' over ' + (g.tm_paths || 2000).toLocaleString('en-US') + ' replays' })),
        h('li', null, h('span', { class: 'mark', text: '4' }), h('span', { text: newsGateText(cfg.news_gate) })),
        h('li', null, h('span', { class: 'mark', text: '5' }), h('span', { text: adaptText(cfg.adapt) })),
        h('li', null, h('span', { class: 'mark', text: '6' }), h('span', { text: 'Desk verdict GO' + ((s.ai_desk || {}).enabled ? ', then the AI desk (' + ((s.ai_desk || {}).model || 'Claude') + ') — it can only veto' : '') + ', then sizer + risk check PASS against trader/limits.json' })),
        h('li', null, h('span', { class: 'mark', text: '7' }), h('span', { text: 'Assets: ' + ((cfg.assets || []).join(', ') || '—') + ' — meme coins are never auto-traded' })));
      var setups = cfg.setups || {};
      var setupsLine = Object.keys(setups).map(function (k) { return (ASSET_LABEL[k] || k) + ': ' + (setups[k] || []).join(', '); }).join(' · ');
      frag.push(h('div', { class: 'grid-even' }, modeCard,
        card('Gates in force', 'every trade must pass all of them', h('div', null, gateList, setupsLine ? h('p', { class: 'small muted', text: setupsLine }) : null))));
      var decs = d.decisions || [], c = d.counts || {};
      var fdec = S.filters.decisions;
      var shown = decs.filter(function (x) { return !fdec || x.action === fdec; });
      var tl = shown.length ? h('div', { class: 'rows timeline' }, shown.slice(0, 120).map(function (x) { return decisionRow(x, false); }))
        : empty(decs.length ? 'Nothing matches this filter.' : 'No decisions yet — each setup the autopilot looks at shows up here with the reason it was taken or skipped.');
      frag.push(card('Decisions', (c.taken || 0) + ' taken · ' + (c.skipped || 0) + ' skipped · ' + (c.error || 0) + ' errors',
        h('div', null, chips([['', 'All'], ['taken', 'Taken'], ['skipped', 'Skipped'], ['error', 'Errors']], fdec, function (v) { S.filters.decisions = v; refresh(); }), tl)));
      return frag;
    });
  }

  function hoursCard(ss) {
    var cr = ss.crypto || {}, sk = ss.stock || {};
    function line(name, on, state, label, color, sub) {
      return h('div', { class: 'row' },
        h('div', { class: 'title' }, h('span', { text: name }), on ? st(state, color) : st('off', '')),
        h('div', { class: 'right' }),
        h('div', { class: 'detail', text: on ? label + (sub ? ' · ' + sub : '') : 'not in autopilot.assets' }));
    }
    var stockColor = sk.bot_trading ? 'green' : (sk.state === 'open' ? 'amber' : '');
    var sub = '';
    if (sk.state === 'open' && sk.closes_at) sub = 'closes ' + localDT(sk.closes_at) + ' (' + ago(sk.closes_at) + ')';
    else if (sk.next_open) sub = 'opens ' + localDT(sk.next_open) + ' (' + ago(sk.next_open) + ')';
    return card('Trading hours', 'your time · ' + TZ, h('div', null,
      h('div', { class: 'rows' },
        line('Crypto', cr.enabled !== false, 'open', cr.label || 'open 24/7', 'green', 'trades around the clock, every day'),
        line('US stocks', sk.enabled !== false, sk.state || '—', sk.label || '—', stockColor, sub)),
      sk.opens_at && sk.closes_at ? h('p', { class: 'small', text: 'Today\'s US session in your time: ' + hm(sk.opens_at) + '–' + hm(sk.closes_at) +
        (sk.entries_until ? ' · new stock trades until ' + hm(sk.entries_until) : '') + '.' }) : null,
      h('p', { class: 'small muted', text: 'Stocks trade only in the regular session (9:30–16:00 New York time): new entries until 15:30 ET, flat by 15:55 ET. ' +
        'Pre-market, after-hours and overnight are skipped on purpose — every stock setup and backtest here uses regular-session bars. ' +
        'Outside the session the bot keeps trading crypto, reading news and filings, and picks the stocks for the next open.' })));
  }
  function newsGateText(ng) {
    ng = ng || {};
    if (ng.enabled === false) return 'News & filings gate: off (autopilot.news_gate.enabled)';
    var lb = ng.lookback_hours || {}, crit = ng.critical_tags || {};
    var tags = (crit.stock || []).concat(crit.crypto || []);
    return 'News & filings: fresh headlines and SEC filings are read right before each trade; ' +
      (tags.length ? tags.join(', ') : 'serious') + ' news in the last ' + (lb.stock || 24) + ' h (stocks) / ' + (lb.crypto || 12) + ' h (crypto) blocks it';
  }
  function adaptText(ad) {
    ad = ad || {};
    if (ad.enabled === false) return 'Learning from its own record: off (autopilot.adapt.enabled)';
    return 'Its own record: a setup at ≤ ' + rr(ad.disable_below_r !== undefined ? ad.disable_below_r : -0.25) + ' over ≥ ' + (ad.min_trades || 8) +
      ' trades sits out ' + (ad.cooldown_days || 7) + ' days; ' + (ad.loss_streak || 3) + ' losses in a row → risk × ' + (ad.loss_streak_risk_mult || 0.5) +
      '; equity ' + (ad.max_drawdown_pct || 10) + '% below its peak → it pauses itself';
  }

  // ---------------------------------------------------------------- brain: universe, what it learned, AI desk, notifications
  function bar(share, cls) {
    share = Math.max(0, Math.min(100, num(share) || 0));
    return h('div', { class: 'budget' + (cls ? ' ' + cls : '') }, setWidth(h('span'), share));
  }
  function kvs(pairs) {
    var g = h('div', { class: 'kvgrid' });
    pairs.forEach(function (p) { if (p) g.appendChild(h('div', null, h('div', { class: 'k', text: p[0] }), h('div', { class: 'v ' + (p[2] || ''), text: p[1] }))); });
    return g;
  }
  function universeBlock(asset, a, sc) {
    var key = 'uni-' + asset, all = !!S.expanded[key], list = a.symbols || [];
    var shown = all ? list : list.slice(0, 12);
    var grid = h('div', { class: 'symgrid' }, shown.map(function (x) {
      return h('div', { class: 'symcell', title: x.symbol + (x.reason ? ' — ' + x.reason : '') },
        h('span', { class: 'sym', text: x.symbol }), h('span', { class: 'why', text: x.reason || '—' }));
    }));
    var more = list.length > 12 ? h('button', { class: 'btn btn-quiet', type: 'button', onclick: function () { S.expanded[key] = !all; refresh(); } },
      all ? 'Show fewer' : 'Show all ' + list.length) : null;
    var prog = sc ? h('div', { class: 'scanline' },
      h('span', { class: 'small muted', text: 'This bar: ' + (sc.done || 0) + ' / ' + (sc.total || '?') + ' scanned' + (sc.finished_at ? ' · done ' + hm(sc.finished_at) : '') }),
      bar(sc.pct, sc.pct >= 100 ? 'ok' : '')) : null;
    return h('div', { class: 'uniblock' },
      h('div', { class: 'unihead' }, h('b', { text: (asset === 'stock' ? 'US stocks' : 'Crypto') + ' · ' + list.length }),
        h('span', { class: 'small muted', text: (a.source || '') + (a.refreshed_at ? ' · refreshed ' + ago(a.refreshed_at) : '') })),
      prog, list.length ? grid : empty('No symbols.'), more);
  }
  function labCard(L) {
    var pb = L.playbook || {}, entries = pb.entries || [], sm = L.summary || {};
    var meta = L.available ? 'last run ' + ago(L.generated_at) + (L.costs ? ' · costs ' + pct(L.costs.round_trip_pct, false, 2) + ' round trip' : '') : null;
    if (!L.available && !entries.length) {
      return card('Backtest lab · crypto', meta, h('div', null,
        empty(L.required ? 'No lab run yet — the autopilot trades no crypto until the backtest lab validates something. The daemon runs it every ' + (L.auto_refresh_days || 7) + ' days, or run python3 trader-backtest/lab.py.' : 'The crypto playbook is switched off (autopilot.playbook.required_for_crypto).')));
    }
    var tiles = h('div', { class: 'tiles' },
      tile('Validated', String(entries.length), 'coin + setup combinations the bot may trade', entries.length ? '' : 'down'),
      tile('Setups that held', (sm.families_validated || 0) + ' / ' + (sm.families || 0), 'in every walk-forward period'),
      tile('Per-coin tuning survived', sm.per_coin_survival_rate === null || sm.per_coin_survival_rate === undefined ? '—' : pct(100 * sm.per_coin_survival_rate, false, 0), 'the luck check — near or below 50% means the per-coin "best settings" were luck'));
    var list = entries.length ? h('div', { class: 'rows' }, entries.map(function (e) {
      return h('div', { class: 'row' },
        h('div', { class: 'title' }, h('span', { class: 'sym', text: e.display }), st(e.setup + ' · ' + e.interval, 'blue'), st('risk × ' + e.risk_mult, e.risk_mult > 1 ? 'green' : (e.risk_mult < 1 ? 'amber' : ''))),
        h('div', { class: 'right' }, h('div', { class: 'big up', text: pct(100 * (e.profit_chance || 0), false, 0) }), h('div', { class: 'sm', text: 'profit chance' })),
        h('div', { class: 'detail', text: (e.exit || '') + ' · win ' + pct(100 * (e.win_rate || 0), false, 0) + ' · edge ' + rr(e.edge_r) + ' · ' + (e.trades || 0) + ' unseen trades' }));
    })) : empty('Nothing validated — no setup made money after costs in every period it was tested on unseen data, so the autopilot trades no crypto for now.');
    var trap = (L.highest_win || []).length ? h('details', { class: 'gates' }, h('summary', { text: 'Why not just the highest win chance?' }),
      h('ul', { class: 'reasons' }, L.highest_win.map(function (x) {
        return h('li', null, h('b', { text: x.setup + ' (' + x.timeframe + ')' }), ' — ' + (x.exit || '') + ': wins ' + pct(100 * (x.win_test || 0), false, 0) + ' of trades, but earns ' + rr(x.edge_test) + ' per trade after costs');
      })), h('p', { class: 'small muted', text: 'Small targets with wide stops win often and still lose money: the losses are bigger than the wins, and fees come out of every trade.' })) : null;
    return card('Backtest lab · crypto', meta, h('div', null, tiles, list, trap,
      h('p', { class: 'small muted', text: 'Walk-forward: for each of the last three periods the exit with the highest profit chance is picked on everything before it, all coins pooled, and traded unchanged in that period. A setup counts only if it made money in every period. The autopilot trades crypto only from the validated list, sizing up with certainty (never past trader/limits.json). ' + (pb.valid_until ? 'Valid until ' + localDT(pb.valid_until) + '.' : '') }),
      L.report ? reportLink(L.report, 'Open the full lab report') : null));
  }
  // ---------------------------------------------------------------- checks: six desks per decision, is it normal, backtest vs reality
  var VERDICT = { normal: ['NORMAL', 'green'], watch: ['WATCH', 'amber'], alarm: ['ALARM', 'red'], early: ['TOO EARLY', 'blue'],
    unknown: ['NO LAB DATA', ''], off: ['OFF', ''], ok: ['OK', 'green'], check: ['CHECK', 'red'], error: ['ERROR', 'red'] };
  var CALL = { BUY: 'green', 'WOULD BUY': 'blue', REJECT: 'red', ERROR: 'red' };
  var OUTCOME = { taken: 'green', ordered: 'green', skipped: '', missed: 'red', extra: 'red', error: 'red', pending: 'blue', 'not expected': '' };
  function verdictPill(v) { var x = VERDICT[v] || [String(v || '—').toUpperCase(), '']; return st(x[0], x[1]); }
  function deskBox(c) {
    var mark = c.state === 'pass' ? '✓' : (c.state === 'fail' ? '✗' : '–');
    var items = c.items || [];
    var shown = items.filter(function (i) { return !i.ok; }).concat(items.filter(function (i) { return i.ok; })).slice(0, 2);
    return h('div', { class: 'desk ' + c.state },
      h('div', { class: 'dk' }, h('span', { class: 'mark', text: mark }), h('span', { text: c.label })),
      items.length ? h('ul', null, shown.map(function (i) {
        return h('li', { class: i.ok ? '' : 'bad', title: i.detail || '', text: i.name + (i.detail ? ' — ' + i.detail : '') });
      })) : h('div', { class: 'small muted', text: 'no check recorded' }),
      items.length > 2 ? h('details', { class: 'gates' }, h('summary', { text: 'all ' + items.length }),
        h('ul', null, items.map(function (i) { return h('li', { class: i.ok ? '' : 'bad', text: (i.ok ? '✓ ' : '✗ ') + i.name + (i.detail ? ' — ' + i.detail : '') }); }))) : null);
  }
  function boardRow(b) {
    return h('div', { class: 'decision' },
      h('div', { class: 'dh' }, h('span', { class: 'sym', text: b.symbol || '?' }), st(b.asset || '', 'blue'),
        h('span', { class: 'muted', text: (b.setup || '') + (b.at ? ' · ' + ago(b.at) : '') }),
        h('span', { class: 'call' }, st(b.call, CALL[b.call] || ''))),
      h('div', { class: 'board' }, (b.columns || []).map(deskBox)),
      b.reason ? h('div', { class: 'small muted reason', text: b.reason }) : null);
  }
  function renderChecks() {
    return api('/api/checks').then(function (d) {
      var hd = d.health || {}, sd = d.shadow || {}, board = d.board || [];
      var frag = [head('Checks', 'Every decision through six desks · is it normal? · did the bot do what the rules say?')];
      frag.push(h('div', { class: 'tiles' },
        tile('Is it normal?', (VERDICT[hd.status] || [hd.status ? String(hd.status).toUpperCase() : '—'])[0], hd.trades !== undefined ? hd.trades + ' closed trades' : 'not checked yet',
          hd.status === 'alarm' ? 'down' : (hd.status === 'normal' ? 'up' : '')),
        tile('Backtest vs reality', (VERDICT[sd.verdict] || [sd.verdict ? String(sd.verdict).toUpperCase() : '—'])[0], sd.days ? 'last ' + sd.days + ' days' : 'checked once a day',
          sd.verdict === 'check' ? 'down' : (sd.verdict === 'ok' ? 'up' : '')),
        tile('Decisions shown', String(board.length), board.filter(function (b) { return b.call === 'BUY'; }).length + ' bought')));
      var hBody = hd.status ? h('div', null, h('p', { text: hd.text || '' }),
        (hd.checks || []).length ? h('ul', { class: 'reasons' }, hd.checks.map(function (c) {
          return h('li', null, verdictPill(c.verdict), ' ', c.text);
        })) : null,
        h('p', { class: 'small muted', text: 'Your closed trades, replayed thousands of times with results the backtest lab saw on unseen data. ALARM = worse than 9 of 10 of those histories — the bot pauses new entries until you resume it. Calibrated on 2018–2026: a false alarm about once in 5–8 years; a clearly losing strategy is caught after ~16 trades.' }))
        : empty('Checked every cycle once the bot has closed trades:', 'python3 trader-autopilot/autopilot.py check');
      frag.push(card('Is it normal?', hd.updated_at ? ago(hd.updated_at) : null, hBody));
      var rows = (sd.rows || []).slice(-25).reverse();
      var sBody = sd.verdict ? h('div', null, h('p', { text: sd.text || '' }),
        (sd.problems || []).length ? h('ul', { class: 'reasons warnlist' }, sd.problems.map(function (p) { return h('li', { class: 'warnc', text: p }); })) : null,
        rows.length ? h('div', { class: 'rows' }, rows.map(function (r) {
          return h('div', { class: 'row' },
            h('div', { class: 'title' }, st(r.outcome, OUTCOME[r.outcome] || ''), h('span', { class: 'sym', text: r.symbol || '?' }), h('span', { class: 'muted', text: r.setup || '' })),
            h('div', { class: 'right' }, h('div', { class: 'sm', text: (r.signal_at || '').slice(0, 10) }),
              r.slippage_bps !== undefined && r.slippage_bps !== null ? h('div', { class: 'sm', text: (r.slippage_bps >= 0 ? '+' : '') + r.slippage_bps + ' bps' }) : null),
            r.reason ? h('div', { class: 'detail', text: r.reason }) : null);
        })) : null)
        : empty('Runs once a day after the daily close, or now:', 'python3 trader-autopilot/autopilot.py check');
      frag.push(card('Backtest vs reality', sd.updated_at ? ago(sd.updated_at) : null, sBody));
      frag.push(card('Decisions — six desks', 'Research · News · Strategy · Execution · Risk · Boss',
        board.length ? h('div', { class: 'decisions' }, board.map(boardRow))
          : empty('No decisions yet — every signal the bot judges shows up here with all its checks.')));
      return frag;
    });
  }

  function renderBrain() {
    return api('/api/system').then(function (d) {
      var u = d.universe || {}, a = d.adapt || {}, ai = d.ai || {}, n = d.notify || {};
      var frag = [head('Brain', 'What the bot watches, what it learned from its own trades, and who double-checks it')];
      var ua = u.assets || {}, cfgU = u.config || {};
      var dd = num(a.drawdown_pct), ddMax = num(a.max_drawdown_pct);
      frag.push(h('div', { class: 'tiles' },
        tile('Stocks watched', ua.stock ? String(ua.stock.count) : '—', u.mode === 'auto' ? 'picked itself · top ' + (cfgU.stock_top_n || '?') : 'watchlist'),
        tile('Crypto watched', ua.crypto ? String(ua.crypto.count) : '—', u.mode === 'auto' ? 'by 24h volume · top ' + (cfgU.crypto_top_n || '?') : 'watchlist'),
        tile('Risk per trade', a.available ? '× ' + (num(a.risk_mult) === null ? '1' : String(+num(a.risk_mult).toFixed(2))) : '× 1', a.risk_reason || 'full size', num(a.risk_mult) !== null && num(a.risk_mult) < 1 ? 'down' : ''),
        tile('Drawdown', dd === null ? '—' : pct(dd, false, 1), ddMax !== null ? 'pauses itself at ' + pct(ddMax, false, 0) : null, a.drawdown_pause ? 'down' : ''),
        tile('Setups sitting out', String(a.paused_setups || 0), (a.cooling || 0) + ' symbol' + (a.cooling === 1 ? '' : 's') + ' cooling off', a.paused_setups ? 'down' : ''),
        tile('AI desk', ai.enabled ? (ai.ready ? 'on' : 'not ready') : 'off', ai.enabled ? (ai.today ? (ai.today.calls || 0) + ' calls · ' + money(ai.today.usd) + ' today' : '') : 'optional, veto only', ai.enabled && !ai.ready ? 'down' : '')));

      // universe
      var uniMeta = (u.mode === 'auto' ? 'auto — it picks its own symbols' : 'watchlist only') + (u.generated_at ? ' · ' + ago(u.generated_at) : '');
      var uniBody;
      if (!u.available) {
        uniBody = empty('The universe is built on the autopilot\'s first cycle (mode: ' + (u.mode || 'auto') + ').');
      } else {
        uniBody = h('div', null,
          (u.warnings || []).length ? h('ul', { class: 'reasons warnlist' }, u.warnings.map(function (w) { return h('li', { class: 'warnc', text: w }); })) : null,
          h('div', { class: 'grid-even tight' },
            ua.stock ? universeBlock('stock', ua.stock, (u.scan || {}).stock) : empty('No stocks — not in autopilot.assets.'),
            ua.crypto ? universeBlock('crypto', ua.crypto, (u.scan || {}).crypto) : empty('No crypto — not in autopilot.assets.')),
          (u.excluded || []).length ? h('details', { class: 'gates' }, h('summary', { text: u.excluded.length + ' left out on purpose' }),
            h('ul', { class: 'reasons' }, u.excluded.map(function (x) { return h('li', null, h('b', { class: 'mono', text: x.symbol }), ' — ' + x.reason); }))) : null,
          h('p', { class: 'small muted', text: 'Your watchlists are always included. Stocks: a built-in list of liquid US names ranked by today\'s moves plus Yahoo\'s most active and day gainers (refreshed every ' +
            (cfgU.stock_refresh_minutes || 60) + ' min). Crypto: top coins by 24h volume, no stablecoins or wrapped tokens (every ' + (cfgU.crypto_refresh_minutes || 240) + ' min). Meme coins are never on it.' }));
      }
      frag.push(card('What it watches', uniMeta, uniBody));
      frag.push(labCard(d.lab || {}));

      // what it learned
      var learnBody;
      if (!a.available) {
        learnBody = h('div', null, empty(a.enabled === false ? 'Learning from its own record is switched off (autopilot.adapt.enabled).' : 'Nothing learned yet — the record starts with the autopilot\'s first closed trade.'),
          h('p', { class: 'small muted', text: adaptText(a.config) }));
      } else {
        var setRows = (a.setups || []).length ? h('div', { class: 'rows' }, a.setups.map(function (x) {
          var paused = x.status !== 'active';
          var wr = num(x.trades) ? Math.round(100 * (num(x.wins) || 0) / num(x.trades)) + '% wins' : '';
          return h('div', { class: 'row' },
            h('div', { class: 'title' }, x.asset ? st(x.asset, x.asset === 'crypto' ? 'amber' : 'blue') : null, h('span', { class: 'sym', text: x.setup }),
              st(paused ? 'sitting out' : 'active', paused ? 'red' : 'green')),
            h('div', { class: 'right' }, h('div', { class: 'big ' + tone(x.expectancy_r), text: rr(x.expectancy_r) }), h('div', { class: 'sm', text: (x.trades || 0) + ' trades' + (wr ? ' · ' + wr : '') })),
            (paused || x.reason) ? h('div', { class: 'detail', text: (x.reason || '') + (paused && x.until ? ' · back ' + localDT(x.until) : '') }) : null);
        })) : empty('No setup has enough closed trades yet (' + ((a.config || {}).min_trades || 8) + ' needed).');
        var symRows = (a.symbols || []).filter(function (x) { return x.status !== 'active' || num(x.loss_streak); });
        var symBody = symRows.length ? h('div', { class: 'rows' }, symRows.map(function (x) {
          var cool = x.status !== 'active';
          return h('div', { class: 'row' }, h('div', { class: 'title' }, h('span', { class: 'sym', text: x.symbol }), st(cool ? 'cooling off' : 'watching', cool ? 'amber' : '')),
            h('div', { class: 'right' }, h('div', { class: 'sm', text: (x.loss_streak || 0) + ' loss' + (x.loss_streak === 1 ? '' : 'es') + ' in a row' })),
            h('div', { class: 'detail', text: (x.reason || '') + (cool && x.until ? ' · back ' + localDT(x.until) : '') }));
        })) : null;
        var ddShare = dd !== null && ddMax ? 100 * dd / ddMax : 0;
        var evs = (a.events || []).length ? h('div', { class: 'rows timeline' }, a.events.map(function (e) {
          return h('div', { class: 'row' }, h('div', { class: 'time', text: hm(e.at, true) }),
            h('div', null, h('span', { class: 'tag', text: String(e.kind || '').replace(/_/g, ' ') }), ' ', h('span', { text: e.text || '' })), h('div', { class: 'right' }));
        })) : null;
        learnBody = h('div', null,
          kvs([['Risk multiplier', '× ' + String(+((num(a.risk_mult) === null ? 1 : num(a.risk_mult))).toFixed(2)), num(a.risk_mult) < 1 ? 'down' : ''],
               ['Losses in a row', String(a.loss_streak || 0)],
               ['Equity vs peak', money(a.equity) + ' / ' + money(a.equity_peak)],
               ['Updated', a.updated_at ? ago(a.updated_at) : '—']]),
          a.risk_reason ? h('p', { class: 'small', text: a.risk_reason }) : null,
          h('div', { class: 'small muted', text: 'Drawdown ' + (dd === null ? '—' : pct(dd, false, 1)) + ' of the ' + (ddMax === null ? '—' : pct(ddMax, false, 0)) + ' it allows before pausing itself' }),
          bar(ddShare, ddShare >= 100 ? 'full' : (ddShare >= 60 ? 'warn' : '')),
          h('div', { class: 'gap' }), h('h3', { class: 'sub-h', text: 'Setups, by its own closed trades' }), setRows,
          symBody ? [h('h3', { class: 'sub-h', text: 'Symbols' }), symBody] : null,
          evs ? [h('h3', { class: 'sub-h', text: 'Recent changes' }), evs] : null,
          h('p', { class: 'small muted', text: adaptText(a.config) }));
      }
      frag.push(card('What it learned', a.available ? 'from ' + ((a.setups || []).reduce(function (t, x) { return t + (num(x.trades) || 0); }, 0)) + ' closed autopilot trades' : null, learnBody));

      // AI desk
      var t = ai.today || {};
      var maxCalls = num(ai.max_calls_per_day), maxUsd = num(ai.max_usd_per_day);
      var aiState = ai.enabled ? (ai.ready ? st('ready', 'green') : st('not ready', 'red')) : st('off', '');
      var aiBody = h('div', null,
        h('p', { class: 'small muted', text: 'Optional. Claude reviews only trades the rule-based desk already passed (a Skeptic and a Lead) and can veto them — it can never approve a trade a hard gate rejected.' }),
        kvs([['Model', ai.model || '—'], ['API key', ai.key ? 'set' : 'not set', ai.key ? '' : (ai.enabled ? 'down' : '')],
             ['Python SDK', ai.sdk ? 'installed' : 'not installed', ai.sdk ? '' : (ai.enabled ? 'down' : '')],
             ['If unavailable', ai.on_unavailable === 'skip' ? 'skip the trade' : 'rule-based decision']]),
        ai.enabled ? h('div', null,
          h('div', { class: 'small gap-t' }, h('b', { text: 'Today: ' }), (t.calls || 0) + (maxCalls ? ' / ' + maxCalls : '') + ' calls · ' + money(t.usd) + (maxUsd !== null ? ' / ' + money(maxUsd) : '')),
          bar(maxUsd ? 100 * (num(t.usd) || 0) / maxUsd : 0, maxUsd && (num(t.usd) || 0) >= maxUsd ? 'full' : '')) : null,
        !ai.enabled ? h('p', { class: 'small muted' }, 'Turn it on with ', h('code', { text: '"ai_desk": {"enabled": true}' }), ' in trader/config.json, ANTHROPIC_API_KEY in your secrets and ', h('code', { text: 'pip install anthropic' }), '. Budget-capped per day.') : null,
        (ai.recent || []).length ? h('div', { class: 'rows' }, ai.recent.map(function (r) {
          return h('div', { class: 'row' }, h('div', { class: 'title' }, h('span', { class: 'sym', text: r.id }), st(r.status || '?', statusColor(r.status))),
            h('div', { class: 'right' }, h('div', { class: 'sm', text: (r.usd !== null && r.usd !== undefined ? money(r.usd) + ' · ' : '') + (r.at ? hm(r.at) : '') })),
            h('div', { class: 'detail', text: (r.objections || 0) + ' objection' + (r.objections === 1 ? '' : 's') + (r.top ? ' — ' + r.top : (r.reason ? ' — ' + r.reason : '')) }));
        })) : null);

      // notifications
      var ntfy = n.ntfy || {}, tg = n.telegram || {};
      function chan(v) { v = String(v || ''); return v === 'sent' ? '✓' : (/^off|offline/.test(v) ? '–' : '✗'); }
      var notBody = h('div', null,
        kvs([['ntfy', ntfy.configured ? 'topic set · ' + (ntfy.server || 'ntfy.sh') : 'no topic', ntfy.configured ? '' : 'faint'],
             ['Telegram', tg.enabled ? ((tg.bot_token && tg.chat_id) ? 'on' : 'missing ' + (!tg.bot_token ? 'TELEGRAM_BOT_TOKEN' : 'TELEGRAM_CHAT_ID')) : 'off', tg.enabled && !(tg.bot_token && tg.chat_id) ? 'down' : ''],
             ['Daily summary', n.daily_summary_et ? n.daily_summary_et + ' ET' : '—'],
             ['Limit', n.max_per_hour ? n.max_per_hour + ' / hour' : '—']]),
        ntfy.short_topic ? h('p', { class: 'small warnc', text: 'Your ntfy topic is short — anyone who guesses it can read your alerts. Use a long random one.' }) : null,
        (n.events || []).length ? h('div', { class: 'small gap-t' }, h('span', { class: 'muted', text: 'Sends: ' }), n.events.map(function (e) { return h('span', { class: 'tag', text: e.replace(/_/g, ' ') }); })) : null,
        (n.recent || []).length ? h('div', { class: 'rows' }, n.recent.map(function (r) {
          var ch = r.channels || {};
          var chs = Object.keys(ch).map(function (k) { return k + ' ' + chan(ch[k]); }).join(' · ');
          return h('div', { class: 'row' }, h('div', { class: 'title' }, h('span', { class: 'tag', text: String(r.event || '').replace(/_/g, ' ') }), h('span', { text: r.title || '' })),
            h('div', { class: 'right' }, h('div', { class: 'sm', text: hm(r.at) })),
            h('div', { class: 'detail', text: (r.suppressed ? 'not sent: ' + r.suppressed + (chs ? ' · ' : '') : '') + chs }));
        })) : empty(n.enabled ? 'No notifications yet.' : 'Off — set "notify": {"enabled": true, "ntfy_topic": "<long random name>"} in trader/config.json and subscribe to the topic in the ntfy app.'));
      frag.push(h('div', { class: 'grid-even' },
        card('AI desk', aiState, aiBody),
        card('Notifications', n.enabled ? st('on', 'green') : st('off', ''), notBody)));
      return frag;
    });
  }

  function control(action) {
    post('/api/control', { action: action }).then(function () {
      toast(({ pause: 'Paused — no new trades from the next cycle; exits keep running.', resume: 'Resumed — the drawdown guard starts counting from today\'s equity.', run_once: 'Requested one cycle now.' })[action] || 'Done.');
      refresh();
    }).catch(function (e) { toast('Failed: ' + e.message); });
  }

  function killDialog() {
    var input = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': 'Type KILL to confirm', placeholder: 'KILL' });
    var go = h('button', { class: 'btn btn-danger', type: 'button', disabled: true }, 'Stop everything');
    var cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
    var bg = h('div', { class: 'modal-bg', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Kill switch' },
      h('div', { class: 'modal' }, h('h3', { text: 'Kill switch' }),
        h('p', { text: 'Cancels every open order and closes every position the autopilot holds (if flatten_on_kill is on), then stops the bot until you resume it. Type KILL to confirm.' }),
        input, h('div', { class: 'btn-row' }, go, cancel)));
    function close() { bg.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(ev) { if (ev.key === 'Escape') close(); }
    input.addEventListener('input', function () { go.disabled = input.value.trim() !== 'KILL'; });
    cancel.addEventListener('click', close);
    bg.addEventListener('click', function (ev) { if (ev.target === bg) close(); });
    go.addEventListener('click', function () {
      post('/api/control', { action: 'kill', confirm: input.value.trim() }).then(function () { close(); toast('Kill switch on — orders cancelled and positions flattened at the next cycle.'); refresh(); })
        .catch(function (e) { toast('Failed: ' + e.message); });
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(bg);
    input.focus();
  }

  function renderNews() {
    var f = S.filters.news;
    var q = '?asset=' + encodeURIComponent(f.asset) + '&symbol=' + encodeURIComponent(f.symbol) + '&kind=' + encodeURIComponent(f.kind);
    return api('/api/news' + q).then(function (d) {
      var items = d.items || [];
      var refreshBtn = h('button', { class: 'btn', type: 'button', onclick: function () {
        refreshBtn.disabled = true;
        post('/api/news/refresh', {}).then(function (j) { toast(j.ok ? 'Refreshing the feed…' : (j.message || 'Refresh not available')); setTimeout(refresh, 4000); })
          .catch(function (e) { toast('Failed: ' + e.message); }).then(function () { refreshBtn.disabled = false; });
      } }, '↻ Refresh');
      var frag = [head('News & social', (d.updated_at ? 'updated ' + ago(d.updated_at) : 'from ' + (d.source || 'news.json')) + ' · ' + (d.total || 0) + ' items', refreshBtn)];
      var srcs = d.sources || {};
      var srcRows = Object.keys(srcs).length ? h('div', { class: 'srcgrid' }, Object.keys(srcs).map(function (k) {
        var v = String(srcs[k]);
        var c = v === 'ok' ? 'up' : (/token|budget/.test(v) ? 'warnc' : (/error|fail/.test(v) ? 'down' : 'faint'));
        return h('div', { class: 'srcitem', title: k + ': ' + v }, h('span', { class: 'src ' + srcClass(k), text: k === 'X' ? '𝕏' : k }),
          h('span', { class: 'small ' + c, text: v === 'ok' ? '● ok' : '● ' + (v.length > 30 ? v.slice(0, 28) + '…' : v) }));
      })) : empty('Source status appears after the first feed refresh.');
      var xu = d.x_usage;
      var budget = null;
      if (xu && num(xu.max_reads_per_day)) {
        var used = num(xu.reads) || 0, max = num(xu.max_reads_per_day), share = 100 * used / max;
        budget = h('div', null, h('div', { class: 'small' }, h('b', { text: '𝕏 read budget today: ' }), used + ' / ' + max + ' posts'),
          h('div', { class: 'budget' + (share >= 100 ? ' full' : (share >= 75 ? ' warn' : '')) }, setWidth(h('span'), share)),
          h('div', { class: 'small faint', text: 'X bills every post read — the feed stops reading X when the daily budget is used.' }));
      } else {
        budget = h('p', { class: 'small muted' }, 'X needs your own API token (pay-per-use). Add X_BEARER_TOKEN to trader/secrets.env to include posts from your chosen accounts.');
      }
      var senti = d.sentiment || {};
      var sentiKeys = Object.keys(senti);
      var sentiBody = sentiKeys.length ? h('div', null, sentiKeys.map(function (k) {
        var b = senti[k].bullish || 0, br = senti[k].bearish || 0, tot = b + br || 1;
        return h('div', { class: 'senti' }, h('span', { class: 'mono', text: k }),
          h('div', { class: 'bar' }, setWidth(h('span', { class: 'b' }), 100 * b / tot), setWidth(h('span', { class: 's' }), 100 * br / tot)),
          h('span', { class: 'mono small', text: Math.round(100 * b / tot) + '%', title: b + ' bullish · ' + br + ' bearish' }));
      }), h('div', { class: 'legend' }, h('span', null, h('i', { class: 'lg-g' }), 'bullish'), h('span', null, h('i', { class: 'lg-r' }), 'bearish'))) : empty('StockTwits sentiment appears once the feed has tagged posts.');
      frag.push(h('div', { class: 'grid-even' }, card('Sources', null, h('div', null, srcRows, budget)), card('StockTwits sentiment', '% of tagged posts that are bullish', sentiBody)));
      frag.push(chips([['', 'All'], ['stock', 'Stocks'], ['crypto', 'Crypto'], ['meme', 'Meme']], f.asset, function (v) { f.asset = v; refresh(); }));
      frag.push(chips([['', 'Everything'], ['news', 'News'], ['social', 'Social'], ['filing', 'Filings']], f.kind, function (v) { f.kind = v; refresh(); }));
      if ((d.symbols || []).length) frag.push(chips([['', 'All symbols']].concat(d.symbols.map(function (x) { return [x, x.length > 14 ? x.slice(0, 12) + '…' : x]; })), f.symbol, function (v) { f.symbol = v; refresh(); }));
      frag.push(items.length ? h('div', { class: 'feed' }, items.map(newsCard)) : card('Feed', null, empty('Nothing here yet — press Refresh, or run', 'python3 trader-news/news.py')));
      return frag;
    });
  }

  function renderSetups() {
    return api('/api/setups').then(function (d) {
      var assets = d.assets || {};
      var keys = ['stock', 'crypto', 'meme'].filter(function (k) { return assets[k]; });
      var frag = [head('Setups', 'Latest scanner hits — the autopilot only acts on fresh triggers that pass every gate')];
      if (!keys.length) { frag.push(card('Setups', null, empty('No scans yet — ask Claude for /trader-scanner or run', 'python3 trader-scanner/scan.py --asset stock'))); return frag; }
      keys.forEach(function (k) {
        var doc = assets[k], u = doc.universe || {}, hits = doc.setups || [];
        var first = hits.find ? hits.find(function (x) { return x.chart; }) : null;
        var meta = h('span', { class: 'meta' }, (u.total ? (u.scanned || 0) + ' of ' + u.total + ' scanned · ' : '') + (doc.generated_at ? ago(doc.generated_at) : ''),
          first ? [' · ', reportLink(first.chart, 'scan report ↗')] : null);
        var rows = hits.length ? h('div', { class: 'rows' }, hits.slice(0, 40).map(function (x, i) {
          var tr = x.trigger || {};
          var sc = num(x.score) || 0;
          var score = h('span', { class: 'score', title: 'score ' + sc.toFixed(0) }, setWidth(h('span'), sc));
          return h('div', { class: 'row' },
            h('div', { class: 'title' }, h('span', { class: 'faint mono', text: String(i + 1) + '.' }), h('span', { class: 'sym', text: x.display || x.symbol || '?' }),
              h('span', { class: 'muted', text: x.label || x.setup || '' }), st(x.status || '?', statusColor(x.status))),
            h('div', { class: 'right' }, h('div', { class: 'big', text: price(x.last_price) }), h('div', { class: 'sm' }, score)),
            h('div', { class: 'detail' }, (x.rule || '') + (tr.time ? ' · ' + hm(tr.time) : ''),
              (x.flags || []).length ? [' ', (x.flags || []).map(function (fl) { return h('span', { class: 'tag', text: fl }); })] : null));
        })) : empty('No setups in the last scan.');
        var hidden = (doc.hidden || []).length ? h('details', { class: 'gates' }, h('summary', { text: doc.hidden.length + ' hidden by rugcheck' }),
          h('ul', { class: 'reasons' }, doc.hidden.map(function (x) { return h('li', { text: (x.symbol || '?') + ' — ' + (x.reason || '') }); }))) : null;
        frag.push(card(ASSET_LABEL[k] || k, meta, h('div', null, rows, hidden)));
      });
      return frag;
    });
  }

  var REPORT_KINDS = { timemachine: 'Time Machine', scan: 'Scanner', entry: 'Entry', plan: 'Exit plans', backtest: 'Backtests',
    desk: 'Desk', rugcheck: 'Rug checks', journal: 'Journal', trade: 'Trades', news: 'News', arb: 'Arbitrage gaps', index: 'Index' };
  function renderReports() {
    return api('/api/reports').then(function (d) {
      var rows = d.reports || [];
      var frag = [head('Reports', rows.length + ' HTML reports written by the skills — open in a new tab')];
      if (!rows.length) { frag.push(card('Reports', null, empty('No reports yet — run any skill, or the demo:', 'python3 scripts/demo.py'))); return frag; }
      var groups = {};
      rows.forEach(function (r) { (groups[r.kind] = groups[r.kind] || []).push(r); });
      var order = Object.keys(REPORT_KINDS).filter(function (k) { return groups[k]; }).concat(Object.keys(groups).filter(function (k) { return !REPORT_KINDS[k]; }));
      var wrap = h('div', { class: 'grid-even' });
      order.forEach(function (k) {
        wrap.appendChild(card(REPORT_KINDS[k] || cap(k), groups[k].length + '', h('div', { class: 'rows' }, groups[k].map(function (r) {
          var label = r.name.replace(/\.html$/, '').replace(/^[a-z]+-/, '');
          return h('div', { class: 'row' }, h('div', { class: 'title' }, reportLink(r.name, label.length > 46 ? label.slice(0, 44) + '…' : label)),
            h('div', { class: 'right' }, h('div', { class: 'sm', text: ago(r.modified, true), title: r.modified })));
        }))));
      });
      frag.push(wrap);
      return frag;
    });
  }

  var VIEWS = { overview: renderOverview, trades: renderTrades, bot: renderBot, checks: renderChecks, brain: renderBrain, news: renderNews, setups: renderSetups, reports: renderReports };

  // ---------------------------------------------------------------- routing + refresh
  function tabFromHash() {
    var m = /tab=([a-z]+)/.exec(location.hash || '');
    var o = /open=([A-Za-z0-9._:%-]+)/.exec(location.hash || '');
    if (o) { try { S.expanded[decodeURIComponent(o[1])] = true; } catch (e) { /* bad hash */ } }
    return m && TABS.indexOf(m[1]) >= 0 ? m[1] : 'overview';
  }
  function markTabs() {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      if (b.getAttribute('data-tab') === S.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }
  function refresh() {
    if (S.busy) { S.again = true; return Promise.resolve(); }
    S.busy = true;
    var tab = S.tab;
    return api('/api/summary').then(function (s) {
      S.summary = s;
      renderTop();
      return VIEWS[tab]();
    }).then(function (frag) {
      if (tab !== S.tab) return;
      var view = $('view');
      var y = window.scrollY;
      S.charts = [];
      clear(view);
      append(view, frag);
      window.scrollTo(0, y);
      var b = backgroundBanner();
      setBanner(b[0], b[1]);
    }).catch(function (e) {
      setBanner('Could not load data: ' + e.message + ' — is the server still running?', 'error');
    }).then(function () {
      S.busy = false;
      if (S.again) { S.again = false; refresh(); }
    });
  }
  function go(tab) {
    if (location.hash !== '#tab=' + tab) location.hash = 'tab=' + tab;
    else { S.tab = tab; markTabs(); refresh(); }
  }

  function initTheme() {
    var t = 'dark';
    try { t = localStorage.getItem('trader-theme') || 'dark'; } catch (e) { /* private mode */ }
    var forced = /theme=(light|dark)/.exec(location.hash || '');
    if (forced) t = forced[1];
    document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : 'dark');
    $('theme-btn').addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('trader-theme', next); } catch (e) { /* ignore */ }
      S.charts.forEach(function (c) { if (c.box.isConnected) c.draw(c.box); });
    });
  }

  function init() {
    initTheme();
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.addEventListener('click', function () { go(b.getAttribute('data-tab')); window.scrollTo(0, 0); });
    });
    window.addEventListener('hashchange', function () { S.tab = tabFromHash(); markTabs(); window.scrollTo(0, 0); refresh(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
    S.tab = tabFromHash();
    markTabs();
    $('view').appendChild(h('div', null, h('div', { class: 'skel' }), h('div', { class: 'skel' }), h('div', { class: 'skel' })));
    refresh();
    setInterval(function () { if (!document.hidden && !document.querySelector('.modal-bg')) refresh(); }, REFRESH_MS);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
