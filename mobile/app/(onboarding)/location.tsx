import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';

import { useAuth } from '@/auth/AuthProvider';
import { useLocation } from '@/hooks/useLocation';
import { updateProfile } from '@/api/profiles';
import { registerForPushNotifications } from '@/notifications/push';
import { messageFor } from '@/lib/errors';
import { Body, Button, Caption, Notice, Screen, Title } from '@/components/ui';
import { spacing } from '@/theme';

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
    <Screen scroll>
      <Title>Show me what is around me</Title>
      <Body muted style={styles.intro}>
        Step 3 of 3 · BLUP uses your position to sort events by real distance and to draw you on the
        map. Nothing is shared with other users unless you turn on location sharing in settings.
      </Body>

      {error ? <Notice tone="danger" title="Could not finish" body={error} /> : null}
      {pushNote ? <Notice tone="warning" title="Notifications are off" body={pushNote} /> : null}

      {location.status === 'granted' && location.coords ? (
        <Notice
          tone="success"
          title="Location on"
          body={
            location.city
              ? `We have you in ${location.city}. Distances are live from here.`
              : `Position locked in (±${Math.round(location.accuracy ?? 0)} m).`
          }
        />
      ) : null}

      {location.status === 'denied' ? (
        <Notice
          tone="warning"
          title="Location is off"
          body="You can still browse and search — events just will not be sorted by distance."
          actionLabel="Open settings"
          onAction={location.openSettings}
        />
      ) : null}

      {location.status === 'services_disabled' ? (
        <Notice
          tone="warning"
          title="Location services are off"
          body="Turn on location services in your device settings to see what is happening nearby."
          actionLabel="Open settings"
          onAction={location.openSettings}
        />
      ) : null}

      <View style={styles.actions}>
        {location.status !== 'granted' ? (
          <Button
            title="Enable location"
            onPress={() => void location.request()}
            loading={location.status === 'requesting'}
          />
        ) : null}

        <Button
          title={location.status === 'granted' ? 'Start exploring' : 'Continue without location'}
          variant={location.status === 'granted' ? 'primary' : 'secondary'}
          onPress={finish}
          loading={finishing}
        />
      </View>

      <Caption style={styles.footnote}>
        You can change this any time in Profile → Settings → Privacy.
      </Caption>
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { marginTop: spacing.md, marginBottom: spacing.xl },
  actions: { gap: spacing.md, marginTop: spacing.xl },
  footnote: { textAlign: 'center', marginTop: spacing.lg },
});
