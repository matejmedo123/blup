"""Where state lives, what the defaults are, and whether we are offline.

Every skill keeps its state in a ``trader/`` folder of the user's project
(``$TRADER_HOME`` overrides it) so each skill can pick up what the previous
one wrote.
"""
from __future__ import annotations

import copy
import json
import os
import tempfile
from pathlib import Path

PACK_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_CONFIG = {
    "sec_user_agent": "Your Name your.email@example.com",
    "account_size": 25000,
    "account_currency": "USD",
    "risk_per_trade_pct": 0.5,
    # positions may use borrowed money only up to this multiple of equity, and only when limits.json allows it
    # (allow_margin / allow_leverage + max_leverage); see leverage() below
    "leverage": {"stock": 1.0, "crypto": 1.0},
    "borrow_rate_pct": 10.0,
    "cash_yield_pct": 0.0,      # simulator: what idle cash earns a year (T-bills); 0 = nothing
    "fractional_shares": False,
    "watchlists": {
        "stocks": ["TSLA", "NVDA", "AAPL", "AMD", "META"],
        "crypto": ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
        "meme": [],
    },
    "meme_chains": ["solana", "base"],
    "quote_currency": "USDT",
    "crypto_horizon": "4h",
    "meme_horizon": "4h",
    "paper": True,
    "connector": "alpaca",
    "costs": {
        "stock": {"fee_bps": 0, "slippage_bps": 2},
        "crypto": {"fee_bps": 10, "slippage_bps": 3},
        "meme": {"fee_bps": 30, "slippage_bps": 100},
    },
    "autopilot": {
        "enabled": False,
        "broker": "simulator",
        "mode": "paper",
        "interval_sec": 60,
        "assets": ["stock", "crypto"],
        "watchlist": None,
        "setups": {"stock": ["orb15", "orb30", "gap_and_go", "vwap_reclaim", "bull_flag"],
                   "crypto": ["asia_range", "us_open_range", "vwap_reclaim", "momentum"]},
        "gates": {"min_backtest_triggers": 10, "min_backtest_expectancy_r": 0.05, "min_tm_ev_r": -0.05,
                  "tm_paths": 2000, "max_trigger_age_bars": 1},
        "max_new_trades_per_day": 5,
        "flatten_on_kill": True,
        "sim_starting_cash": 25000,
        "live_confirmation": "",
        "universe": {
            "mode": "auto",
            "stocks": {"top_n": 40, "refresh_minutes": 60, "base": None, "include_movers": True, "max_movers": 10,
                       "min_market_cap_usd": 2000000000},
            "crypto": {"top_n": 20, "refresh_minutes": 240, "min_volume_usd": 50000000},
            "always": [],
            "exclude": [],
        },
        "scan_time_budget_sec": 40,
        # let part of a winner ride (setups with a runner rule): off unless you turn it on; by default only while
        # the latest lab run found that it paid on periods nobody tuned on
        "runner": {"enabled": False, "require_lab": True, "keep": None},
        # is it normal? the bot's own trades against the lab's unseen-data trades (shared/health.py)
        "health": {"enabled": True, "min_trades": 10, "window": 30, "alarm_pct": 10.0, "watch_pct": 25.0,
                   "pause_on_alarm": True, "paths": 2000, "block": 20, "cap_r": 3.0},
        # while crypto is in a bear market (Bitcoin below its 200-day average), the daily trend rule on ETFs that
        # move unlike crypto; held for days; only what the ETF lab validated (trader-backtest/lab.py --etf)
        "etf_trend": {"enabled": False, "when": "crypto_bear", "required_lab": True,
                      "symbols": ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "DBC", "UUP", "XLE", "XLF", "XLK", "SMH"]},
        "playbook": {"required_for_crypto": True, "max_age_days": 14, "auto_refresh_days": 7, "top": 25,
                     "min_target_r": 0, "confidence_sizing": True, "max_risk_mult": 2.0,
                     "max_risk_pct": None, "setups": None, "timeframes": None,
                     "risk_tiers": [[0.9, 2.0], [0.8, 1.5], [0.7, 1.0], [0.0, 0.5]], "boost_min_test_trades": 30},
        "news_gate": {
            "enabled": True,
            "refresh_before_trade": True,
            "refresh_max_age_minutes": 10,
            "lookback_hours": {"stock": 24, "crypto": 12},
            "market_hours": 6,
            "min_credibility": 2,
            "critical_tags": {"stock": ["offering", "dilution", "bankruptcy", "delisting", "restatement"],
                              "crypto": ["hack", "delisting"]},
            "major_tags": {"stock": ["merger", "fda", "control"], "crypto": ["token_unlock"]},
            # daily trend trades were validated by the lab without any news filter: only these stop them
            "trend_block_tags": ["delisting", "bankruptcy"],
            "market_blocks": False,  # news about the whole market (mostly other projects' hacks) is shown, never blocks
        },
        "adapt": {
            "enabled": True,
            "min_trades": 8,
            "disable_below_r": -0.25,
            "cooldown_days": 7,
            "symbol_loss_streak": 3,
            "symbol_cooldown_days": 5,
            "loss_streak": 3,
            "loss_streak_risk_mult": 0.5,
            "max_drawdown_pct": 10,
        },
    },
    "notify": {
        "enabled": False,
        "ntfy_topic": "",
        "ntfy_server": "https://ntfy.sh",
        "telegram": False,
        "events": ["started", "stopped", "trade_opened", "trade_closed", "kill", "paused", "learned", "error",
                   "daily_summary"],
        "daily_summary_et": "16:10",
        "max_per_hour": 30,
    },
    "ai_desk": {
        "enabled": False,
        "model": "claude-opus-5-5",
        "max_calls_per_day": 40,
        "max_usd_per_day": 3.0,
        "timeout_sec": 45,
        "on_unavailable": "rule_based",
    },
    "news": {
        "x": {"enabled": True, "max_reads_per_day": 300, "poll_minutes": 15,
              "accounts": {"stock": ["DeItaone", "FirstSquawk", "LiveSquawk", "unusual_whales", "WSJmarkets",
                                     "Reuters"],
                           "crypto": ["tier10k", "WatcherGuru", "WuBlockchain", "lookonchain", "whale_alert",
                                      "CoinDesk"]}},
        "stocktwits": {"enabled": True},
        "feed_max_items": 500,
    },
    "scanner": {
        "interval": "5m",
        "max_symbols": 300,
        "time_budget_sec": 240,
        "min_price": 2.0,
        "min_avg_volume": 300000,
        "top_n_crypto": 30,
        "gap_min_pct": 3.0,
        "relvol_min": 2.0,
    },
}

