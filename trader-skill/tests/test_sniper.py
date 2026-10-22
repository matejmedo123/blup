"""Meme sniper: the checks from a careful trader's list (liquidity at our size, holders, rug pull and honeypot,
fake hype), the three strategies, the budget, the exits — and live only after every step of the opt-in."""
from __future__ import annotations

import os
from unittest import mock

from shared import config, http, market_clock as mc, state
from shared.indicators import Candle
from tests.helpers import TraderTestCase, load

NOW = "2026-10-22T10:00:00Z"


def sn():
    return load("trader-sniper", "sniper")


def pair(**kw):
    p = {"chain": "solana", "dex": "pumpswap", "pair_address": "POOL", "url": "https://dexscreener.com/x",
         "base": {"address": "MINT", "symbol": "FROG", "name": "Frog"}, "price_usd": 0.001,
         "liquidity_usd": 80000.0, "created_at": mc.ts(NOW) - 3 * 3600,
         "volume": {"m5": 9000.0, "h1": 24000.0, "h6": 90000.0, "h24": 200000.0},
         "txns": {"m5": {"buys": 60, "sells": 20}, "h1": {"buys": 300, "sells": 200}},
         "price_change": {"m5": 6.0, "h1": 12.0, "h6": 40.0, "h24": 80.0}}
    p.update(kw)
    return p


def cand(**kw):
    c = {"chain": "solana", "address": "MINT", "source": "test"}
    c.update(kw)
    return c


class Settings(TraderTestCase):
    def s(self, **kw):
        cfg = config.load_config()
        cfg["sniper"].update(kw)
        return sn().settings(cfg)


class Prefilter(Settings):
    NOW = NOW

    def test_the_cheap_reasons(self):
        s, now = self.s(), mc.ts(NOW)
        self.assertEqual(sn().prefilter(cand(), pair(), s, now), [])
        self.assertTrue(sn().prefilter(cand(), pair(base={"address": "x", "symbol": "USDC"}), s, now))
        self.assertIn("too young", sn().prefilter(cand(), pair(created_at=now - 120), s, now)[0])
        self.assertIn("liquidity", sn().prefilter(cand(), pair(liquidity_usd=9000.0), s, now)[0])
        washed = pair(volume={"m5": 0, "h1": 3e6, "h6": 0, "h24": 0})
        self.assertIn("wash", " ".join(sn().prefilter(cand(), washed, s, now)))
        bots = cand(pool={"txns": {"h1": {"buys": 900, "sells": 900, "buyers": 40, "sellers": 40}}})
        self.assertIn("bots", " ".join(sn().prefilter(bots, pair(), s, now)))

    def test_a_bonding_curve_is_judged_by_our_round_trip_not_its_pool(self):
        self.assertEqual(sn().prefilter(cand(), pair(dex="pumpfun", liquidity_usd=0.0), self.s(), mc.ts(NOW)), [])


class Safety(Settings):
    NOW = NOW

    def rug(self, checks, verdict="SAFE"):
        r = mock.Mock()
        r.check.return_value = {"checks": checks, "verdict": verdict, "reasons": [c.get("reason", c["name"]) for c in checks
                                                                                  if c.get("ok") is False],
                                "metrics": {}}
        return r

    def judge(self, checks, p=None, verdict="SAFE"):
        mod, st = sn(), self.s()  # both before skills.load is patched (it loads the sniper too)
        with mock.patch.object(mod.skills, "load", return_value=self.rug(checks, verdict)):
            self.n = getattr(self, "n", 0) + 1  # a token of its own each time: answers are cached per token
            return mod.safety(cand(address="T%d" % self.n), p or pair(), st, mc.ts(NOW))

    def test_a_critical_failure_or_no_answer_is_no(self):
        crit = {"name": "mint_authority", "ok": False, "severity": "critical", "penalty": 40}
        self.assertFalse(self.judge([crit], verdict="DANGER")["ok"])
        down = {"name": "safety_source", "ok": False, "severity": "high", "penalty": 20}
        self.assertFalse(self.judge([down], verdict="RISKY")["ok"])
        self.assertTrue(self.judge([{"name": "liquidity", "ok": True, "severity": "critical", "penalty": 0}])["ok"])

    def test_a_curve_has_no_lp_to_lock(self):
        lp = {"name": "lp_locked", "ok": False, "severity": "critical", "penalty": 30, "reason": "LP not locked"}
        self.assertFalse(self.judge([lp], verdict="DANGER")["ok"])
        self.assertTrue(self.judge([lp, {"name": "x", "ok": True}], p=pair(dex="pumpfun"), verdict="DANGER")["ok"])


