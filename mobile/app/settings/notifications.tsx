import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  getNotificationPreferences, updateNotificationPreferences, type NotificationPreferences,
} from '@/api/notifications';
import { registerForPushNotifications } from '@/notifications/push';
import { messageFor } from '@/lib/errors';
import { Body, Button, LoadingState, Notice, Screen, Switch } from '@/components/ui';

export default function NotificationSettingsScreen() {
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pushNote, setPushNote] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: getNotificationPreferences,
  });

  useEffect(() => {
    if (query.data) setPreferences(query.data);
  }, [query.data]);

  const update = async (patch: Partial<NotificationPreferences>) => {
    setError(null);
    setPreferences((previous) => (previous ? { ...previous, ...patch } : previous));
    try {
      await updateNotificationPreferences(patch);
    } catch (caught) {
      setError(messageFor(caught));
      await query.refetch();
    }
  };

  const enablePush = async () => {
    const result = await registerForPushNotifications();
    setPushNote(result.ok ? 'Toto zariadenie je zaregistrované na push notifikácie.' : result.message);
  };

  if (query.isLoading || !preferences) return <Screen><LoadingState /></Screen>;

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Nepodarilo sa uložiť" body={error} /> : null}
      {pushNote ? <Notice tone="accent" title="Push" body={pushNote} /> : null}

      <Switch
        label="Push notifikácie"
        description="Hlavný vypínač pre tento účet."
        value={preferences.push_enabled}
        onValueChange={(value) => update({ push_enabled: value })}
      />
      <Switch
        label="Noví sledujúci"
        value={preferences.new_follower}
        onValueChange={(value) => update({ new_follower: value })}
      />
      <Switch
        label="Žiadosti o priateľstvo"
        value={preferences.friend_requests}
        onValueChange={(value) => update({ friend_requests: value })}
      />
      <Switch
        label="Pripomienky eventov"
        description="Dve hodiny pred tým, na čo ideš."
        value={preferences.event_reminders}
        onValueChange={(value) => update({ event_reminders: value })}
      />
      <Switch
        label="Ľudia, ktorých sleduješ, idú"
        value={preferences.friend_attending}
        onValueChange={(value) => update({ friend_attending: value })}
      />
      <Switch
        label="Vstupenky a výplaty"
        value={preferences.ticket_updates}
        onValueChange={(value) => update({ ticket_updates: value })}
      />
      <Switch
        label="Týždenné odporúčania"
        value={preferences.weekly_recommendations}
        onValueChange={(value) => update({ weekly_recommendations: value })}
      />

      <Body muted style={{ marginTop: 24, marginBottom: 12 }}>
        Nechodí ti nič? Zaregistruj toto zariadenie znova.
      </Body>
      <Button title="Zaregistrovať zariadenie" variant="secondary" onPress={enablePush} />
    </Screen>
  );
}
