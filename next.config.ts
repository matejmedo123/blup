import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Statický export — vygeneruje čisté HTML/CSS/JS do priečinka `out/`,
   * ktoré sa dá nahrať na obyčajný webhosting (Websupport) bez Node.js.
   */
  output: "export",

  /** Bez Node servera nefunguje optimalizátor obrázkov — obrázky sú
   *  už predpripravené vo WebP, takže optimalizáciu nepotrebujeme. */
  images: { unoptimized: true },

  /** Každá stránka dostane vlastný priečinok s index.html
   *  (/pokladna/index.html) — Apache ich servíruje bez konfigurácie. */
  trailingSlash: true,
};

export default nextConfig;
