import { Hero } from "@/components/home/Hero";
import { MenuSection } from "@/components/menu/MenuSection";
import { BrandStory } from "@/components/home/BrandStory";
import { HowItWorks } from "@/components/home/HowItWorks";
import { PromoSection } from "@/components/home/PromoSection";
import { ContactSection } from "@/components/home/ContactSection";

export default function HomePage() {
  return (
    <>
      <Hero />
      <MenuSection />
      <BrandStory />
      <HowItWorks />
      <PromoSection />
      <ContactSection />
    </>
  );
}
