import { PERMISSION_LABELS, type PermissionKey } from "@/lib/permissions";
import { WORK_TYPE_LABELS as WORK_TYPES_MAP } from "@/lib/labels";

export { EVENT_ROLE_LABELS } from "@/lib/labels";

/** Bezpečné zobrazenie neznámeho kľúča — DB môže obsahovať aj staršie hodnoty. */
export function PERMISSION_LABELS_SAFE(key: string): string {
  return PERMISSION_LABELS[key as PermissionKey] ?? key;
}

export function WORK_TYPE_LABELS(key: string): string {
  return WORK_TYPES_MAP[key as keyof typeof WORK_TYPES_MAP] ?? key;
}
