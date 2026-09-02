import type { Metadata } from "next";
import { OrderConfirmation } from "@/components/order/OrderConfirmation";

export const metadata: Metadata = {
  title: "Objednávka prijatá",
  description: "Potvrdenie objednávky ENZO Smash Burgers & Pizza.",
  robots: { index: false, follow: false },
};

/**
 * Stránka je staticky vyexportovaná — číslo objednávky sa načíta
 * z adresy až na klientovi, aby fungoval `output: "export"`.
 */
export default function OrderPage() {
  return <OrderConfirmation />;
}
