"""Trading desk: case file, memo parsing, cross-checks and hard gates for a GO."""
from __future__ import annotations

from tests.helpers import DEMOS, MEME_PASS, ROOT, TOKENS, TraderTestCase, load

ID = "TSLA-20261020-orb15"
PLAN = {"id": ID, "symbol": "TSLA", "asset": "stock", "setup": "orb15", "direction": "long",
        "entry": {"price": 364.18, "time": "2026-10-20T14:15:00Z"},
        "stop": {"price": 358.32, "method": "range_low", "note": ""}, "target": {"price": 375.90, "r_multiple": 2.0},
        "risk_per_unit": 5.86, "time_stop": {"at": "2026-10-20T19:55:00Z", "rule": "flat by 3:55 p.m. ET"},
        "horizon": {"end": "2026-10-20T20:00:00Z", "label": "rest of the session"}, "trailing": None,
        "scale_out": [], "liquidity_exit": None, "interval": "5m", "created_at": "2026-10-20T14:15:00Z"}
RESEARCH = "## Thesis\nORB with relvol 2.8 and a merger headline.\n## Evidence\n- setups.json: orb15 triggered 10:10"
SKEPTIC = ("O1 [critical] Earnings are tomorrow after the close — evidence: news.json 'Q3 earnings preview'\n"
           "O2 [major] Backtest expectancy is negative — evidence: backtests/TSLA-orb15.json\n"
           "O3 [minor] Volume faded after the breakout bar\n## Verdict\nI would pass.")


def tm(ev):
    return {"id": ID, "symbol": "TSLA", "asset": "stock", "entry": 364.18, "stop": 358.32, "target": 375.90,
            "probabilities": {"target": 0.4, "stop": 0.45, "neither": 0.15, "rug": 0.0},
            "expected_value": {"r": ev, "usd": ev * 100}}