class RoundTrip(Settings):
    def test_evm_pool_depth_and_fees(self):
        rt = sn().roundtrip(cand(chain="base"), pair(chain="base", dex="uniswap", liquidity_usd=20000.0), self.s())
        # $10 into $10k a side: 0.1 % impact each way, 0.3 % fee each way, $0.05 gas each way
        self.assertAlmostEqual(rt["loss_pct"], 2 * (0.1 + 0.3) + 100 * 2 * 0.05 / 10, places=2)

    def test_solana_asks_jupiter_both_ways_and_no_route_is_a_honeypot(self):
        quotes = iter([{"out_raw": 150_000_000, "price_impact_pct": 0, "route": []},       # 1 SOL = $150
                       {"out_raw": 5_000_000, "price_impact_pct": 0.4, "route": ["PumpSwap"]},  # buy
                       {"out_raw": 63_000_000, "price_impact_pct": 0.4, "route": ["PumpSwap"]}])  # sell back
        with mock.patch.object(sn().jupiter, "quote", side_effect=lambda *a, **k: next(quotes)):
            rt = sn().roundtrip(cand(), pair(), self.s())
        self.assertAlmostEqual(rt["loss_pct"], 5.5, places=1)  # $10 in, 0.063 SOL × 150 = $9.45 back
        with mock.patch.object(sn().jupiter, "quote", side_effect=http.SourceError("jupiter", "no route")):
            with self.assertRaises(http.SourceError):
                sn().roundtrip(cand(), pair(), self.s())


def bars(prices, vols=None, start=None):
    start = start if start is not None else mc.ts(NOW) - 300 * (len(prices) + 1)
    out = []
    for i, p in enumerate(prices):
        v = (vols or [100.0] * len(prices))[i]
        out.append(Candle(start + 300 * i, p, p * 1.01, p * 0.99, p, v))
    return out


class Strategies(Settings):
    NOW = NOW

    def test_momentum_fires_before_the_crowd_not_after(self):
        s, now = self.s(), mc.ts(NOW)
        sig = sn().signal(cand(), pair(), s, now, fetch_bars=lambda *a: [])
        self.assertEqual(sig["strategy"], "momentum")
        late = pair(price_change={"m5": 6.0, "h1": 450.0, "h6": 0, "h24": 0})
        self.assertNotEqual(sn().signal(cand(), late, s, now, fetch_bars=lambda *a: []).get("strategy"), "momentum")
        dumping = pair(txns={"m5": {"buys": 10, "sells": 40}, "h1": {"buys": 1, "sells": 1}})
        self.assertEqual(sn().signal(cand(), dumping, s, now, fetch_bars=lambda *a: []), {})

    def test_breakout_after_a_quiet_range(self):
        s, now = self.s(strategies={"momentum": False}), mc.ts(NOW)
        quiet = pair(volume={"m5": 0, "h1": 0, "h6": 0, "h24": 0})
        b = bars([1.0, 1.05] * 13 + [1.30], [100.0] * 26 + [400.0])
        sig = sn().signal(cand(), quiet, s, now, fetch_bars=lambda *a: b)
        self.assertEqual(sig["strategy"], "breakout")
        self.assertLessEqual(sig["stop_pct"], 25)

    def test_pullback_after_a_strong_run(self):
        s, now = self.s(strategies={"momentum": False, "breakout": False}), mc.ts(NOW)
        run = [1.0 + 0.1 * i for i in range(12)]          # 1.0 → 2.1
        dip = [2.1 - 0.08 * i for i in range(1, 12)]      # back to ~1.22 (≈ 42 % off the high)
        flat = [1.25] * 10
        b = bars(run + dip + flat + [1.6])
        sig = sn().signal(cand(), pair(volume={"m5": 0, "h1": 0, "h6": 0, "h24": 0}), s, now, fetch_bars=lambda *a: b)
        self.assertEqual(sig.get("strategy"), "pullback", sig)

    def test_graduation_is_off_unless_switched_on(self):
        pf = {"curve_progress": 0.95, "replies": 40, "banned": False}
        quiet = pair(volume={"m5": 0, "h1": 0, "h6": 0, "h24": 0}, created_at=mc.ts(NOW) - 3600)
        self.assertEqual(sn().signal(cand(pumpfun=pf), quiet, self.s(), mc.ts(NOW), fetch_bars=lambda *a: []), {})
        on = self.s(strategies={"graduation": True})
        self.assertEqual(sn().signal(cand(pumpfun=pf), quiet, on, mc.ts(NOW), fetch_bars=lambda *a: [])["strategy"],
                         "graduation")


