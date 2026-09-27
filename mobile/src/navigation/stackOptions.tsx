import React from 'react';
import { Platform, Text } from 'react-native';

import { useLayout, contentMaxFor, SIDEBAR_WIDTH } from '@/hooks/useLayout';
import { colors, typography } from '@/theme';

/**
 * Spoločné nastavenia hlavičky navigátora.
 *
 * Jedno miesto, lebo predtým ich mali štyri súbory skopírované (koreň,
 * nastavenia, organizátor, admin) a rozišli sa: nadpis obrazovky sa na
 * monitore zarovnal s obsahom len v koreni, a v nastaveniach, u organizátora
 * a v admine zostal pri ľavom okraji. Tri obrazovky z piatich teda vyzerali
 * inak než zvyšok appky.
 *
 * Odsadenie nadpisu:
 *
 *   Hlavička ide cez celú šírku vedľa bočného menu, kým telo obrazovky sa drží
 *   v čitateľnom stĺpci uprostred. Na 1920 px z toho vyšlo, že „Nastavenia"
 *   stálo o 250 px vľavo od zoznamu, ku ktorému patrí — a vyzeralo to ako
 *   nadpis niečoho iného.
 *
 *   Natívny stack nepustí do `headerTitleStyle` nič okrem písma a
 *   `headerTitleContainerStyle` nepozná vôbec, takže odsadenie nesie vlastný
 *   nadpis. Len na webe — na telefóne je hlavička systémová a nemá sa čím
 *   posúvať.
 */
export function useStackScreenOptions() {
  const layout = useLayout();

  // Musí sedieť na SKUTOČNÚ šírku stĺpca, nie na jedno pevné číslo — stĺpec
  // rastie s oknom, a keby sa odsadenie rátalo z 1180, nadpis by na veľkom
  // monitore zase stál vedľa obsahu, len na druhú stranu.
  const gutter = layout.isDesktop
    ? Math.max(0, (layout.width - SIDEBAR_WIDTH - contentMaxFor(layout.width)) / 2)
    : 0;

  return {
    headerStyle: { backgroundColor: colors.background },
    headerTintColor: colors.text,
    headerTitleStyle: { fontWeight: '700' as const },
    headerShadowVisible: false,
    contentStyle: { backgroundColor: colors.background },
    ...(Platform.OS === 'web' && gutter
      ? {
          headerTitle: ({ children }: { children?: string }) => (
            <Text
              numberOfLines={1}
              style={{ ...typography.subheading, color: colors.text, marginLeft: gutter }}
            >
              {children}
            </Text>
          ),
        }
      : {}),
  };
}