class Desk(TraderTestCase):
    NOW = DEMOS["tsla"]["now"]

    def setUp(self):
        super().setUp()
        self.write_state("plan.json", {"plans": {ID: PLAN}, "latest": ID})
        self.write_state("timemachine/TSLA-20261020.json", tm(0.12))
        self.write_state("backtests/TSLA-orb15.json", {"summary": "Last 59 sessions: 33 triggers, 6 hit target, "
                                                                  "17 hit stop, 10 neither.", "triggers": 33,
                                                       "expectancy_r": -0.21})

    def record(self, role, text):
        code, out, err = self.run_tool("trader-desk", "desk", ["record", "--id", ID, "--role", role, "--text", text])
        self.assertEqual(code, 0, err)
        return out

    def verify(self):
        return self.run_json("trader-desk", "desk", ["verify", "--id", ID])

    def test_help(self):
        code, out, _ = self.run_tool("trader-desk", "desk", ["--help"])
        self.assertEqual(code, 0)
        self.assertIn("Skeptic", out)

    def test_brief_finds_the_idea_by_symbol(self):
        case = self.run_json("trader-desk", "desk", ["brief", "TSLA"])
        self.assertEqual(case["id"], ID)
        self.assertEqual(case["plan"]["stop"]["price"], 358.32)
        self.assertEqual(case["timemachine"]["expected_value"]["r"], 0.12)
        self.assertTrue(any(m["what"] == "no news checked" for m in case["missing"]))
        self.assertTrue((self.home / "desk" / ID / "case.json").exists())

    def test_go_verified_when_everything_is_answered(self):
        self.record("researcher", RESEARCH)
        self.record("skeptic", SKEPTIC)
        out = self.record("lead", "O1: mitigated — half size and flat before the close\nO2: rebutted — sample is "
                                  "regime-dependent; today has 2.8x relvol\nO3: accepted — noted\nDECISION: GO")
        self.assertIn("decision GO", out)
        res = self.verify()
        self.assertEqual(res["status"], "GO", res)
        self.assertEqual([o["response"] for o in res["objections"]], ["mitigated", "rebutted", "accepted"])
        self.assertTrue(any("ticket.py" in c for c in res["trader_next"]))
        self.assertTrue(any("yes" in c for c in res["trader_next"]))
        soft = {g["name"]: g for g in res["gates"]}["backtest expectancy"]
        self.assertFalse(soft["ok"])
        self.assertFalse(soft["hard"])  # the Lead may weigh it, it does not block by itself
        self.assertTrue((self.home / res["report"]).exists())

    def test_unanswered_objection_blocks_go(self):
        self.record("researcher", RESEARCH)
        self.record("skeptic", SKEPTIC)
        self.record("lead", "O1: rebutted — fine\nDECISION: GO")
        res = self.verify()
        self.assertEqual(res["status"], "BLOCKED")
        self.assertTrue(any("did not answer O2" in b for b in res["blockers"]))
        self.assertEqual(res["trader_next"], [])

    def test_accepted_critical_objection_blocks_go(self):
        self.record("researcher", RESEARCH)
        self.record("skeptic", SKEPTIC)
        self.record("lead", "O1: accepted\nO2: rebutted — x\nO3: accepted\nDECISION: GO")
        res = self.verify()
        self.assertEqual(res["status"], "BLOCKED")
        self.assertTrue(any("O1 is a critical objection" in b for b in res["blockers"]))

    def test_negative_time_machine_ev_is_a_hard_gate(self):
        self.write_state("timemachine/TSLA-20261020.json", tm(-0.3))
        self.record("researcher", RESEARCH)
        self.record("skeptic", SKEPTIC)
        self.record("lead", "O1: mitigated — a\nO2: rebutted — b\nO3: accepted — c\nDECISION: GO")
        res = self.verify()
        self.assertEqual(res["status"], "BLOCKED")
        self.assertTrue(any("Time Machine expected value" in b for b in res["blockers"]))

    def test_stale_replay_after_plan_change_blocks(self):
        self.write_state("plan.json", {"plans": {ID: dict(PLAN, stop={"price": 360.0, "method": "price"})}, "latest": ID})
        self.record("researcher", RESEARCH)
        self.record("skeptic", SKEPTIC)
        self.record("lead", "O1: mitigated — a\nO2: rebutted — b\nO3: accepted — c\nDECISION: GO")
        res = self.verify()
        self.assertEqual(res["status"], "BLOCKED")

    def test_no_go_and_incomplete(self):
        res = self.verify()
        self.assertEqual(res["status"], "INCOMPLETE")
        self.record("researcher", RESEARCH)
        self.record("skeptic", "Looks great to me.")
        self.record("lead", "DECISION: NO-GO")
        res = self.verify()
        self.assertEqual(res["status"], "NO-GO")
        self.assertTrue(any("raised no objections" in i for i in res["issues"]))
        self.assertEqual(res["trader_next"], [])

    def test_parsers_accept_markdown_variants(self):
        desk = load("trader-desk", "desk")
        obs = desk.parse_objections("- **O1** [Critical]: thin liquidity\n* O2 (minor) meh\nO1 [major] duplicate")
        self.assertEqual([(o["id"], o["severity"]) for o in obs], [("O1", "critical"), ("O2", "minor")])
        self.assertEqual(desk.parse_responses("**O1** — Rebutted: no\nO2 - mitigated"), {"O1": "rebutted", "O2": "mitigated"})
        self.assertEqual(desk.parse_decision("**DECISION:** No Go"), "NO-GO")
        self.assertIsNone(desk.parse_decision("we decided nothing"))

    def test_agents_exist_and_never_trade(self):
        for role in ("researcher", "skeptic", "lead"):
            text = (ROOT / "agents" / ("trader-%s.md" % role)).read_text(encoding="utf-8")
            self.assertTrue(text.startswith("---\nname: trader-%s\n" % role))
            self.assertIn("Never", text)
            self.assertIn("trader-broker", text)  # each one is told it may not run it


class DeskMeme(TraderTestCase):
    NOW = DEMOS["meme"]["now"]

    def test_meme_without_rugcheck_fails_hard_gate(self):
        mid = "solana-%s-20261020-momentum" % TOKENS["PUPKIN"]["address"]
        plan = dict(PLAN, id=mid, symbol=MEME_PASS, asset="meme", setup="momentum",
                    entry={"price": 0.004712, "time": "2026-10-20T15:55:00Z"},
                    stop={"price": 0.00429, "method": "range_low"}, target={"price": 0.005978, "r_multiple": 3.0})
        self.write_state("plan.json", {"plans": {mid: plan}, "latest": mid})
        case = self.run_json("trader-desk", "desk", ["verify", "--id", mid])
        gate = {g["name"]: g for g in case["gates"]}["rugcheck"]
        self.assertFalse(gate["ok"])
        self.assertTrue(gate["hard"])


