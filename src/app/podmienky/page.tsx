import type { Metadata } from "next";
import { LegalPage } from "@/components/layout/LegalPage";
import { ORDER_CONFIG, RESTAURANT } from "@/lib/config";
import { formatPrice } from "@/lib/format";

export const metadata: Metadata = {
  title: "Obchodné podmienky",
  description: "Obchodné podmienky objednávania v ENZO Smash Burgers & Pizza.",
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Obchodné podmienky"
      intro={`Podmienky objednávania jedla v ${RESTAURANT.legalName}.`}
      sections={[
        {
          heading: "1. Objednávka",
          body: [
            "Objednávku je možné vytvoriť prostredníctvom online formulára na tomto webe. Objednávka sa považuje za prijatú po jej odoslaní a zobrazení potvrdzovacej stránky s číslom objednávky.",
            `Minimálna hodnota objednávky je ${formatPrice(ORDER_CONFIG.minOrder)}. Ceny sú uvedené vrátane DPH.`,
          ],
        },
        {
          heading: "2. Doručenie a osobný odber",
          body: [
            `Poplatok za doručenie je ${formatPrice(ORDER_CONFIG.deliveryFee)}. Pri objednávke nad ${formatPrice(ORDER_CONFIG.freeDeliveryFrom)} je doručenie zdarma.`,
            `Doručujeme do obcí: ${RESTAURANT.deliveryZones.join(", ")}. Predpokladaný čas doručenia je ${ORDER_CONFIG.estimatedTimeDelivery}, osobný odber je pripravený za ${ORDER_CONFIG.estimatedTimePickup}.`,
          ],
        },
        {
          heading: "3. Platba",
          body: [
            "Objednávku je možné uhradiť platobnou kartou online alebo v hotovosti pri prevzatí. V tejto demo verzii nie je platobná brána napojená a žiadna reálna platba sa nespracuje.",
          ],
        },
        {
          heading: "4. Storno objednávky",
          body: [
            `Objednávku je možné zrušiť telefonicky na čísle ${RESTAURANT.phone}, pokiaľ ešte nebola odovzdaná do prípravy. Po začatí prípravy jedla už objednávku nie je možné stornovať.`,
          ],
        },
        {
          heading: "5. Reklamácie",
          body: [
            `Reklamácie prijímame telefonicky alebo e-mailom na ${RESTAURANT.email}, a to bez zbytočného odkladu po prevzatí objednávky.`,
          ],
        },
      ]}
    />
  );
}
