import { cn } from "@/lib/cn";

/**
 * Crew Score ako prstenec — r=50, obvod ≈ 314.
 * Offset sa počíta z hodnoty, animácia beží raz pri načítaní.
 */
export function CrewScoreRing({
  score,
  size = 108,
  className,
}: {
  score: number;
  size?: number;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, score));
  const circumference = 314;
  const offset = circumference - (clamped / 100) * circumference;

  return (
    <div
      className={cn("relative shrink-0", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Crew Score ${clamped} zo 100`}
    >
      <svg viewBox="0 0 120 120" style={{ width: size, height: size, transform: "rotate(-90deg)" }} aria-hidden>
        <circle cx="60" cy="60" r="50" fill="none" stroke="#EDEDE8" strokeWidth="10" />
        <circle
          cx="60"
          cy="60"
          r="50"
          fill="none"
          stroke="#111111"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{
            animation: "crewRing .9s ease-out",
            ["--ring-offset" as string]: `${offset}`,
          }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="nums text-[30px] leading-none font-extrabold tracking-[-0.04em]">
          {clamped}
        </span>
        <span className="text-[11px] text-faint">/ 100</span>
      </div>
    </div>
  );
}
