import type { Metadata } from "next";
import { Suspense } from "react";
import { OrderConfirmation } from "@/components/order/OrderConfirmation";

export const metadata: Metadata = {
  title: "Objednávka prijatá",
  description: "Potvrdenie objednávky ENZO Smash Burgers & Fries.",
  robots: { index: false, follow: false },
};

export default async function OrderPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}) {
  const { c } = await searchParams;
  return (
    <Suspense fallback={null}>
      <OrderConfirmation orderNumber={c} />
    </Suspense>
  );
}
