import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite a node-postgres načítavajú natívne/WASM prostriedky za behu —
  // bundler ich musí nechať tak.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],

  // Statické assety a fonty sú immutable; bezpečnostné hlavičky platia globálne.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            // Geolokáciu potrebuje check-in, kameru QR skener — obe len na vlastnom pôvode.
            value: "geolocation=(self), camera=(self), microphone=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