DEFAULT_LIMITS = {
    "global": {"max_daily_loss_usd": 750, "max_daily_trades": 10, "max_open_positions": 10},
    "stock": {
        "max_risk_per_trade_usd": 250,
        "max_daily_loss_usd": 500,
        "max_open_positions": 5,
        "max_position_pct": 25,
        "max_daily_trades": 6,
        "allow_shorts": False,
        "allow_margin": False,
        "max_leverage": 1.0,
        "allow_options": False,
    },
    "crypto": {
        "max_risk_per_trade_usd": 200,
        "max_daily_loss_usd": 400,
        "max_open_positions": 5,
        "max_position_pct": 15,
        "max_total_exposure_pct": 50,
        "max_daily_trades": 6,
        "allow_shorts": False,
        "allow_leverage": False,
        "max_leverage": 1.0,
    },
    "meme": {
        "max_risk_per_trade_usd": 50,
        "max_daily_loss_usd": 100,
        "max_open_positions": 2,
        "max_position_pct": 2,
        "max_total_exposure_pct": 5,
        "max_daily_trades": 4,
        "min_liquidity_usd": 50000,
        "max_slippage_pct": 3.0,
        "max_pct_of_pool": 1.0,
        "required_rugcheck_verdicts": ["SAFE"],
        "rugcheck_max_age_minutes": 60,
    },
    "blocked_symbols": [],
}

# No file can lift this: past 2× a normal day's move against a full book eats the account.
LEVERAGE_HARD_CAP = 2.0
LEVERAGE_ASSETS = ("stock", "crypto")

SUBDIRS = ("cache", "reports", "rugcheck", "timemachine", "backtests", "autopilot", "broker")


