import type { Metadata } from "next";
import { Checkout } from "@/components/checkout/Checkout";

export const metadata: Metadata = {
  title: "Pokladňa",
  description:
    "Dokonči objednávku v ENZO — osobný odber alebo doručenie, platba kartou alebo v hotovosti.",
  robots: { index: false, follow: false },
};

export default function CheckoutPage() {
  return <Checkout />;
}