class Budget(Settings):
    NOW = NOW

    def test_every_cap(self):
        s, now = self.s(), mc.ts(NOW)
        book = {"positions": {}, "days": {}, "traded": {}}
        self.assertEqual(sn().budget_refusal(book, s, now, "solana:A"), "")
        book["positions"] = {"solana:%d" % i: {"cost_usd": 10.0} for i in range(10)}
        self.assertIn("positions open", sn().budget_refusal(book, s, now, "solana:A"))
        book["positions"] = {"solana:%d" % i: {"cost_usd": 19.0} for i in range(5)}
        self.assertIn("cap is $100", sn().budget_refusal(book, s, now, "solana:A"))
        book = {"positions": {}, "days": {NOW[:10]: {"trades": 20, "pnl_usd": 0.0}}, "traded": {}}
        self.assertIn("trades today", sn().budget_refusal(book, s, now, "solana:A"))
        book = {"positions": {}, "days": {NOW[:10]: {"trades": 1, "pnl_usd": -31.0}}, "traded": {}}
        self.assertIn("lost", sn().budget_refusal(book, s, now, "solana:A"))
        book = {"positions": {}, "days": {}, "traded": {"solana:A": now - 3600}}
        self.assertIn("24 h", sn().budget_refusal(book, s, now, "solana:A"))


class Exits(Settings):
    NOW = NOW

    def position(self, **kw):
        p = {"chain": "base", "address": "TOK", "symbol": "TOK", "dex": "uniswap", "strategy": "momentum",
             "opened_at": NOW, "entry_price": 1.0, "cost_usd": 10.0, "stop_pct": 25.0, "peak_price": 1.0,
             "entry_liquidity": 100000.0, "mode": "paper", "price_unit": "usd", "tokens": 10.0, "url": ""}
        p.update(kw)
        return p

    def manage(self, pos, price, liq=100000.0, now=NOW, saf=None):
        book = {"positions": {"base:TOK": pos}, "days": {}, "traded": {}}
        md = {("base", "TOK"): pair(chain="base", dex="uniswap", price_usd=price, liquidity_usd=liq)}
        acts = []
        with mock.patch.object(sn(), "market_data", return_value=md), \
                mock.patch.object(sn(), "safety", return_value=saf or {"ok": True, "verdict": "SAFE", "reasons": []}):
            sn().manage(book, self.s(), config.load_config(), mc.ts(now), acts)
        return book, acts

    def trades(self):
        return state.read_jsonl("sniper/trades.jsonl")

    def test_stop(self):
        config.ensure_home()
        book, acts = self.manage(self.position(), 0.70)
        self.assertEqual(book["positions"], {})
        self.assertIn("stop", self.trades()[-1]["exit_reason"])

    def test_take_half_then_trail(self):
        config.ensure_home()
        book, acts = self.manage(self.position(), 1.60)
        pos = book["positions"]["base:TOK"]
        self.assertTrue(pos["sold_part"])
        self.assertAlmostEqual(pos["tokens"], 5.0)
        book, acts = self.manage(pos, 2.00)  # new high
        book, acts = self.manage(book["positions"]["base:TOK"], 1.45)  # 27.5 % under the high
        self.assertEqual(book["positions"], {})
        t = self.trades()[-1]
        self.assertIn("trailing", t["exit_reason"])
        self.assertGreater(t["pnl_usd"], 0)

    def test_liquidity_drained_or_turned_dangerous_sells_at_once(self):
        config.ensure_home()
        book, _ = self.manage(self.position(), 1.05, liq=40000.0)
        self.assertIn("liquidity drained", self.trades()[-1]["exit_reason"])
        rug = {"ok": False, "verdict": "DANGER", "reasons": ["RugCheck marks this token as already rugged"]}
        book, _ = self.manage(self.position(), 1.05, saf=rug)
        self.assertIn("dangerous", self.trades()[-1]["exit_reason"])

    def test_time_stop(self):
        config.ensure_home()
        book, _ = self.manage(self.position(opened_at="2026-10-22T03:00:00Z"), 1.02)
        self.assertIn("time stop", self.trades()[-1]["exit_reason"])