def feed_item(iid, title, symbol="TSLA", asset="stock", source="Yahoo Finance", tags=(), published="2026-10-20T13:30:00Z",
              credibility=3, kind="news"):
    return {"id": iid, "symbol": symbol, "asset": asset, "source": source, "kind": kind, "author": None,
            "title": title, "url": "https://example.com/" + iid, "published": published, "tags": list(tags),
            "why": "", "importance": 3, "sentiment": None, "metrics": {}, "credibility": credibility}


class DeskNews(TraderTestCase):
    """news_feed.json → case["feed"] → Skeptic objections and the "news & filings" gate."""
    NOW = DEMOS["tsla"]["now"]

    def setUp(self):
        super().setUp()
        self.desk = load("trader-desk", "desk")
        self.write_state("plan.json", {"plans": {ID: PLAN}, "latest": ID})
        self.write_state("timemachine/TSLA-20261020.json", tm(0.02))
        self.write_state("backtests/TSLA-orb15.json", {"summary": "20 triggers", "triggers": 20, "expectancy_r": 0.3})

    def feed(self, items, refreshed=None):
        self.write_state("news_feed.json", {"updated_at": self.NOW, "items": items, "sources": {},
                                           "refreshed": refreshed if refreshed is not None
                                           else {"stock:TSLA": self.NOW, "crypto:BTC": self.NOW}})

    def review(self, cfg=None):
        from shared import config
        if cfg:
            self.write_state("config.json", cfg)
        c, lim = config.load_config(), config.load_limits()
        res = self.desk.auto_review(ID, c, lim, force=True)
        case = self.read_state("desk/%s/case.json" % ID)
        gate = [g for g in res["gates"] if g["name"] == "news & filings"][0]
        return res, case, gate

    def test_quiet_feed_goes(self):
        self.feed([feed_item("a", "Tesla shares edge higher in early trade")])
        res, case, gate = self.review()
        self.assertEqual(res["status"], "GO", res)
        self.assertEqual([f["id"] for f in case["feed"]], ["a"])
        self.assertTrue(gate["ok"])
        self.assertFalse(gate["hard"])
        self.assertIn("Tesla shares edge higher", self.desk.read_memo(ID, "researcher"))

    def test_offering_headline_is_critical(self):
        self.feed([feed_item("off", "Tesla announces $5 billion share offering", tags=["offering"]),
                   feed_item("chat", "TSLA offering?? dumping", source="StockTwits", tags=["offering"], credibility=1),
                   feed_item("old", "Tesla files for bankruptcy protection", tags=["bankruptcy"],
                             published="2026-10-18T13:00:00Z")])
        res, case, gate = self.review()
        self.assertEqual(res["status"], "NO-GO")
        crit = [o for o in res["objections"] if o["severity"] == "critical"]
        self.assertEqual(len(crit), 1, res["objections"])
        self.assertIn("share offering", crit[0]["text"])
        self.assertIn("Yahoo Finance", crit[0]["text"])
        self.assertIn("min ago", crit[0]["text"])
        self.assertNotIn("old", [f["id"] for f in case["feed"]])  # outside the 24 h lookback
        self.assertFalse(gate["ok"])
        self.assertIn("offering", gate["detail"])

    def test_sec_filing_merger_is_major_and_gate_can_be_turned_off(self):
        self.feed([feed_item("8k", "8-K filed: acquisition or disposal completed", source="SEC EDGAR", kind="filing",
                             tags=["8-K", "merger"], credibility=5)])
        res, _, gate = self.review()
        self.assertEqual(res["status"], "NO-GO")
        self.assertTrue(any(o["severity"] == "major" and "filing merger" in o["text"] for o in res["objections"]))
        res, _, gate = self.review({"autopilot": {"news_gate": {"enabled": False}}})
        self.assertEqual(res["status"], "GO")
        self.assertTrue(gate["ok"])
        self.assertIn("off", gate["detail"])

    def test_never_fetched_is_a_minor_note(self):
        self.feed([], refreshed={})
        res, _, gate = self.review()
        self.assertEqual(res["status"], "GO")
        self.assertTrue(any(o["severity"] == "minor" and "never fetched" in o["text"] for o in res["objections"]))
        self.assertFalse(gate["ok"])
        self.feed([])  # fetched, nothing found: quiet, not blind
        res, _, gate = self.review()
        self.assertFalse(any("never fetched" in o["text"] for o in res["objections"]))
        self.assertTrue(gate["ok"])

    def test_flagged_items_survive_the_cap(self):
        items = [feed_item("n%02d" % i, "Tesla headline number %d about cars" % i,
                           published="2026-10-20T14:%02d:00Z" % i) for i in range(1, 15)]
        items += [feed_item("x%02d" % i, "Another Tesla story %d on autos" % i, published="2026-10-20T13:%02d:00Z" % i)
                  for i in range(40, 50)]
        items.append(feed_item("off", "Tesla prices a convertible share offering", tags=["offering"],
                               published="2026-10-20T09:00:00Z"))
        self.feed(items)
        _, case, _ = self.review()
        ids = [f["id"] for f in case["feed"]]
        self.assertEqual(len(ids), 15)
        self.assertIn("off", ids)
        pubs = [f["published"] for f in case["feed"]]
        self.assertEqual(pubs, sorted(pubs, reverse=True))


