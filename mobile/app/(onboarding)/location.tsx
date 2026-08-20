import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';

import { useAuth } from '@/auth/AuthProvider';
import { useLocation } from '@/hooks/useLocation';
import { updateProfile } from '@/api/profiles';
import { registerForPushNotifications } from '@/notifications/push';
import { messageFor } from '@/lib/errors';
import { Body, Button, Caption, Notice } from '@/components/ui';
import { OnboardingShell } from '@/components/OnboardingShell';
import { colors, spacing } from '@/theme';

/** Step 3 of 3 — real GPS permission plus push, then into the app. */
export default function OnboardingLocationScreen() {
  const { refreshProfile } = useAuth();
  const location = useLocation({ persist: true });
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pushNote, setPushNote] = useState<string | null>(null);

  const finish = async () => {
    setError(null);
    setFinishing(true);
    try {
      // Push is optional — never block finishing onboarding on it.
      const push = await registerForPushNotifications();
      if (!push.ok && push.reason !== 'SIMULATOR') setPushNote(push.message);

      await updateProfile({ onboarding_completed: true });
      await refreshProfile();
      router.replace('/(tabs)');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setFinishing(false);
    }
  };

  return (
    <OnboardingShell
      step={2}
      title="Kde si?"
      subtitle="Podľa polohy ti zoradíme eventy podľa skutočnej vzdialenosti. S nikým sa nezdieľa, kým si to sám nezapneš."
      ctaLabel={location.status === 'granted' ? 'Blup in, hotovo' : 'Pokračovať bez polohy'}
      onCta={finish}
      ctaLoading={finishing}
    >

      {error ? <Notice tone="danger" title="Nepodarilo sa dokončiť" body={error} /> : null}
      {pushNote ? <Notice tone="warning" title="Notifikácie sú vypnuté" body={pushNote} /> : null}

      {location.status === 'granted' && location.coords ? (
        <Notice
          tone="success"
          title="Poloha zapnutá"
          body={
            location.city
              ? `Sme s tebou v meste ${location.city}. Vzdialenosti počítame odtiaľto.`
              : `Poloha zameraná (±${Math.round(location.accuracy ?? 0)} m).`
          }
        />
      ) : null}

      {location.status === 'denied' ? (
        <Notice
          tone="warning"
          title="Poloha je vypnutá"
          body="Prezerať a hľadať môžeš aj tak — eventy sa len nezoradia podľa vzdialenosti."
          actionLabel="Otvoriť nastavenia"
          onAction={location.openSettings}
        />
      ) : null}

      {location.status === 'services_disabled' ? (
        <Notice
          tone="warning"
          title="Lokalizačné služby sú vypnuté"
          body="Zapni lokalizačné služby v nastaveniach zariadenia, nech uvidíš, čo sa deje v okolí."
          actionLabel="Otvoriť nastavenia"
          onAction={location.openSettings}
        />
      ) : null}

      {location.status !== 'granted' ? (
        <View style={styles.actions}>
          <Button
            title="◎  Moja poloha"
            variant="secondary"
            onPress={() => void location.request()}
            loading={location.status === 'requesting'}
          />
        </View>
      ) : null}

      <Caption style={styles.footnote}>
        Kedykoľvek to zmeníš v Ja → Nastavenia → Súkromie.
      </Caption>
    </OnboardingShell>
  );
}

const styles = StyleSheet.create({
  step: { color: colors.textTertiary, marginBottom: spacing.sm },
  intro: { marginTop: spacing.md, marginBottom: spacing.xl },
  actions: { gap: spacing.md, marginTop: spacing.xl },
  footnote: { textAlign: 'center', marginTop: spacing.lg },
});
