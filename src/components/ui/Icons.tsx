import type { SVGProps } from "react";

/** Jednotná sada 24×24 stroke ikon — bez externej knižnice. */
function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      width={20}
      height={20}
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconHome = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></Icon>
);
export const IconCalendar = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /></Icon>
);
export const IconMessage = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z" /></Icon>
);
export const IconBell = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" /><path d="M10.5 20a2 2 0 0 0 3 0" /></Icon>
);
export const IconUser = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><circle cx="12" cy="8" r="3.5" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></Icon>
);
export const IconUsers = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><circle cx="9" cy="8" r="3.2" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 5.2a3.2 3.2 0 0 1 0 6M17.5 14.2A6.5 6.5 0 0 1 21.5 20" /></Icon>
);
export const IconClock = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></Icon>
);
export const IconMapPin = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z" /><circle cx="12" cy="10" r="2.5" /></Icon>
);
export const IconEuro = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="M17.5 6.5A6.5 6.5 0 0 0 7 12a6.5 6.5 0 0 0 10.5 5.5" /><path d="M4 10.5h8M4 14h8" /></Icon>
);
export const IconChart = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Icon>
);
export const IconCheck = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="m4 12.5 5 5L20 6.5" /></Icon>
);
export const IconX = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="M6 6l12 12M18 6 6 18" /></Icon>
);
export const IconPlus = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="M12 5v14M5 12h14" /></Icon>
);
export const IconSearch = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>
);
export const IconFilter = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z" /></Icon>
);
export const IconMenu = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Icon>
);
export const IconChevronRight = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="m9 5 7 7-7 7" /></Icon>
);
export const IconChevronLeft = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="m15 5-7 7 7 7" /></Icon>
);
export const IconChevronDown = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="m5 9 7 7 7-7" /></Icon>
);
export const IconWarning = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="M12 3.5 22 20H2L12 3.5Z" /><path d="M12 10v4M12 17.2v.1" /></Icon>
);
export const IconQr = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 20h1" /></Icon>
);
export const IconLogout = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 8 6 12l4 4M6 12h11" /></Icon>
);
export const IconSettings = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2v2.5M12 19.5V22M4.2 4.2 6 6M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8" /></Icon>
);
export const IconClipboard = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1" /><path d="M9 10h6M9 14h4" /></Icon>
);
export const IconStar = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="m12 3.5 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 10l6.1-.9L12 3.5Z" /></Icon>
);
export const IconShield = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="M12 3 20 6v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6l8-3Z" /></Icon>
);
export const IconTruck = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z" /><circle cx="7" cy="18" r="1.8" /><circle cx="17.5" cy="18" r="1.8" /></Icon>
);
export const IconHeart = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="M12 20s-7-4.4-7-9.4A4.1 4.1 0 0 1 12 8a4.1 4.1 0 0 1 7 2.6c0 5-7 9.4-7 9.4Z" /></Icon>
);
export const IconDownload = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="M12 3v12M7.5 10.5 12 15l4.5-4.5" /><path d="M4 20h16" /></Icon>
);
export const IconAlert = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5M12 16.2v.1" /></Icon>
);
export const IconSend = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="m4 12 16-8-6 16-2.5-6.2L4 12Z" /></Icon>
);
export const IconEdit = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="M4 20h4l10-10-4-4L4 16v4Z" /><path d="m14 6 4 4" /></Icon>
);
export const IconTrash = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /></Icon>
);
export const IconLock = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><rect x="4.5" y="10" width="15" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></Icon>
);
export const IconSparkle = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="M12 3.5 13.6 9l5.4 1.6-5.4 1.6L12 17.6 10.4 12.2 5 10.6 10.4 9 12 3.5Z" /><path d="M18.5 16.5 19 18l1.5.5L19 19l-.5 1.5-.5-1.5L16.5 18l1.5-.5.5-1Z" /></Icon>
);
export const IconStore = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}><path d="M4 9h16v11H4z" /><path d="m3 9 1.5-5h15L21 9" /><path d="M9 20v-6h6v6" /></Icon>
);