class Cycle(Settings):
    NOW = NOW

    def test_a_paper_trade_from_signal_to_book_and_log(self):
        config.ensure_home()
        cfg = config.load_config()
        p = pair()
        with mock.patch.object(sn(), "discover", return_value=[cand()]), \
                mock.patch.object(sn(), "market_data", return_value={("solana", "MINT"): p}), \
                mock.patch.object(sn(), "safety", return_value={"ok": True, "score": 90, "verdict": "SAFE",
                                                                  "reasons": []}), \
                mock.patch.object(sn(), "roundtrip", return_value={"loss_pct": 2.0, "tokens_raw": 10_000_000,
                                                                     "sol_usd": 150.0, "route": []}), \
                mock.patch.object(sn(), "x_mentions", return_value=3), \
                mock.patch.object(sn(), "track_outcomes", return_value=0):
            res = sn().cycle(cfg, mc.ts(NOW))
            again = sn().cycle(cfg, mc.ts(NOW) + 60)
        self.assertEqual(res["decisions"][0]["action"], "bought")
        self.assertEqual(res["mode"], "paper")
        pos = state.read_json("sniper/book.json")["positions"]["solana:MINT"]
        self.assertEqual((pos["mode"], pos["cost_usd"], pos["tokens_raw"]), ("paper", 10.0, 10_000_000))
        self.assertEqual(again["decisions"][0]["action"], "skipped")  # already holding it
        self.assertEqual(len(state.read_jsonl("sniper/candidates.jsonl")), 2)


class Live(Settings):
    def test_live_needs_every_step(self):
        config.ensure_home()
        cfg = config.load_config()
        self.assertFalse(sn().live_readiness(cfg)[0])
        cfg["sniper"].update(mode="live", live_confirmation=sn().LIVE_PHRASE)
        self.assertFalse(sn().live_readiness(cfg)[0])  # no wallet
        os.environ["SNIPER_SOL_SECRET"] = "x"
        try:
            self.assertTrue(sn().live_readiness(cfg)[0])
            cfg["sniper"]["live_confirmation"] = "i accept meme coin risk"  # not the exact words
            self.assertFalse(sn().live_readiness(cfg)[0])
            cfg["sniper"].update(live_confirmation=sn().LIVE_PHRASE, mode="paper")
            self.assertFalse(sn().live_readiness(cfg)[0])
        finally:
            os.environ.pop("SNIPER_SOL_SECRET", None)

    def test_paper_on_other_chains_even_when_live(self):
        self.assertEqual(sn().LIVE_CHAINS, ("solana",))


class Outcomes(Settings):
    NOW = NOW

    def test_every_judged_candidate_is_followed_for_a_day(self):
        config.ensure_home()
        state.append_jsonl("sniper/candidates.jsonl", {"at": "2026-10-22T08:00:00Z", "key": "solana:A", "price_usd": 1.0,
                                                        "action": "skipped", "reasons": ["safety: x"]})
        state.append_jsonl("sniper/candidates.jsonl", {"at": "2026-10-22T08:00:00Z", "key": "solana:B", "price_usd": 1.0,
                                                        "action": "bought", "strategy": "momentum"})
        md = {("solana", "A"): {"price_usd": 0.05}}  # B is gone: rugged
        with mock.patch.object(sn(), "market_data", return_value=md):
            n = sn().track_outcomes(mc.ts(NOW))
        self.assertEqual(n, 4)  # 15 min and 1 h for both
        rep = sn().report()
        rows = {g.split(" · ")[0]: r for g, r in rep["groups"].items()}
        self.assertEqual(rows["skipped"]["h1"]["median_pct"], -95.0)
        self.assertEqual(rows["bought"]["h1"]["rugged"], 1.0)


class XDiscovery(Settings):
    def test_addresses_in_fresh_posts_become_candidates(self):
        posts = [{"text": "new gem CA: 7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr pump.fun/coin/x", "followers": 1200},
                 {"text": "aping 7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr again", "followers": 300},
                 {"text": "four.meme launch 0x" + "ab" * 20, "followers": 10},
                 {"text": "no address here, just vibes", "followers": 5}]
        from shared.sources import x
        with mock.patch.object(x, "search_recent", return_value=posts):
            found = sn().x_discover(config.load_config())
        self.assertEqual(found[0], {"chain": "solana", "address": "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
                                    "x_posts": 2, "x_followers": 1500})
        self.assertEqual((found[1]["chain"], found[1]["address"]), ("bsc", "0x" + "ab" * 20))

    def test_no_x_token_no_x(self):
        from shared.sources import x
        with mock.patch.object(x, "search_recent", side_effect=x.XUnavailable("no token")):
            self.assertEqual(sn().x_discover(config.load_config()), [])


