import type { ReactNode } from "react";

export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[760px] px-5 py-12 lg:py-20">
      <h1 className="text-[34px] leading-tight font-extrabold tracking-[-0.04em] lg:text-[44px]">
        {title}
      </h1>
      <p className="mt-3 text-[14px] text-faint">Aktualizované {updated}</p>
      <div className="mt-10 flex flex-col gap-8">{children}</div>
    </div>
  );
}

export function LegalSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-[22px] font-bold tracking-[-0.03em]">{heading}</h2>
      <div className="flex flex-col gap-3 text-[15px] leading-[1.7] text-body">{children}</div>
    </section>
  );
}
