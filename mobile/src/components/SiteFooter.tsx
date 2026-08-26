import React from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getOperatorInfo } from '@/api/platform';
import { openCookieSettings } from '@/marketing/tags';
import { isConfigured } from '@/lib/env';
import { colors, spacing, typography } from '@/theme';

/**
 * The footer every website has and an app does not.
 *
 * BLUP is both, and on the web the things that live down here are not
 * decoration: the legal documents, the cookie choice, and who is actually
 * running the site. In the EU the last one is required, and it is the first
 * thing somebody looks for when they want to know who took their money.
 *
 * The operator's details come from `platform_settings` and **nothing is
 * invented**: a column that has not been filled in simply does not appear. An
 * empty Kontakt column is a prompt to go and fill it in, which a plausible
 * placeholder company would never be.
 *
 * Native gets nothing — a phone app has a settings screen, not a footer.
 */
export function SiteFooter() {
  const operator = useQuery({
    queryKey: ['platform', 'operator'],
    queryFn: getOperatorInfo,
    enabled: Platform.OS === 'web' && isConfigured.supabase,
    staleTime: 30 * 60_000,
  });

  if (Platform.OS !== 'web') return null;

  const info = operator.data;
  const year = new Date().getFullYear();
  const contactLines = [
    info?.name,
    info?.address,
    [info?.city, info?.country].filter(Boolean).join(' '),
    info?.registrationNo ? `IČO ${info.registrationNo}` : null,
    info?.vatNo ? `IČ DPH ${info.vatNo}` : null,
  ].filter((line): line is string => Boolean(line && line.trim()));

  return (
    <View style={styles.footer}>
      <View style={styles.columns}>
        <View style={styles.column}>
          <Text style={styles.brand}>
            Blup<Text style={styles.brandDot}>.</Text>
          </Text>
          <FooterLink label="Ochrana osobných údajov" onPress={() => router.push('/legal/privacy')} />
          <FooterLink label="Všeobecné obchodné podmienky" onPress={() => router.push('/legal/terms')} />
          <FooterLink label="Zásady cookies" onPress={() => router.push('/legal/cookies')} />
        </View>

        <View style={styles.column}>
          <Text style={styles.heading}>O nás</Text>
          {info?.email ? (
            <FooterLink
              label="Kontaktujte nás"
              onPress={() => void Linking.openURL(`mailto:${info.email}`)}
            />
          ) : null}
          <FooterLink label="Pre organizátorov" onPress={() => router.push('/organizer')} />
        </View>

        <View style={styles.column}>
          <Text style={styles.heading}>Váš účet</Text>
          <FooterLink label="Môj profil" onPress={() => router.push('/profile')} />
          {/* /settings/attending is "Idem na" — the events you said yes to.
              The tickets you actually bought live somewhere else. */}
          <FooterLink label="Moje vstupenky" onPress={() => router.push('/tickets')} />
          <FooterLink label="Idem na" onPress={() => router.push('/settings/attending')} />
          <FooterLink label="Aktualizovať nastavenia cookies" onPress={openCookieSettings} />
        </View>

        <View style={styles.column}>
          <Text style={styles.heading}>Kontakt</Text>
          {contactLines.length > 0 ? (
            contactLines.map((line) => (
              <Text key={line} style={styles.contact}>{line}</Text>
            ))
          ) : (
            <Text style={styles.contact}>
              Údaje prevádzkovateľa sa dopĺňajú v Admin → Poplatky a sadzby → Prevádzkovateľ.
            </Text>
          )}
          {info?.phone ? <Text style={styles.contact}>{info.phone}</Text> : null}
          {info?.email ? (
            <FooterLink
              label={info.email}
              onPress={() => void Linking.openURL(`mailto:${info.email}`)}
              accent
            />
          ) : null}
        </View>
      </View>

      <Text style={styles.payments}>Platby zabezpečuje Stripe · vstupenky doručujeme e-mailom</Text>

      <View style={styles.rule} />

      <Text style={styles.copyright}>
        © {year} {info?.name ? `${info.name} · ` : ''}blup.sk
      </Text>
    </View>
  );
}

function FooterLink({
  label, onPress, accent,
}: {
  label: string;
  onPress: () => void;
  accent?: boolean;
}) {
  return (
    <Pressable onPress={onPress} accessibilityRole="link" hitSlop={4}>
      {({ pressed }) => (
        <Text style={[styles.link, accent && styles.linkAccent, pressed && styles.linkPressed]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  footer: {
    // Pushed to the bottom: on a short page the footer used to sit right under
    // the content, halfway up the screen, which reads as the page having
    // ended early. `marginTop: auto` needs the scroll content to grow, which
    // Screen sets.
    marginTop: 'auto',
    paddingTop: spacing.huge,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.lg,
  },
  // Wraps to one column on a phone without a breakpoint of its own: the columns
  // have a minimum width and the row wraps when they stop fitting.
  columns: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xl,
  },
  column: { flexGrow: 1, flexBasis: 190, minWidth: 160, gap: spacing.sm },

  brand: { ...typography.subheading, color: colors.text, marginBottom: spacing.xs },
  brandDot: { color: colors.accent },
  heading: { ...typography.captionStrong, color: colors.text, marginBottom: spacing.xs },

  link: { ...typography.metaSm, color: colors.textSecondary },
  linkAccent: { color: colors.accentText },
  linkPressed: { color: colors.text },

  contact: { ...typography.metaSm, color: colors.textSecondary },

  payments: { ...typography.metaSm, color: colors.textTertiary, textAlign: 'center' },
  rule: { height: 1, backgroundColor: colors.border },
  copyright: {
    ...typography.metaSm,
    color: colors.textTertiary,
    textAlign: 'center',
    paddingBottom: spacing.lg,
  },
});
