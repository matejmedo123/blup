import React, { useEffect, useState } from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { updateProfile } from '@/api/profiles';
import { getPremiumStatus } from '@/api/premium';
import { useLocation } from '@/hooks/useLocation';
import { messageFor } from '@/lib/errors';
import { Body, Button, Notice, Screen, SectionHeader, Switch } from '@/components/ui';
import { useQuery } from '@tanstack/react-query';

export default function PrivacySettingsScreen() {
  const { profile, refreshProfile } = useAuth();
  const location = useLocation({ persist: false });
  const premium = useQuery({ queryKey: ['premium', 'status'], queryFn: getPremiumStatus });

  const [isPrivate, setIsPrivate] = useState(false);
  const [showLocation, setShowLocation] = useState(true);
  const [anonymousMode, setAnonymousMode] = useState(false);
  const [allowDm, setAllowDm] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profile) return;
    setIsPrivate(profile.is_private);
    setShowLocation(profile.show_location);
    setAnonymousMode(profile.anonymous_mode);
    setAllowDm(profile.allow_dm);
  }, [profile]);

  const update = async (patch: Parameters<typeof updateProfile>[0]) => {
    setError(null);
    try {
      await updateProfile(patch);
      await refreshProfile();
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  const isPremium = premium.data?.is_premium ?? false;

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Could not save" body={error} /> : null}

      <SectionHeader title="Visibility" />
      <Switch
        label="Private profile"
        description="Only people who follow you can see your profile and events."
        value={isPrivate}
        onValueChange={(value) => {
          setIsPrivate(value);
          void update({ is_private: value });
        }}
      />
      <Switch
        label="Show my city"
        description="Your exact coordinates are never shown to other users — only distances."
        value={showLocation}
        onValueChange={(value) => {
          setShowLocation(value);
          void update({ show_location: value });
        }}
      />
      <Switch
        label="Allow messages"
        value={allowDm}
        onValueChange={(value) => {
          setAllowDm(value);
          void update({ allow_dm: value });
        }}
      />

      <SectionHeader title="Anonymous mode" />
      <Switch
        label={isPremium ? 'Browse anonymously' : 'Browse anonymously (Premium)'}
        description="Keeps you out of people matching and attendee lists while you look around."
        value={anonymousMode}
        onValueChange={(value) => {
          if (!isPremium) return;
          setAnonymousMode(value);
          void update({ anonymous_mode: value });
        }}
      />
      {!isPremium ? (
        <Notice
          tone="accent"
          title="Anonymous mode is a Premium feature"
          body="Everything else on this page is available to everyone."
        />
      ) : null}

      <SectionHeader title="Location" />
      <Body muted style={{ marginBottom: 12 }}>
        {location.status === 'granted'
          ? `Location is on${location.city ? ` (${location.city})` : ''}. BLUP stores your last position to rank events by distance.`
          : 'Location is off. Events cannot be sorted by distance.'}
      </Body>
      <Button
        title={location.status === 'granted' ? 'Refresh my position' : 'Enable location'}
        variant="secondary"
        onPress={() => void location.request()}
      />
    </Screen>
  );
}
