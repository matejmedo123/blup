"""Bar-by-bar trade outcome: stop, target, time stop, trailing stop and scale-outs.

Used by the backtester (real bars), the Time Machine (simulated bars) and the
journal (paper-trade outcome). Conservative by design: when one bar touches
both the stop and the target we assume the stop came first, and a gap through
the stop fills at the bar's open.
"""
from __future__ import annotations


def risk_per_unit(entry: float, stop: float) -> float:
    return abs(entry - stop)


def target_from_r(entry: float, stop: float, r_multiple: float) -> float:
    return entry + r_multiple * (entry - stop)


def estimate_slippage_pct(size_usd: float, liquidity_usd: float):
    """Constant-product pool estimate: average price impact ≈ size ÷ quote-side reserve (half the liquidity).

    Concentrated-liquidity pools can be better or much worse — treat as a rough guide.
    """
    if not liquidity_usd or liquidity_usd <= 0 or size_usd is None:
        return None
    return 100.0 * float(size_usd) / (float(liquidity_usd) / 2.0)


def max_size_for_slippage(liquidity_usd: float, max_slippage_pct: float):
    if not liquidity_usd or liquidity_usd <= 0:
        return 0.0
    return max_slippage_pct / 100.0 * liquidity_usd / 2.0


def cost_pct(fee_bps: float = 0.0, slippage_bps: float = 0.0) -> float:
    """Per-side cost in percent."""
    return (float(fee_bps or 0) + float(slippage_bps or 0)) / 100.0


def net_r(entry: float, exit_price: float, risk: float, cost_pct_per_side: float = 0.0) -> float:
    if not risk:
        return 0.0
    c = cost_pct_per_side / 100.0
    return ((exit_price * (1 - c)) - (entry * (1 + c))) / risk


def walk(bars, entry: float, stop: float, target: float, end_ts: int = None, step: int = 300,
         trailing: dict = None, scale_out=None, atr_value: float = None) -> dict:
    """Walk ``bars`` (all strictly after the entry bar) until the trade is over.

    outcome: 'target' | 'stop' | 'time' (horizon/time stop reached) | 'open' (ran out of bars)
    """
    risk = entry - stop
    if risk <= 0:
        raise ValueError("stop %.6g must be below entry %.6g for a long trade" % (stop, entry))
    cur_stop = stop
    remaining = 1.0
    realized = 0.0
    partials = []
    levels = sorted(scale_out or [], key=lambda s: s["price"])
    done = [False] * len(levels)
    hi_close = hi_high = entry
    lo_low = entry
    outcome, fill, exit_t, held = "open", None, None, 0
    stopped_by = None
    for b in bars:
        if end_ts is not None and b.t >= end_ts:
            break
        held += 1
        lo_low = min(lo_low, b.l)
        if b.o <= cur_stop:
            outcome, fill, exit_t = "stop", b.o, b.t
            stopped_by = "trailing" if cur_stop > stop else "stop"
            break
        if b.l <= cur_stop:
            outcome, fill, exit_t = "stop", cur_stop, b.t + step
            stopped_by = "trailing" if cur_stop > stop else "stop"
            break
        for k, lvl in enumerate(levels):
            if not done[k] and b.h >= lvl["price"] and remaining > 1e-9:
                frac = min(lvl["fraction"], remaining)
                realized += frac * lvl["price"]
                remaining -= frac
                done[k] = True
                partials.append({"fraction": frac, "price": lvl["price"], "t": b.t + step})
        hi_high = max(hi_high, b.h)
        if b.h >= target:
            outcome, fill, exit_t = "target", target, b.t + step
            break
        if end_ts is not None and b.t + step >= end_ts:
            outcome, fill, exit_t = "time", b.c, b.t + step
            break
        hi_close = max(hi_close, b.c)
        if trailing:
            kind, v = trailing.get("type"), float(trailing.get("value") or 0)
            if kind == "breakeven_at_r" and hi_high >= entry + v * risk:
                cur_stop = max(cur_stop, entry)
            elif kind == "atr" and atr_value:
                cur_stop = max(cur_stop, hi_close - v * atr_value)
            elif kind == "pct":
                cur_stop = max(cur_stop, hi_high * (1 - v / 100.0))
    if fill is None:
        last = bars[held - 1] if held else None
        fill = last.c if last else entry
        exit_t = (last.t + step) if last else None
    avg_exit = realized + remaining * fill
    return {
        "outcome": outcome,
        "exit_price": avg_exit,
        "last_fill": fill,
        "exit_t": exit_t,
        "bars_held": held,
        "r_multiple": (avg_exit - entry) / risk,
        "mfe_r": (hi_high - entry) / risk,
        "mae_r": (lo_low - entry) / risk,
        "partials": partials,
        "final_stop": cur_stop,
        "stopped_by": stopped_by,
    }
