import React, { useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import { getMarketingSettings, saveMarketingSettings } from '@/api/admin';
import { messageFor } from '@/lib/errors';
import {
  Body, Button, Caption, Divider, ErrorState, Input, LoadingState, Notice, Screen,
  SectionHeader, Switch,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Admin → Marketing.
 *
 * Meta and Google both want a snippet on the page. This screen asks for the
 * identifiers instead, and the web shell drops them into a fixed loader it
 * owns.
 *
 * That is a deliberate refusal, not a missing feature. A "paste your script
 * tag here" box is stored XSS with every visitor's session token behind it, and
 * the account that can write to that box is precisely the one an attacker wants.
 * With identifiers the worst a bad value can do is fail to load a pixel — the
 * format is checked here, and again by a CHECK constraint in the database.
 */
export default function AdminMarketingScreen() {
  const settings = useQuery({ queryKey: ['admin', 'marketing'], queryFn: getMarketingSettings });

  const [metaEnabled, setMetaEnabled] = useState(false);
  const [metaPixel, setMetaPixel] = useState('');
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [adsId, setAdsId] = useState('');
  const [adsLabel, setAdsLabel] = useState('');
  const [analyticsId, setAnalyticsId] = useState('');
  const [consent, setConsent] = useState(true);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const data = settings.data;
    if (!data) return;
    setMetaEnabled(data.meta_enabled);
    setMetaPixel(data.meta_pixel_id ?? '');
    setGoogleEnabled(data.google_enabled);
    setAdsId(data.google_ads_id ?? '');
    setAdsLabel(data.google_ads_purchase_label ?? '');
    setAnalyticsId(data.google_analytics_id ?? '');
    setConsent(data.consent_required);
  }, [settings.data]);

  if (settings.isLoading) return <Screen><LoadingState /></Screen>;

  if (settings.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(settings.error)} onRetry={() => void settings.refetch()} />
      </Screen>
    );
  }

  // The same shapes the database enforces, checked here so the person typing
  // finds out immediately rather than through a constraint violation.
  const metaValid = !metaPixel.trim() || /^[0-9]{8,20}$/.test(metaPixel.trim());
  const adsValid = !adsId.trim() || /^AW-[0-9]{6,15}$/.test(adsId.trim());
  const labelValid = !adsLabel.trim() || /^[A-Za-z0-9_-]{4,60}$/.test(adsLabel.trim());
  const analyticsValid = !analyticsId.trim() || /^G-[A-Z0-9]{6,15}$/.test(analyticsId.trim().toUpperCase());

  const problem = !metaValid
    ? 'Meta pixel je len číslo (8–20 číslic).'
    : !adsValid
      ? 'Google Ads ID vyzerá ako AW-123456789.'
      : !labelValid
        ? 'Konverzná menovka je krátky reťazec písmen, číslic, - a _.'
        : !analyticsValid
          ? 'Google Analytics ID vyzerá ako G-ABCD123456.'
          : metaEnabled && !metaPixel.trim()
            ? 'Zapol si Metu, ale nezadal pixel.'
            : googleEnabled && !adsId.trim() && !analyticsId.trim()
              ? 'Zapol si Google, ale nezadal ani Ads ID, ani Analytics ID.'
              : null;

  const save = async () => {
    setError(null);
    setSaved(false);
    if (problem) { setError(problem); return; }

    setSaving(true);
    try {
      await saveMarketingSettings({
        metaEnabled,
        metaPixelId: metaPixel.trim() || null,
        googleEnabled,
        googleAdsId: adsId.trim() || null,
        googleAdsLabel: adsLabel.trim() || null,
        googleAnalyticsId: analyticsId.trim().toUpperCase() || null,
        consentRequired: consent,
      });
      await settings.refetch();
      setSaved(true);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Toto ešte oprav" body={error} /> : null}
      {saved ? (
        <Notice
          tone="success"
          title="Uložené"
          body="Nové návštevy sa merajú od najbližšieho načítania stránky."
        />
      ) : null}

      <SectionHeader title="Meta (Facebook, Instagram)" />
      <Switch
        label="Merať cez Meta pixel"
        description="Zobrazenia, pridanie do košíka a nákup."
        value={metaEnabled}
        onValueChange={setMetaEnabled}
      />
      <Input
        label="Pixel ID"
        value={metaPixel}
        onChangeText={setMetaPixel}
        placeholder="1234567890123456"
        keyboardType="number-pad"
        autoCapitalize="none"
      />
      <Caption>
        Nájdeš ho v Meta Events Manager → Data sources. Je to len číslo, nie celý {'<script>'} blok.
      </Caption>

      <Divider />

      <SectionHeader title="Google (Ads, Analytics)" />
      <Switch
        label="Merať cez Google"
        description="Google Ads konverzie a/alebo GA4."
        value={googleEnabled}
        onValueChange={setGoogleEnabled}
      />
      <Input
        label="Google Ads ID"
        value={adsId}
        onChangeText={setAdsId}
        placeholder="AW-123456789"
        autoCapitalize="characters"
      />
      <Input
        label="Konverzná menovka pre nákup"
        value={adsLabel}
        onChangeText={setAdsLabel}
        placeholder="AbC-D_efG12hIJKlmn"
        autoCapitalize="none"
      />
      <Input
        label="Google Analytics 4 ID"
        value={analyticsId}
        onChangeText={setAnalyticsId}
        placeholder="G-ABCD123456"
        autoCapitalize="characters"
      />
      <Caption>
        Ads ID a menovku nájdeš v Google Ads → Tools → Conversions; GA4 ID v Admin → Data streams.
      </Caption>

      <Divider />

      <SectionHeader title="Súhlas" />
      <Switch
        label="Načítať až po súhlase"
        description="Kým návštevník nesúhlasí, nenačíta sa žiadny skript tretej strany."
        value={consent}
        onValueChange={setConsent}
      />
      <Body muted>
        Vypnutie je právne rozhodnutie prevádzkovateľa. V EÚ platí, že merací skript sa načíta až
        po súhlase — preto je zapnuté ako predvolené.
      </Body>

      <View style={styles.box}>
        <Text style={styles.boxTitle}>Prečo tu nie je políčko na vlastný kód</Text>
        <Body muted>
          Vložený {'<script>'} by bežal na tej istej doméne ako prihlásené relácie a vstupenky.
          Jeden zlý riadok — vlastný alebo z prilepenej šablóny — by vedel čítať tokeny všetkých
          návštevníkov. Preto sa tu zadáva iba identifikátor a zvyšok skladá BLUP.
        </Body>
      </View>

      <Button title="Uložiť" onPress={() => void save()} loading={saving} disabled={Boolean(problem)} />

      <Button
        title="Meta Events Manager"
        variant="ghost"
        onPress={() => void Linking.openURL('https://business.facebook.com/events_manager2')}
      />
      <Button
        title="Google Ads"
        variant="ghost"
        onPress={() => void Linking.openURL('https://ads.google.com')}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    padding: spacing.lg,
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  boxTitle: { ...typography.subheading, color: colors.text },
});
