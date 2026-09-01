import { PublicFooter, PublicHeader } from "@/components/layout/PublicChrome";
import { getSession } from "@/lib/auth/session";
import { canAccessAdmin, canAccessPortal } from "@/lib/permissions";

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  const homeHref = session
    ? canAccessAdmin(session.actor)
      ? "/admin"
      : canAccessPortal(session.user)
        ? "/portal"
        : "/prihlaska/stav"
    : null;

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <PublicHeader homeHref={homeHref} />
      <main id="main" className="flex-1">
        {children}
      </main>
      <PublicFooter />
    </div>
  );
}