class DeskNewsCrypto(TraderTestCase):
    NOW = DEMOS["btc"]["now"]

    def test_coin_hack_critical_market_hack_major(self):
        desk = load("trader-desk", "desk")
        from shared import config
        pid = "BTCUSDT-20261020-us_open_range"
        plan = dict(PLAN, id=pid, symbol="BTCUSDT", asset="crypto", setup="us_open_range",
                    entry={"price": 67462.0, "time": "2026-10-20T14:35:00Z"}, stop={"price": 67320.0, "method": "atr"},
                    target={"price": 67746.0, "r_multiple": 2.0}, risk_per_unit=142.0)
        self.write_state("plan.json", {"plans": {pid: plan}, "latest": pid})
        self.write_state("timemachine/BTCUSDT-20261020.json",
                         dict(tm(0.02), id=pid, symbol="BTCUSDT", stop=67320.0, target=67746.0))
        self.write_state("backtests/BTCUSDT-us_open_range.json", {"summary": "s", "triggers": 20, "expectancy_r": 0.3})
        items = [feed_item("mh", "Major exchange hacked, $200M drained", symbol="market", asset="crypto",
                           source="CoinDesk", tags=["hack"], published="2026-10-20T12:40:00Z"),
                 feed_item("old-mh", "Bridge exploit drains funds", symbol="market", asset="crypto", source="CoinDesk",
                           tags=["hack"], published="2026-10-20T04:00:00Z")]
        self.write_state("news_feed.json", {"items": items, "refreshed": {"crypto:BTC": self.NOW}})
        res = desk.auto_review(pid, config.load_config(), config.load_limits())
        case = self.read_state("desk/%s/case.json" % pid)
        self.assertEqual([f["id"] for f in case["feed"]], ["mh"])  # market items only count for 6 h
        majors = [o for o in res["objections"] if o["severity"] == "major"]
        self.assertTrue(any("market-wide hack" in o["text"] for o in majors), res["objections"])
        self.assertEqual(res["status"], "NO-GO")
        items.append(feed_item("ch", "Bitcoin network bug: nodes hacked in exploit", symbol="BTC", asset="crypto",
                               source="CoinDesk", tags=["hack"], published="2026-10-20T14:00:00Z"))
        self.write_state("news_feed.json", {"items": items, "refreshed": {"crypto:BTC": self.NOW}})
        res = desk.auto_review(pid, config.load_config(), config.load_limits())
        self.assertTrue(any(o["severity"] == "critical" and "Bitcoin network bug" in o["text"]
                            for o in res["objections"]))
