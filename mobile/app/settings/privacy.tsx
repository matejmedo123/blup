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
      {error ? <Notice tone="danger" title="Nepodarilo sa uložiť" body={error} /> : null}

      <SectionHeader title="Viditeľnosť" />
      <Switch
        label="Súkromný profil"
        description="Tvoj profil a eventy uvidia len ľudia, ktorí ťa sledujú."
        value={isPrivate}
        onValueChange={(value) => {
          setIsPrivate(value);
          void update({ is_private: value });
        }}
      />
      <Switch
        label="Zobrazovať moje mesto"
        description="Tvoje presné súradnice sa nikomu nezobrazia — iba vzdialenosti."
        value={showLocation}
        onValueChange={(value) => {
          setShowLocation(value);
          void update({ show_location: value });
        }}
      />
      <Switch
        label="Povoliť správy"
        value={allowDm}
        onValueChange={(value) => {
          setAllowDm(value);
          void update({ allow_dm: value });
        }}
      />

      <SectionHeader title="Anonymný režim" />
      <Switch
        label={isPremium ? 'Prezerať anonymne' : 'Prezerať anonymne (Premium)'}
        description="Kým sa rozhliadaš, nebudeš v párovaní ľudí ani v zoznamoch účastníkov."
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
          title="Anonymný režim je Premium funkcia"
          body="Všetko ostatné na tejto stránke má každý."
        />
      ) : null}

      <SectionHeader title="Poloha" />
      <Body muted style={{ marginBottom: 12 }}>
        {location.status === 'granted'
          ? `Poloha je zapnutá${location.city ? ` (${location.city})` : ''}. BLUP si pamätá tvoju poslednú pozíciu, aby zoradil eventy podľa vzdialenosti.`
          : 'Poloha je vypnutá. Eventy sa nedajú zoradiť podľa vzdialenosti.'}
      </Body>
      <Button
        title={location.status === 'granted' ? 'Obnoviť moju pozíciu' : 'Zapnúť polohu'}
        variant="secondary"
        onPress={() => void location.request()}
      />
    </Screen>
  );
}
