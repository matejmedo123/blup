import { RESTAURANT } from "@/lib/config";
import { itemLineTotal, itemUnitPrice } from "@/lib/cart";
import { formatDateTime, formatPriceCompact } from "@/lib/format";
import { ORDER_TYPE_LABEL, PAYMENT_LABEL } from "@/lib/order";
import type { Order } from "@/lib/types";

/**
 * Tlačová účtenka. V prehliadači skrytá (.print-only), pri tlači je to
 * jediný viditeľný obsah stránky — formát 80 mm, monospace, bez farieb.
 */
export function PrintableReceipt({ order }: { order: Order }) {
  const c = order.customer;
  const address =
    order.orderType === "delivery"
      ? `${c.street ?? ""} ${c.houseNumber ?? ""}, ${c.postalCode ?? ""} ${c.city ?? ""}`
      : `${RESTAURANT.address.street}, ${RESTAURANT.address.city}`;

  return (
    <div
      className="print-only"
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: "11px",
        lineHeight: 1.5,
        color: "#000",
        maxWidth: "72mm",
        margin: "0 auto",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: "26px", fontWeight: 700, letterSpacing: "3px" }}>ENZO</div>
        <div style={{ fontSize: "9px", letterSpacing: "2px", marginTop: "2px" }}>
          SMASH BURGERS &amp; PIZZA
        </div>
        <div style={{ fontSize: "9px", marginTop: "6px" }}>
          {RESTAURANT.address.street}, {RESTAURANT.address.postalCode}{" "}
          {RESTAURANT.address.city}
        </div>
        <div style={{ fontSize: "9px" }}>{RESTAURANT.phone}</div>
        <div style={{ fontSize: "8px", marginTop: "4px" }}>
          {RESTAURANT.company.name} · IČO {RESTAURANT.company.ico} · DIČ{" "}
          {RESTAURANT.company.dic}
        </div>
      </div>

      <Divider />

      <Row label="OBJEDNÁVKA" value={`#${order.orderNumber}`} bold />
      <Row label="Dátum" value={formatDateTime(order.createdAt)} />
      <Row label="Typ" value={ORDER_TYPE_LABEL[order.orderType]} />
      <Row label="Platba" value={PAYMENT_LABEL[order.paymentMethod]} />
      <Row
        label="Stav platby"
        value={order.paymentState === "demo-paid" ? "Zaplatené (demo)" : "Platba pri prevzatí"}
      />

      <Divider />

      <div style={{ fontWeight: 700 }}>ZÁKAZNÍK</div>
      <div>
        {c.firstName} {c.lastName}
      </div>
      <div>{c.phone}</div>
      <div>{c.email}</div>
      <div style={{ marginTop: "3px" }}>
        {order.orderType === "delivery" ? "Doručiť na:" : "Odber na:"} {address}
      </div>
      {order.orderType === "pickup" && c.pickupTime && (
        <div>Čas odberu: {c.pickupTime}</div>
      )}
      {c.note && <div style={{ marginTop: "3px" }}>Pozn.: {c.note}</div>}

      <Divider />

      <div style={{ fontWeight: 700, marginBottom: "3px" }}>POLOŽKY</div>
      {order.items.map((item) => (
        <div key={item.key} style={{ marginBottom: "5px" }}>
          <Row
            label={`${item.name} ×${item.quantity}`}
            value={formatPriceCompact(itemLineTotal(item))}
          />
          <div style={{ fontSize: "9px", paddingLeft: "6px", color: "#333" }}>
            {formatPriceCompact(itemUnitPrice(item))} / ks
          </div>
          {item.extras.map((e) => (
            <div key={e.id} style={{ fontSize: "9px", paddingLeft: "6px" }}>
              + {e.name} ({formatPriceCompact(e.price)})
            </div>
          ))}
          {item.note && (
            <div style={{ fontSize: "9px", paddingLeft: "6px", fontStyle: "italic" }}>
              &bdquo;{item.note}&ldquo;
            </div>
          )}
        </div>
      ))}

      <Divider />

      <Row label="Medzisúčet" value={formatPriceCompact(order.subtotal)} />
      <Row
        label={order.orderType === "delivery" ? "Doručenie" : "Osobný odber"}
        value={order.deliveryFee === 0 ? "0.00 €" : formatPriceCompact(order.deliveryFee)}
      />

      <Divider />

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "15px",
          fontWeight: 700,
        }}
      >
        <span>CELKOM</span>
        <span>{formatPriceCompact(order.total)}</span>
      </div>

      <Divider />

      <div style={{ textAlign: "center", marginTop: "6px" }}>
        <div>Predpokladaný čas: {order.estimatedTime}</div>
        <div style={{ marginTop: "8px", fontWeight: 700 }}>ĎAKUJEME!</div>
        <div style={{ fontSize: "9px", letterSpacing: "1.5px", marginTop: "2px" }}>
          SMASHED FRESH. SERVED HOT.
        </div>
        <div style={{ fontSize: "9px", marginTop: "6px" }}>{RESTAURANT.claim}</div>
        <div style={{ fontSize: "8px", marginTop: "8px", color: "#444" }}>
          {RESTAURANT.company.name}, {RESTAURANT.company.seat}
          <br />
          Zodpovedný vedúci: {RESTAURANT.company.manager}
          <br />
          Doklad nie je daňovým dokladom.
        </div>
      </div>
    </div>
  );
}

function Divider() {
  return (
    <div
      aria-hidden
      style={{
        borderTop: "1px dashed #000",
        margin: "7px 0",
      }}
    />
  );
}

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: "8px",
        fontWeight: bold ? 700 : 400,
      }}
    >
      <span style={{ flex: 1, wordBreak: "break-word" }}>{label}</span>
      <span style={{ whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}
