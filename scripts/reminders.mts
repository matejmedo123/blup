/**
 * Spustí pripomienky mimo HTTP — pre systémový cron alebo ručné otestovanie.
 * Použitie: `npm run cron:reminders`
 */
process.env.CREW_SKIP_AUTO_MIGRATE ??= "false";

const { runReminders } = await import("../src/lib/domain/reminders");

const report = await runReminders();
console.log("✓ pripomienky spustené");
for (const [key, value] of Object.entries(report)) {
  console.log(`  ${key}: ${value}`);
}
process.exit(0);
