import { runReminders } from "@/lib/domain/reminders";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Hodinová úloha: 24 h potvrdenia, pripomienky check-in/out, označenie no-show.
 * Chránená tajomstvom `CRON_SECRET` — bez neho endpoint odmietne požiadavku.
 */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json(
      { ok: false, error: "CRON_SECRET nie je nastavené — endpoint je vypnutý." },
      { status: 503 },
    );
  }

  const header = request.headers.get("authorization");
  const url = new URL(request.url);
  const provided = header?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("secret");

  if (provided !== secret) {
    return Response.json({ ok: false, error: "Neplatné tajomstvo." }, { status: 401 });
  }

  try {
    const report = await runReminders();
    return Response.json({ ok: true, ...report });
  } catch (error) {
    console.error("cron/reminders zlyhal", error);
    return Response.json({ ok: false, error: "Úloha zlyhala." }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
