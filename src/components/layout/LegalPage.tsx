import Link from "next/link";
import { CheckerRule } from "@/components/ui/Checkerboard";

export function LegalPage({
  title,
  intro,
  sections,
}: {
  title: string;
  intro: string;
  sections: { heading: string; body: string[] }[];
}) {
  return (
    <>
      <div className="bg-burgundy text-cream">
        <div className="container-enzo py-12 lg:py-16">
          <Link
            href="/"
            className="link-underline text-[0.72rem] font-bold tracking-[0.16em] text-cream/60 uppercase"
          >
            ← Späť na úvod
          </Link>
          <h1 className="mt-4 max-w-3xl font-display text-[2.4rem] leading-[1.02] sm:text-[3.5rem]">
            {title}
          </h1>
          <p className="mt-4 max-w-2xl text-cream/70">{intro}</p>
        </div>
      </div>
      <CheckerRule className="text-burgundy" size="0.625rem" />

      <div className="container-enzo py-12 lg:py-20">
        <div className="max-w-3xl">
          <p className="mb-10 rounded-xl border border-gold/50 bg-gold/12 px-5 py-4 text-[0.88rem] text-ink/75">
            <strong>Pozn.:</strong> Toto je demo prototyp webu. Text je vzorový a
            neslúži ako záväzný právny dokument.
          </p>

          {sections.map((s) => (
            <section key={s.heading} className="mb-10">
              <h2 className="font-display text-[1.6rem] leading-[1.05] text-ink sm:text-[2rem]">
                {s.heading}
              </h2>
              {s.body.map((p, i) => (
                <p key={i} className="mt-4 text-[0.98rem] leading-relaxed text-ink/70">
                  {p}
                </p>
              ))}
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