def trader_home() -> Path:
    env = os.environ.get("TRADER_HOME")
    if env:
        return Path(env).expanduser().resolve()
    return (Path.cwd() / "trader").resolve()


def fixtures_dir() -> Path:
    env = os.environ.get("TRADER_FIXTURES")
    if env:
        return Path(env).expanduser().resolve()
    return PACK_ROOT / "tests" / "fixtures"


def is_offline() -> bool:
    return os.environ.get("TRADER_OFFLINE", "").strip().lower() in ("1", "true", "yes", "on")


def deep_merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


class ConfigError(ValueError):
    """config.json / limits.json can't be used (a typo while editing it by hand)."""


def atomic_write(path: Path, text: str) -> None:
    """Write through a temp file of its own, flushed to disk, then renamed over the target: a reader sees the old
    file or the new one — never half of one, and two writers never share (and truncate) one temp file."""
    path = Path(path)
    fd, tmp = tempfile.mkstemp(prefix="." + path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, str(path))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    try:  # the rename itself survives a power cut only once the folder is on disk too
        dfd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except (OSError, AttributeError):
        pass


def _write_default(path: Path, obj: dict) -> None:
    if path.exists():
        return
    atomic_write(path, json.dumps(obj, indent=2) + "\n")


def ensure_home() -> Path:
    home = trader_home()
    # yours alone when it is created: keys, journal and approvals are nobody else's business on a shared host
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    for sub in SUBDIRS:
        (home / sub).mkdir(exist_ok=True, mode=0o700)
    _write_default(home / "config.json", DEFAULT_CONFIG)
    _write_default(home / "limits.json", DEFAULT_LIMITS)
    return home


_NUM_SUFFIXES = ("_pct", "_usd", "_sec", "_days", "_minutes", "_hours", "_bps", "_r", "_mult", "_trades",
                 "_positions", "_leverage", "_n", "_paths", "_size", "_per_day", "_per_hour")
# must be above zero: 0 would not mean "off" — a daily-loss limit of 0 kills at once, a 0 interval never waits
_POSITIVE = ("max_daily_loss_usd", "max_daily_loss_pct", "max_risk_per_trade_usd", "max_risk_per_trade_pct",
             "max_position_pct", "max_total_exposure_pct", "max_leverage", "risk_per_trade_pct", "account_size",
             "interval_sec", "max_risk_mult")
MIN_INTERVAL_SEC = 5
warnings = []   # settings that were fixed up on load (an explicit null limit → its default); the autopilot shows them


def _kind(key: str, default):
    if isinstance(default, bool) or key in ("enabled", "paper") or key.startswith("allow_") or key.endswith("_enabled"):
        return "bool"
    if isinstance(default, (int, float)) or (default is None and key.endswith(_NUM_SUFFIXES)):
        return "number"
    if isinstance(default, dict):
        return "object"
    if isinstance(default, list):
        return "list"
    if isinstance(default, str):
        return "text"
    return None


def _check(doc: dict, defaults: dict, where: str, problems: list, path: str = "") -> None:
    for key, value in list(doc.items()):
        here = path + key
        default = (defaults or {}).get(key)
        kind = _kind(key, default)
        if value is None:
            if kind == "number" and isinstance(default, (int, float)) and not isinstance(default, bool):
                doc[key] = default  # null never means "no limit": a limit you can't see is no limit at all
                note = "%s %s is null — using the default %s (set a number to change it)" % (where, here, default)
                if note not in warnings:
                    warnings.append(note)
            elif kind in ("bool", "object"):
                problems.append("%s must be %s, not null" % (here, "true or false" if kind == "bool" else "an object"))
            continue
        if kind == "bool" and not isinstance(value, bool):
            problems.append("%s must be true or false (without quotes), not %s" % (here, json.dumps(value)))
        elif kind == "number":
            if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
                problems.append("%s must be a number (like 5, not \"5%%\" or \"5\"), not %s" % (here, json.dumps(value)))
            elif key in _POSITIVE and value <= 0:
                problems.append("%s must be above 0 (%s would not switch it off — use a large number instead)"
                                % (here, value))
            elif key == "interval_sec" and value < MIN_INTERVAL_SEC:
                problems.append("interval_sec must be at least %d seconds" % MIN_INTERVAL_SEC)
        elif kind == "object":
            if not isinstance(value, dict):
                problems.append("%s must be an object { … }, not %s" % (here, json.dumps(value)))
            else:
                _check(value, default if isinstance(default, dict) else {}, where, problems, here + ".")
        elif kind == "list" and not isinstance(value, list):
            problems.append("%s must be a list [ … ], not %s" % (here, json.dumps(value)))
        elif kind == "text" and not isinstance(value, str):
            problems.append("%s must be text in quotes, not %s" % (here, json.dumps(value)))


