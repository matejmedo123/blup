import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/db/client";
import { conversationMembers, conversations, messages } from "@/db/schema";
import { ensureDirectConversation } from "@/lib/domain/applications";
import {
  conversationMessages,
  createBroadcast,
  ensureShiftConversation,
  markConversationRead,
  requireConversationMember,
  sendMessage,
} from "@/lib/domain/messaging";
import { portalConversations, unreadCounts } from "@/lib/domain/portal";
import { makeAssignment, makeShift, makeUser, makeMember, makeWorld } from "./factories";

describe("prístup ku konverzácii", () => {
  it("nečlen sa do konverzácie nedostane (Rule 8)", async () => {
    const { event, staff, admin } = await makeWorld();
    const conversationId = await ensureDirectConversation({
      eventId: event.id,
      userA: admin.id,
      userB: staff.id,
    });

    const outsider = await makeUser();
    await makeMember(outsider.id, event.id);

    await expect(requireConversationMember(conversationId, outsider.id)).rejects.toThrow(
      /nemáš prístup/i,
    );
  });

  it("člen konverzácie prístup má", async () => {
    const { event, staff, admin } = await makeWorld();
    const conversationId = await ensureDirectConversation({
      eventId: event.id,
      userA: admin.id,
      userB: staff.id,
    });

    const membership = await requireConversationMember(conversationId, staff.id);
    expect(membership.conversationId).toBe(conversationId);
    expect(membership.canWrite).toBe(true);
  });

  it("priama konverzácia sa nevytvorí dvakrát", async () => {
    const { event, staff, admin } = await makeWorld();
    const first = await ensureDirectConversation({
      eventId: event.id,
      userA: admin.id,
      userB: staff.id,
    });
    const second = await ensureDirectConversation({
      eventId: event.id,
      userA: staff.id,
      userB: admin.id,
    });
    expect(second).toBe(first);
  });
});

describe("chat k smene", () => {
  it("členmi sú pridelení ľudia a koordinátor", async () => {
    const db = await getDb();
    const { event, staff, coordinator, position } = await makeWorld();
    const shift = await makeShift(event.id, position.id, { coordinatorId: coordinator.id });
    await makeAssignment(shift.id, staff.id, event.id);

    const conversationId = await ensureShiftConversation(shift.id);
    expect(conversationId).toBeTruthy();

    const members = await db
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, conversationId!));

    const ids = members.map((m) => m.userId);
    expect(ids).toContain(staff.id);
    expect(ids).toContain(coordinator.id);
  });

  it("opakované volanie nevytvorí druhú konverzáciu", async () => {
    const db = await getDb();
    const { event, staff, coordinator, position } = await makeWorld();
    const shift = await makeShift(event.id, position.id, { coordinatorId: coordinator.id });
    await makeAssignment(shift.id, staff.id, event.id);

    const first = await ensureShiftConversation(shift.id);
    const second = await ensureShiftConversation(shift.id);
    expect(second).toBe(first);

    const rows = await db
      .select()
      .from(conversations)
      .where(eq(conversations.shiftId, shift.id));
    expect(rows).toHaveLength(1);
  });

  it("nový pridelený človek sa doplní medzi členov", async () => {
    const db = await getDb();
    const { event, staff, coordinator, position } = await makeWorld();
    const shift = await makeShift(event.id, position.id, { coordinatorId: coordinator.id });
    await makeAssignment(shift.id, staff.id, event.id);
    const conversationId = await ensureShiftConversation(shift.id);

    const newcomer = await makeUser();
    await makeMember(newcomer.id, event.id);
    await makeAssignment(shift.id, newcomer.id, event.id);
    await ensureShiftConversation(shift.id);

    const members = await db
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, conversationId!));
    expect(members.map((m) => m.userId)).toContain(newcomer.id);
  });

  it("nepridelený človek nie je členom chatu k smene", async () => {
    const { event, staff, coordinator, position } = await makeWorld();
    const shift = await makeShift(event.id, position.id, { coordinatorId: coordinator.id });
    await makeAssignment(shift.id, staff.id, event.id);
    const conversationId = await ensureShiftConversation(shift.id);

    const outsider = await makeUser();
    await makeMember(outsider.id, event.id);
    await expect(requireConversationMember(conversationId!, outsider.id)).rejects.toThrow();
  });
});

