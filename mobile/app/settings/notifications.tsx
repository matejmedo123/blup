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
    setPushNote(result.ok ? 'This device is registered for push notifications.' : result.message);
  };

  if (query.isLoading || !preferences) return <Screen><LoadingState /></Screen>;

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Could not save" body={error} /> : null}
      {pushNote ? <Notice tone="accent" title="Push" body={pushNote} /> : null}

      <Switch
        label="Push notifications"
        description="The master switch for this account."
        value={preferences.push_enabled}
        onValueChange={(value) => update({ push_enabled: value })}
      />
      <Switch
        label="New followers"
        value={preferences.new_follower}
        onValueChange={(value) => update({ new_follower: value })}
      />
      <Switch
        label="Friend requests"
        value={preferences.friend_requests}
        onValueChange={(value) => update({ friend_requests: value })}
      />
      <Switch
        label="Event reminders"
        description="Two hours before something you are going to."
        value={preferences.event_reminders}
        onValueChange={(value) => update({ event_reminders: value })}
      />
      <Switch
        label="People you follow are going"
        value={preferences.friend_attending}
        onValueChange={(value) => update({ friend_attending: value })}
      />
      <Switch
        label="Tickets and payouts"
        value={preferences.ticket_updates}
        onValueChange={(value) => update({ ticket_updates: value })}
      />
      <Switch
        label="Weekly recommendations"
        value={preferences.weekly_recommendations}
        onValueChange={(value) => update({ weekly_recommendations: value })}
      />

      <Body muted style={{ marginTop: 24, marginBottom: 12 }}>
        Not getting anything? Register this device again.
      </Body>
      <Button title="Register this device" variant="secondary" onPress={enablePush} />
    </Screen>
  );
}
