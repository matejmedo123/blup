export type AdminNavItem = {
  href: string;
  label: string;
  /** Kľúč sekcie pre kontrolu oprávnení (`visibleAdminSections`). */
  section: string;
  /** Presná zhoda URL — inak sa aktívnosť určuje prefixom. */
  exact?: boolean;
};

export type AdminNavGroup = {
  label: string;
  items: AdminNavItem[];
};

/** Sidebar admin rozhrania (§34). Položky sa filtrujú podľa oprávnení. */
export const ADMIN_NAV: AdminNavGroup[] = [
  {
    label: "Prehľad",
    items: [{ href: "/admin", label: "Dashboard", section: "dashboard", exact: true }],
  },
  {
    label: "Crew",
    items: [
      { href: "/admin/applicants", label: "Prihlášky", section: "applicants" },
      { href: "/admin/staff", label: "Crew", section: "staff" },
      { href: "/admin/volunteers", label: "Dobrovoľníci", section: "volunteers" },
      { href: "/admin/vendors", label: "Stánkari", section: "vendors" },
    ],
  },
  {
    label: "Plánovanie",
    items: [
      { href: "/admin/positions", label: "Pozície", section: "positions" },
      { href: "/admin/shifts", label: "Smeny", section: "shifts" },
      { href: "/admin/assignments", label: "Prideľovanie", section: "assignments" },
      { href: "/admin/calendar", label: "Kalendár", section: "calendar" },
    ],
  },
  {
    label: "Dochádzka",
    items: [
      { href: "/admin/attendance", label: "Live", section: "attendance", exact: true },
      { href: "/admin/attendance/corrections", label: "Korekcie", section: "corrections" },
    ],
  },
  {
    label: "Komunikácia",
    items: [
      { href: "/admin/messages", label: "Správy", section: "messages" },
      { href: "/admin/notifications", label: "Notifikácie", section: "notifications" },
    ],
  },
  {
    label: "Výkon",
    items: [
      { href: "/admin/ratings", label: "Hodnotenia", section: "ratings" },
      { href: "/admin/score", label: "Crew Score", section: "score" },
      { href: "/admin/incidents", label: "Incidenty", section: "incidents" },
    ],
  },
  {
    label: "Mzdy",
    items: [
      { href: "/admin/payroll", label: "Výplaty", section: "payroll", exact: true },
      { href: "/admin/exports", label: "Exporty", section: "exports" },
    ],
  },
  {
    label: "Nastavenia",
    items: [
      { href: "/admin/settings", label: "Event", section: "settings", exact: true },
      { href: "/admin/settings/users", label: "Používatelia", section: "settings" },
      { href: "/admin/settings/permissions", label: "Oprávnenia", section: "settings" },
      { href: "/admin/settings/audit", label: "Audit log", section: "settings" },
    ],
  },
];

export function isActive(pathname: string, item: AdminNavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
