/** Jednotný tvar výsledku server action — používa ho `useActionState` vo formulároch. */
export type ActionResult<T = undefined> =
  | { ok: true; message?: string; data?: T }
  | { ok: false; message: string; fieldErrors?: Record<string, string[]> };

export const idle: ActionResult = { ok: true };

export function failure(message: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, message, fieldErrors };
}

export function success<T>(message?: string, data?: T): ActionResult<T> {
  return { ok: true, message, data };
}

/** Prevedie chybu server action na používateľsky zrozumiteľnú hlášku. */
export function toActionResult(error: unknown, fallback: string): ActionResult<never> {
  if (error instanceof Error) {
    if (error.name === "AuthorizationError") return failure(error.message);
    if (error.name === "DomainError") return failure(error.message);
  }
  console.error(error);
  return failure(fallback);
}

export class DomainError extends Error {
  fieldErrors?: Record<string, string[]>;
  constructor(message: string, fieldErrors?: Record<string, string[]>) {
    super(message);
    this.name = "DomainError";
    this.fieldErrors = fieldErrors;
  }
}