class BotWallet(Settings):
    def test_new_wallet_saves_the_key_privately_and_shows_only_the_address(self):
        from shared import secrets, solana
        config.ensure_home()
        code, out, err = self.run_tool("trader-sniper", "sniper", ["wallet", "new"])
        self.assertEqual(code, 0, err)
        path = config.trader_home() / "secrets.env"
        self.assertEqual(oct(os.stat(str(path)).st_mode & 0o777), "0o600")
        secret = secrets.get("SNIPER_SOL_SECRET")
        self.assertNotIn(secret, out + err)
        addr = solana.Keypair(secret).pubkey_b58
        self.assertIn(addr, out)
        self.assertEqual(len(solana.b58decode(addr)), 32)
        code, out, err = self.run_tool("trader-sniper", "sniper", ["wallet", "new"])
        self.assertNotEqual(code, 0)  # a funded wallet's key is never overwritten
        self.assertEqual(secrets.get("SNIPER_SOL_SECRET"), secret)


class LiveOrders(Settings):
    NOW = NOW

    def live_cfg(self):
        from shared import solana
        config.ensure_home()
        os.environ["SNIPER_SOL_SECRET"] = solana.b58encode(solana.new_keypair()[0])
        self.addCleanup(os.environ.pop, "SNIPER_SOL_SECRET", None)
        cfg = config.load_config()
        cfg["sniper"].update(mode="live", live_confirmation=sn().LIVE_PHRASE)
        return cfg

    def test_a_wallet_over_its_cap_buys_nothing(self):
        cfg = self.live_cfg()
        mod = sn()
        sent = []
        with mock.patch.object(mod, "_wallet_usd", return_value=500.0), \
                mock.patch.object(mod, "_swap", side_effect=lambda *a, **k: sent.append(a)):
            with self.assertRaises(RuntimeError) as cm:
                mod.buy(cand(), pair(), {"strategy": "momentum", "why": "x", "stop_pct": 25}, {"tokens_raw": 1,
                        "sol_usd": 150.0}, mod.settings(cfg), cfg, mc.ts(NOW))
        self.assertIn("cap", str(cm.exception))
        self.assertEqual(sent, [])

    def test_a_lost_answer_is_looked_up_never_sent_again(self):
        self.live_cfg()
        mod = sn()
        from shared import solana
        calls = []

        def boom(*a, **k):
            calls.append(1)
            raise solana.TransportError("timed out", signature="SIG1")
        rpc = mock.Mock()
        rpc.confirm.return_value = "confirmed"
        with mock.patch.object(solana, "swap", side_effect=boom), mock.patch.object(mod, "_rpc", return_value=rpc):
            res = mod._swap("A", "B", 100, 300, 1000)
        self.assertEqual((res["signature"], len(calls)), ("SIG1", 1))
        rpc.confirm.return_value = "timeout"
        with mock.patch.object(solana, "swap", side_effect=boom), mock.patch.object(mod, "_rpc", return_value=rpc):
            with self.assertRaises(RuntimeError):
                mod._swap("A", "B", 100, 300, 1000)

    def test_a_live_sale_never_sells_more_than_the_wallet_holds(self):
        cfg = self.live_cfg()
        mod = sn()
        rpc = mock.Mock()
        rpc.get_token_balance.return_value = (0.4, 400, 6)
        swaps = []
        pos = {"mode": "live", "address": "MINT", "tokens_raw": 1000, "symbol": "FROG"}
        with mock.patch.object(mod, "_rpc", return_value=rpc), \
                mock.patch.object(mod, "_swap", side_effect=lambda i, o, amt, *a: swaps.append(amt) or
                                  {"signature": "S", "status": "confirmed", "quote": {"outAmount": "1000000"}}), \
                mock.patch.object(mod, "sol_usd", return_value=150.0):
            mod.sell(pos, 0.5, "take profit", mod.settings(cfg), cfg, mc.ts(NOW), 20.0)
            mod.sell(pos, 1.0, "stop", mod.settings(cfg), cfg, mc.ts(NOW), 20.0)
        self.assertEqual(swaps, [400, 400])  # half of 1,000 would be 500 — the wallet holds 400
