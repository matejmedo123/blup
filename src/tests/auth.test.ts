import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { hashToken, signShiftQr } from "@/lib/auth/tokens";
import {
  canAccessAdmin,
  canAccessPortal,
  can,
  visibleAdminSections,
  type Actor,
} from "@/lib/permissions";

const admin: Actor = { userId: "a", globalRole: "admin", eventRole: "admin", permissions: {} };
const coordinator: Actor = {
  userId: "c",
  globalRole: "staff",
  eventRole: "coordinator",
  permissions: { can_check_in_others: true, can_edit_attendance: true },
};
const staff: Actor = { userId: "s", globalRole: "staff", eventRole: "staff", permissions: {} };
const applicant: Actor = {
  userId: "p",
  globalRole: "applicant_volunteer",
  eventRole: null,
  permissions: {},
};

describe("heslá", () => {
  it("overí správne heslo a odmietne nesprávne", async () => {
    const hash = await hashPassword("Spravne-Heslo-123");
    expect(await verifyPassword("Spravne-Heslo-123", hash)).toBe(true);
    expect(await verifyPassword("Nespravne-Heslo-123", hash)).toBe(false);
  });

  it("nikdy neuloží heslo v čitateľnej podobe", async () => {
    const hash = await hashPassword("tajne-heslo-42");
    expect(hash).not.toContain("tajne-heslo-42");
    expect(hash.startsWith("scrypt$")).toBe(true);
  });

  it("dva hashe toho istého hesla sa líšia (náhodná soľ)", async () => {
    const a = await hashPassword("rovnake-heslo-1");
    const b = await hashPassword("rovnake-heslo-1");
    expect(a).not.toEqual(b);
  });

  it("odmietne poškodený alebo prázdny hash", async () => {
    expect(await verifyPassword("cokolvek", null)).toBe(false);
    expect(await verifyPassword("cokolvek", "nezmysel")).toBe(false);
  });
});

describe("tokeny", () => {
  it("hash tokenu je deterministický a nevratný", () => {
    expect(hashToken("abc")).toEqual(hashToken("abc"));
    expect(hashToken("abc")).not.toContain("abc");
  });

  it("QR podpis závisí od smeny aj tajomstva", () => {
    expect(signShiftQr("shift-1", "secret")).toEqual(signShiftQr("shift-1", "secret"));
    expect(signShiftQr("shift-1", "secret")).not.toEqual(signShiftQr("shift-2", "secret"));
    expect(signShiftQr("shift-1", "secret")).not.toEqual(signShiftQr("shift-1", "iny-secret"));
  });
});

describe("RBAC", () => {
  it("staff sa nedostane do adminu", () => {
    expect(canAccessAdmin(staff)).toBe(false);
  });

  it("uchádzač sa nedostane do portálu ani do adminu", () => {
    expect(canAccessPortal(applicant)).toBe(false);
    expect(canAccessAdmin(applicant)).toBe(false);
  });

  it("admin sa dostane všade", () => {
    expect(canAccessAdmin(admin)).toBe(true);
    expect(canAccessPortal(admin)).toBe(true);
    expect(can(admin, "can_view_payroll")).toBe(true);
  });

  it("koordinátor má len explicitne udelené práva", () => {
    expect(can(coordinator, "can_check_in_others")).toBe(true);
    expect(can(coordinator, "can_view_payroll")).toBe(false);
    expect(can(coordinator, "can_manage_shifts")).toBe(false);
  });

  it("koordinátor bez práv sa do adminu nedostane", () => {
    const powerless: Actor = { ...coordinator, permissions: {} };
    expect(canAccessAdmin(powerless)).toBe(false);
  });

  it("navigácia koordinátora neobsahuje mzdy ani nastavenia", () => {
    const sections = visibleAdminSections(coordinator);
    expect(sections.has("attendance")).toBe(true);
    expect(sections.has("payroll")).toBe(false);
    expect(sections.has("settings")).toBe(false);
    expect(sections.has("applicants")).toBe(false);
  });
});
