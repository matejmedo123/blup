import { cn } from "@/lib/utils";

interface CheckerRuleProps {
  className?: string;
  /** veľkosť dlaždice, napr. "0.75rem" */
  size?: string;
}

/** Šachovnicové deliace pravítko — opakujúci sa motív brandu. */
export function CheckerRule({ className, size = "0.75rem" }: CheckerRuleProps) {
  return (
    <div
      aria-hidden
      className={cn("checkerboard w-full", className)}
      style={{ ["--checker-size" as string]: size, height: size }}
    />
  );
}