describe("správy", () => {
  it("odoslaná správa je v konverzácii a posunie čas poslednej správy", async () => {
    const db = await getDb();
    const { event, staff, admin } = await makeWorld();
    const conversationId = await ensureDirectConversation({
      eventId: event.id,
      userA: admin.id,
      userB: staff.id,
    });

    await sendMessage({
      conversationId,
      senderId: admin.id,
      body: "Príď prosím o 15 minút skôr.",
      eventId: event.id,
      senderName: "Admin",
    });

    const rows = await conversationMessages(conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toContain("15 minút");

    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(conversation.lastMessageAt).not.toBeNull();
  });

  it("príjemca vidí neprečítanú správu, odosielateľ nie", async () => {
    const { event, staff, admin } = await makeWorld();
    const conversationId = await ensureDirectConversation({
      eventId: event.id,
      userA: admin.id,
      userB: staff.id,
    });
    await sendMessage({
      conversationId,
      senderId: admin.id,
      body: "Ahoj",
      eventId: event.id,
    });

    expect((await unreadCounts(staff.id)).messages).toBe(1);
    expect((await unreadCounts(admin.id)).messages).toBe(0);
  });

  it("označenie prečítania vynuluje počítadlo", async () => {
    const { event, staff, admin } = await makeWorld();
    const conversationId = await ensureDirectConversation({
      eventId: event.id,
      userA: admin.id,
      userB: staff.id,
    });
    await sendMessage({ conversationId, senderId: admin.id, body: "Ahoj", eventId: event.id });

    await markConversationRead(conversationId, staff.id);
    expect((await unreadCounts(staff.id)).messages).toBe(0);
  });

  it("prehľad konverzácií nesie náhľad a počet neprečítaných", async () => {
    const { event, staff, admin } = await makeWorld();
    const conversationId = await ensureDirectConversation({
      eventId: event.id,
      userA: admin.id,
      userB: staff.id,
    });
    await sendMessage({
      conversationId,
      senderId: admin.id,
      body: "Zajtra o 17:45",
      eventId: event.id,
    });

    const rows = await portalConversations(staff.id, event.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].unread).toBe(1);
    expect(rows[0].preview?.body).toContain("17:45");
    expect(rows[0].memberCount).toBe(2);
  });
});

describe("hromadné správy", () => {
  it("príjemcovia nemôžu odpovedať, odosielateľ áno", async () => {
    const { event, staff, admin } = await makeWorld();
    const other = await makeUser();
    await makeMember(other.id, event.id);

    const result = await createBroadcast({
      eventId: event.id,
      createdBy: admin.id,
      title: "Zmena času",
      body: "Bar začína o hodinu skôr.",
      recipientIds: [staff.id, other.id],
      senderName: "Admin",
    });

    expect(result.recipients).toBe(2);

    const recipientMembership = await requireConversationMember(result.conversationId, staff.id);
    expect(recipientMembership.canWrite).toBe(false);

    const senderMembership = await requireConversationMember(result.conversationId, admin.id);
    expect(senderMembership.canWrite).toBe(true);
  });

  it("hromadná správa bez príjemcov zlyhá", async () => {
    const { event, admin } = await makeWorld();
    await expect(
      createBroadcast({
        eventId: event.id,
        createdBy: admin.id,
        title: "Nikomu",
        body: "…",
        recipientIds: [],
        senderName: "Admin",
      }),
    ).rejects.toThrow(/aspoň jedného/i);
  });

  it("telo hromadnej správy sa uloží ako prvá správa", async () => {
    const db = await getDb();
    const { event, staff, admin } = await makeWorld();
    const result = await createBroadcast({
      eventId: event.id,
      createdBy: admin.id,
      title: "Info",
      body: "Prosím všetci príďte 15 minút pred začiatkom.",
      recipientIds: [staff.id],
      senderName: "Admin",
    });

    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, result.conversationId));
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toContain("15 minút");
  });
});
