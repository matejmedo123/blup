import type {
  IncidentCategory,
  NotificationType,
  PositionKey,
  VendorAssortment,
  VendorStandType,
  VolunteerPreference,
  WorkType,
} from "@/db/enums";

export const POSITION_KEY_LABELS: Record<PositionKey, string> = {
  bar: "Bar",
  helper: "Helper",
  runner: "Runner",
  cashier: "Pokladňa",
  security: "Security",
  cleaning: "Upratovanie",
  ticketing: "Vstupy",
  production: "Produkcia",
  stage: "Stage",
  hospitality: "Hospitality",
  registration: "Registrácia",
  other: "Iné",
};

export const WORK_TYPE_LABELS: Record<WorkType, string> = {
  bartender: "Barman / barmanka",
  waiter: "Čašník / čašníčka",
  helper: "Pomocné práce",
  security: "Security",
  runner: "Runner",
  ticketing: "Vstupy a ticketing",
  stagehand: "Stagehand",
  cashier: "Pokladňa",
  cleaning: "Upratovanie",
  production: "Produkcia",
  hospitality: "Hospitality",
  other: "Iné",
};

export const VOLUNTEER_PREFERENCE_LABELS: Record<VolunteerPreference, string> = {
  waste: "Odpad a čistota",
  orange_vests: "Oranžové vesty",
  security: "Bezpečnosť",
  guest_help: "Pomoc návštevníkom",
  backstage: "Backstage",
  build: "Stavba a búranie",
  other: "Iné",
};

export const VENDOR_STAND_TYPE_LABELS: Record<VendorStandType, string> = {
  food_truck: "Food truck",
  stand: "Stánok",
  tent: "Stan",
  trailer: "Príves",
  table: "Stôl",
  other: "Iné",
};

export const VENDOR_ASSORTMENT_LABELS: Record<VendorAssortment, string> = {
  food: "Jedlo",
  drinks: "Nápoje",
  crafts: "Remeslá",
  clothing: "Oblečenie",
  facepainting: "Facepainting",
  rides: "Kolotoče a atrakcie",
  tattoo: "Tetovanie",
  handmade: "Handmade",
  services: "Služby",
  other: "Iné",
};

export const INCIDENT_CATEGORY_LABELS: Record<IncidentCategory, string> = {
  no_show: "Neprišiel na smenu",
  late: "Meškanie",
  behaviour: "Správanie",
  safety: "Bezpečnosť",
  equipment: "Vybavenie",
  guest: "Návštevník",
  other: "Iné",
};

export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  shift_assigned: "Nová smena",
  shift_updated: "Zmena smeny",
  shift_cancelled: "Zrušená smena",
  shift_reminder: "Pripomienka smeny",
  shift_confirmation_required: "Potvrď smenu",
  message_received: "Nová správa",
  check_in_reminder: "Nezabudni na check-in",
  check_out_reminder: "Nezabudni na check-out",
  application_approved: "Prihláška schválená",
  application_rejected: "Prihláška zamietnutá",
  payout_updated: "Zmena výplaty",
  rating_received: "Nové hodnotenie",
};

export const CHECK_IN_METHOD_LABELS = {
  manual: "Manuálne (v appke)",
  qr: "QR kód",
  geofence: "GPS poloha",
  qr_geofence: "QR kód + GPS",
} as const;

export const EVENT_ROLE_LABELS = {
  admin: "Admin eventu",
  coordinator: "Koordinátor smien",
  staff: "Crew",
} as const;

export const GLOBAL_ROLE_LABELS = {
  admin: "Admin",
  staff: "Crew",
  applicant_volunteer: "Dobrovoľník",
  applicant_vendor: "Stánkar",
} as const;
