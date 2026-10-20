#!/usr/bin/env python3
"""Time Machine report — the self-contained HTML page for a replay.

replay.py calls this automatically; run it on its own to rebuild a page from a
saved trader/timemachine/*.json file.

Examples:
  python3 report.py                                  # newest replay
  python3 report.py --file timemachine/TSLA-20261020.json --open
"""
from __future__ import annotations

import os
import sys

_ROOT = os.environ.get("TRADER_PACK_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isdir(os.path.join(_ROOT, "shared")):
    sys.exit("trader: shared/ not found next to this skill — install the shared/ folder alongside the trader-* folders")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from shared import cli, fmt, html, market_clock, setups, state  # noqa: E402

# Two renderings of each chart: a wide one for desktop and a compact one whose labels stay
# readable on a phone; CSS shows exactly one of them, so the page never scrolls sideways.
EXTRA_CSS = """<style>
.mob{display:none}
@media (max-width:640px){.desk{display:none}.mob{display:block}}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin:8px 0 2px;font:12px/1.5 var(--mono);color:var(--muted)}
.legend i{display:inline-block;width:12px;height:3px;border-radius:2px;margin-right:6px;vertical-align:middle}
.method{margin:6px 0 0;padding-left:18px;font-size:13.5px}.method li{margin:3px 0}
.honest{font-size:13.5px;color:var(--muted)}
.note{font:12px/1.5 var(--mono);color:var(--muted);margin-top:6px}
</style>"""

OUTCOME_COLORS = {"target": "green", "stop": "red", "neither": "blue", "rug": "purple"}
OUTCOME_LABELS = {"target": "target first", "stop": "stop first", "neither": "neither", "rug": "rug pull"}


def _pct(p) -> str:
    return "%.0f%%" % (100.0 * (p or 0))


def _lines(res):
    return [{"price": res["stop"], "label": "Stop", "color": "red"},
            {"price": res["entry"], "label": "Entry", "color": "ink", "dash": True},
            {"price": res["target"], "label": "Target", "color": "green"}]


def _time_labels(res):
    stock = res["asset"] == "stock"
    out = []
    for t in res.get("path_times") or []:
        out.append(market_clock.fmt_et(t) if stock else market_clock.from_ts(market_clock.ts(t)).strftime("%H:%M"))
    return out


def _display_paths(res):
    """Rug paths fall 90 %; clip them to just under the chart's floor so the other paths stay readable."""
    paths = res.get("sample_paths") or []
    normal = [v for p in paths if p["outcome"] != "rug" for v in p["prices"]]
    if not any(p["outcome"] == "rug" for p in paths) or not normal:
        return paths, False
    floor = min(min(normal), res["stop"]) * 0.97
    out = []
    for p in paths:
        if p["outcome"] == "rug":
            out.append({"outcome": "rug", "prices": [max(v, floor) for v in p["prices"]]})
        else:
            out.append(p)
    return out, True


def _histogram_values(res):
    """Expand the stored bins back into representative values (bin mid-points) for the SVG histogram."""
    h = res.get("histogram") or {}
    edges, counts = h.get("edges") or [], h.get("counts") or []
    vals = []
    for k, c in enumerate(counts):
        mid = (edges[k] + edges[k + 1]) / 2.0
        vals.extend([mid] * int(c))
    return vals, len(counts) or 40


def _legend(res):
    p = res["probabilities"]
    items = []
    for k in ("target", "stop", "neither", "rug"):
        if k == "rug" and res["asset"] != "meme":
            continue
        items.append("<span><i style='background:%s'></i>%s · %s</span>" % (
            html.COLORS[OUTCOME_COLORS[k]], html.esc(OUTCOME_LABELS[k]), html.esc(_pct(p.get(k)))))
    return "<div class='legend'>%s</div>" % "".join(items)


def _tiles(res):
    p = res["probabilities"]
    ev = res["expected_value"]
    c = res["close"]
    tail = "by the close" if res["asset"] == "stock" else "in window"
    items = [("Target first", _pct(p["target"]), "good"), ("Stop first", _pct(p["stop"]), "bad"),
             ("Neither " + tail, _pct(p["neither"]), "info")]
    if res["asset"] == "meme":
        items.append(("Rug pull", _pct(p["rug"]), "bad" if p["rug"] else ""))
    usd = ev["usd"]
    items += [("Expected value", "%+.2fR · %s%s" % (ev["r"], "+" if usd >= 0 else "-",
                                                    fmt.money(abs(usd), decimals=0 if abs(usd) >= 10 else 2)),
               "good" if ev["r"] > 0 else "bad"),
              ("9 in 10 close", "%s – %s" % (fmt.price(c["p5"]), fmt.price(c["p95"])), ""),
              ("Median close", fmt.price(c["median"]), "")]
    return html.tiles(items)


def _fan(res):
    paths, clipped = _display_paths(res)
    labels = _time_labels(res)
    desk = html.fan_chart(paths, _lines(res), labels, width=960, height=380, counter_total=res["n_paths"],
                          chart_id="fan", title="fan chart of %d simulated paths" % len(paths))
    mob = html.fan_chart(paths, _lines(res), labels, width=430, height=330, counter_total=res["n_paths"],
                         chart_id="fan-m", title="fan chart of %d simulated paths" % len(paths))
    note = ("%d of %s replays shown (stratified by outcome). %s" % (
        len(paths), fmt.count(res["n_paths"]),
        "Rug-pull paths fall 90%% — clipped at the bottom of the chart." if clipped else ""))
    return ("<div class='desk'>%s</div><div class='mob'>%s</div>%s<div class='note'>%s</div>"
            % (desk, mob, _legend(res), html.esc(note.strip())))


def _hist(res):
    vals, bins = _histogram_values(res)
    stop, target = res["stop"], res["target"]

    def tone(price):
        return "red" if price < stop else "green" if price > target else "blue"
    desk = html.histogram(vals, bins, _lines(res), width=960, height=300, tone=tone, title="closing prices")
    mob = html.histogram(vals, bins, [], width=430, height=260, tone=tone, title="closing prices")
    key = ("<div class='legend'><span><i style='background:%s'></i>Stop %s</span>"
           "<span><i style='background:%s'></i>Entry %s</span><span><i style='background:%s'></i>Target %s</span></div>"
           % (html.COLORS["red"], html.esc(fmt.price(stop)), html.COLORS["ink"], html.esc(fmt.price(res["entry"])),
              html.COLORS["green"], html.esc(fmt.price(target))))
    c = res["close"]
    note = "Where each replay stood at %s. Red bars close below the stop, green above the target; " \
           "values beyond the 0.5–99.5th percentile are piled into the edge bins." % (
               "the 4:00 p.m. close" if res["asset"] == "stock" else "the end of the window")
    rugs = (res.get("histogram") or {}).get("rug_excluded")
    if rugs:
        note += " %s rug-pull replays (price −90%%) are left out of the bars but included in the 9-in-10 range." % (
            fmt.count(rugs))
    return ("<div class='desk'>%s</div><div class='mob'>%s%s</div>"
            "<p class='summary' style='margin-top:10px'>9 in 10 replays close between <b>%s</b> and <b>%s</b>; "
            "median <b>%s</b>, mean %s.</p><div class='note'>%s</div>"
            % (desk, mob, key, html.esc(fmt.price(c["p5"])), html.esc(fmt.price(c["p95"])),
               html.esc(fmt.price(c["median"])), html.esc(fmt.price(c["mean"])), html.esc(note)))


def _backtest(res):
    bt = res.get("backtest")
    p = res["probabilities"]
    if not bt:
        return ("<p>No backtest of this setup on file. Run <code>/trader-backtest</code> (or replay with "
                "<code>--with-backtest</code>) to compare the simulation with what this setup really did.</p>")
    rows = [("P(target first)", _pct(p["target"]), _pct(bt.get("p_target"))),
            ("P(stop first)", _pct(p["stop"]), _pct(bt.get("p_stop"))),
            ("P(neither)", _pct(p["neither"]), _pct(bt.get("p_neither"))),
            ("Average R", "%+.2fR" % res["expected_value"]["r"],
             ("%+.2fR" % bt["avg_r"]) if bt.get("avg_r") is not None else "n/a"),
            ("Sample", "%s replays" % fmt.count(res["n_paths"]),
             "%s triggers in %s windows" % (bt.get("triggers") or 0, bt.get("windows") or "?"))]
    out = html.table(["", "Time Machine", "Backtest"], rows)
    if bt.get("summary"):
        out += "<div class='note'>%s</div>" % html.esc(bt["summary"])
    gap = abs((bt.get("p_target") or 0) - p["target"])
    if bt.get("triggers") and gap > 0.15:
        out += ("<p class='warn'>The replay and the backtest disagree by %s on the target rate — today's "
                "volatility or this setup's track record is unusual. Trust neither blindly.</p>" % _pct(gap))
    return out


def _method(res):
    m = res["method"]
    h = res["history"]
    hist = ("%d sessions" % h["sessions"]) if res["asset"] == "stock" else ("%.1f days" % h["days"])
    items = [
        "History: %s of %s candles from %s (%s → %s), %s bars — nothing after the entry is used." % (
            hist, setups.bar_label(res["interval"]), h["source"], (h["first"] or "")[:16].replace("T", " "),
            (h["last"] or "")[:16].replace("T", " "), fmt.count(h["bars"])),
        "Paths: %s, %d steps of %s bars from %s to %s (%s)." % (
            fmt.count(res["n_paths"]), res["steps"], setups.bar_label(res["interval"]), _clock(res, res["entry_time"]),
            _clock(res, res["horizon_end"]), res["horizon_label"]),
        "Block bootstrap: blocks of %d consecutive real bars drawn from the same time-of-day bucket (%s)." % (
            m["block_len"], ", ".join("%s %s" % (k.replace("_", " "), fmt.count(v)) for k, v in sorted(m["buckets"].items()))),
        "Each bar keeps its real high/low range relative to the previous close, so jumps and fat tails survive.",
        "Volatility scaled to recent realized volatility, bucket by bucket (%s; average ×%.2f)%s." % (
            ", ".join("%s ×%.2f" % (k.replace("_", " "), v) for k, v in sorted((m.get("bucket_scales") or {}).items())),
            m["vol_scale"], ", widened ×1.25 for a thin sample" if h["thin_sample"] else ""),
        ("Average drift removed: the replay does not assume the recent trend continues." if m.get("drift_removed")
         else "Historical drift kept (--keep-drift)."),
        "Exits use the same bar-by-bar logic as the backtester: stop before target when one bar touches both, "
        "gaps through the stop fill at the open, time stop at %s." % _clock(res, res["time_stop"]),
        "Seed %d — the same seed always gives the same result." % res["seed"],
    ]
    if res["asset"] == "meme":
        items.append("Rug scenario: %s of paths collapse 90%% at a random bar (%s). Exit slippage %.2f%% on "
                     "stop/time/rug exits (pool liquidity %s)." % (
                         _pct(m["rug_share"]), m["rug_basis"], m["exit_slippage_pct"],
                         fmt.compact_usd(m["liquidity_usd"]) if m.get("liquidity_usd") else "unknown"))
    if m.get("scale_out"):
        items.append("Scale-outs: " + ", ".join("%d%% at %s" % (100 * float(s["fraction"]), fmt.price(s["price"]))
                                                for s in m["scale_out"] if s.get("price")))
    if m.get("trailing"):
        items.append("Trailing stop: %s %s." % (m["trailing"].get("type"), m["trailing"].get("value")))
    items.append("Position for the $ figures: %s." % res["expected_value"].get("basis", "n/a"))
    honesty = ("This is a statistical simulation built from past price behaviour, not a prediction. It ignores news "
               "shocks, halts and overnight gaps, assumes fills at your levels, and excludes fees.")
    if res["asset"] == "meme":
        honesty += (" Meme-coin data can be manipulated (wash trading, fake volume), and real rug pulls are far less "
                    "polite than a −90% bar.")
    lis = "".join("<li>%s</li>" % html.esc(i) for i in items)
    return "<ul class='method'>%s</ul><p class='honest'>%s</p>" % (lis, html.esc(honesty))


def _clock(res, iso_value) -> str:
    if res["asset"] == "stock":
        return market_clock.fmt_et_ampm(iso_value) + " ET"
    return market_clock.fmt_utc(iso_value)


def render(res: dict) -> str:
    title = "Time Machine · %s" % res["display"]
    sub = "%s · entry %s at %s · %s replays · %s" % (
        res.get("setup_label") or res.get("setup") or "trade", fmt.price(res["entry"]),
        _clock(res, res["entry_time"]), fmt.count(res["n_paths"]), res["horizon_label"])
    warn = ""
    if res.get("warnings"):
        warn = "<div class='note'>%s</div>" % "<br>".join(html.esc("! " + w) for w in res["warnings"])
    body = "".join([
        html.card("", "<p class='summary'>%s</p>%s" % (html.esc(res["summary"]), warn)),
        _tiles(res),
        html.card("Where the replays went", _fan(res)),
        html.card("Closing price distribution", _hist(res)),
        html.card("Historical check", _backtest(res)),
        html.card("How this was simulated", _method(res)),
    ])
    return html.page(title, body, sub, res["asset"], EXTRA_CSS)


def report_name(res: dict) -> str:
    day = (res.get("file") or "").rsplit("-", 1)[-1].replace(".json", "")
    if not day.isdigit():
        day = res["entry_time"][:10].replace("-", "")
    return "timemachine-%s-%s.html" % (res["symbol_key"], day)


def write(res: dict):
    return html.write_report(report_name(res), render(res))


def build_parser():
    p = cli.parser("report.py", __doc__)
    p.add_argument("--file", help="replay JSON inside trader/ (default: the newest timemachine/*.json)")
    return p


def newest_file() -> str:
    folder = state.home() / "timemachine"
    files = sorted(folder.glob("*.json"), key=lambda f: f.stat().st_mtime)
    if not files:
        raise ValueError("no replays in trader/timemachine/ — run replay.py first")
    return "timemachine/" + files[-1].name


@cli.entrypoint
def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    cli.init(args)
    rel_path = args.file or newest_file()
    res = state.read_json(rel_path)
    if not res:
        raise ValueError("cannot read trader/%s" % rel_path)
    path = write(res)
    text = "Time Machine report for %s (%s)\n%s" % (res["display"], rel_path, cli.report_line(path))
    cli.emit(args, text, {"file": rel_path, "report": state.rel(path)}, res["asset"])
    cli.maybe_open(args, path)
    return 0


if __name__ == "__main__":
    cli.run(main)