def validate(name: str, doc: dict, defaults: dict) -> dict:
    """Types checked against the defaults: a value of the wrong type is an error, never silently "truthy" or "no
    limit". Raises ConfigError listing every problem."""
    problems = []
    _check(doc, defaults, name, problems)
    if problems:
        raise ConfigError("%s has %d problem%s: %s" % (name, len(problems), "" if len(problems) == 1 else "s",
                                                       "; ".join(problems[:8])))
    return doc


def _load(name: str, defaults: dict) -> dict:
    path = ensure_home() / name
    try:
        user = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ConfigError("cannot read %s (%s) — fix or delete it to restore defaults" % (path, exc))
    if not isinstance(user, dict):
        raise ConfigError("%s must contain a JSON object" % path)
    return validate(name, deep_merge(defaults, user), defaults)


def update_file(name: str, changes: dict) -> dict:
    """Merge ``changes`` into your own trader/<name> (not the defaults) and save it atomically."""
    path = ensure_home() / name
    try:
        user = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ConfigError("cannot read %s (%s) — fix or delete it to restore defaults" % (path, exc))
    merged = deep_merge(user if isinstance(user, dict) else {}, changes)
    atomic_write(path, json.dumps(merged, indent=2) + "\n")
    return merged


def load_config() -> dict:
    return _load("config.json", DEFAULT_CONFIG)


def load_limits() -> dict:
    return _load("limits.json", DEFAULT_LIMITS)


def leverage(cfg: dict, limits: dict, asset: str, broker: str = None) -> tuple:
    """(multiple, why): how far this asset class may go past the cash in the account.

    1.0 unless config ``leverage.<asset>`` asks for more AND limits.json allows it (``allow_margin`` for
    stocks, ``allow_leverage`` for crypto, at most ``max_leverage``). Never above LEVERAGE_HARD_CAP, never
    for meme coins, never for crypto at Alpaca (it has no crypto margin). Leverage only lets more money
    work at once; the risk per trade is still set by the stop.
    """
    if asset not in LEVERAGE_ASSETS:
        return 1.0, None
    want = (cfg.get("leverage") or {}).get(asset) if isinstance(cfg.get("leverage"), dict) else cfg.get("leverage")
    try:
        want = float(want or 1.0)
    except (TypeError, ValueError):
        return 1.0, "leverage.%s is not a number — no leverage" % asset
    if want <= 1.0:
        return 1.0, None
    lim = (limits or {}).get(asset) or {}
    key = "allow_margin" if asset == "stock" else "allow_leverage"
    if lim.get(key) is not True:
        return 1.0, "config asks for %g× but limits.json %s.%s is false — no leverage" % (want, asset, key)
    if broker is None:
        broker = (cfg.get("autopilot") or {}).get("broker") or cfg.get("connector")
    if broker == "alpaca" and asset == "crypto":
        return 1.0, "Alpaca has no crypto margin — crypto stays at 1× there"
    cap = min(float(lim.get("max_leverage") or 1.0), LEVERAGE_HARD_CAP)
    lev = max(1.0, min(want, cap))
    why = "%g× (config %g×, limits.json max %g×, hard cap %g×)" % (lev, want, float(lim.get("max_leverage") or 1.0),
                                                                    LEVERAGE_HARD_CAP)
    return lev, why


def sec_user_agent(cfg: dict = None) -> str:
    """SEC asks for a real name + e-mail in the User-Agent; placeholders don't count."""
    value = os.environ.get("SEC_USER_AGENT") or (cfg or {}).get("sec_user_agent") or ""
    value = value.strip()
    if "@" not in value or "example.com" in value:
        return ""
    return value
