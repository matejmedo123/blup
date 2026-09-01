import { describe, expect, it } from "vitest";

import {
  MAX_SCORE,
  MIN_SCORE,
  STARTING_SCORE,
  applyScoreRule,
  ensureScoreRules,
  getCrewScore,
  scoreHistory,
} from "@/lib/domain/score";
import { makeEvent, makeMember, makeUser } from "./factories";

async function scored() {
  const event = await makeEvent();
  const user = await makeUser();
  await makeMember(user.id, event.id);
  await ensureScoreRules(event.id);
  return { event, user };
}

describe("Crew Score", () => {
  it("nový človek začína na východiskovom skóre", async () => {
    const { event, user } = await scored();
    expect(await getCrewScore(user.id, event.id)).toBe(STARTING_SCORE);
  });

  it("príchod načas skóre zvýši", async () => {
    const { event, user } = await scored();
    const result = await applyScoreRule({
      userId: user.id,
      eventId: event.id,
      ruleKey: "on_time",
      reason: "Príchod načas",
    });
    expect(result?.delta).toBe(10);
    expect(await getCrewScore(user.id, event.id)).toBe(STARTING_SCORE + 10);
  });

  it("no-show skóre zníži", async () => {
    const { event, user } = await scored();
    await applyScoreRule({ userId: user.id, eventId: event.id, ruleKey: "no_show" });
    expect(await getCrewScore(user.id, event.id)).toBe(STARTING_SCORE - 20);
  });

  it("skóre sa nedostane nad maximum", async () => {
    const { event, user } = await scored();
    for (let i = 0; i < 10; i += 1) {
      await applyScoreRule({ userId: user.id, eventId: event.id, ruleKey: "on_time" });
    }
    expect(await getCrewScore(user.id, event.id)).toBe(MAX_SCORE);
  });

  it("skóre sa nedostane pod nulu", async () => {
    const { event, user } = await scored();
    for (let i = 0; i < 10; i += 1) {
      await applyScoreRule({ userId: user.id, eventId: event.id, ruleKey: "no_show" });
    }
    expect(await getCrewScore(user.id, event.id)).toBe(MIN_SCORE);
  });

  it("každá zmena má záznam v histórii", async () => {
    const { event, user } = await scored();
    await applyScoreRule({
      userId: user.id,
      eventId: event.id,
      ruleKey: "shift_confirmed",
      reason: "Potvrdená smena",
    });
    const history = await scoreHistory(user.id, event.id);
    expect(history).toHaveLength(1);
    expect(history[0].reason).toBe("Potvrdená smena");
    expect(history[0].delta).toBe(5);
  });

  it("pri clampe sa zaznamená skutočná zmena, nie nominálna", async () => {
    const { event, user } = await scored();
    // 70 → 100 je len +30, hoci pravidlo dáva +10 trikrát a štvrtýkrát už nič.
    for (let i = 0; i < 4; i += 1) {
      await applyScoreRule({ userId: user.id, eventId: event.id, ruleKey: "on_time" });
    }
    const history = await scoreHistory(user.id, event.id);
    const total = history.reduce((sum, row) => sum + row.delta, 0);
    expect(total).toBe(MAX_SCORE - STARTING_SCORE);
  });

  it("manuálna úprava prebije pravidlo", async () => {
    const { event, user } = await scored();
    const result = await applyScoreRule({
      userId: user.id,
      eventId: event.id,
      ruleKey: "manual_adjustment",
      overrideDelta: -7,
      reason: "Ručná korekcia",
    });
    expect(result?.delta).toBe(-7);
    expect(await getCrewScore(user.id, event.id)).toBe(STARTING_SCORE - 7);
  });

  it("neznáme pravidlo bez override nič nezmení", async () => {
    const { event, user } = await scored();
    const result = await applyScoreRule({
      userId: user.id,
      eventId: event.id,
      ruleKey: "neexistujuce_pravidlo",
    });
    expect(result).toBeNull();
    expect(await getCrewScore(user.id, event.id)).toBe(STARTING_SCORE);
  });
});
