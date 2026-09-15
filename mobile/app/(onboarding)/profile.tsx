import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/auth/AuthProvider';
import {
  USERNAME_MAX, USERNAME_RULE, checkUsername, isUsernameAvailable, sanitizeUsername,
  suggestUsername, updateProfile,
} from '@/api/profiles';
import { useImageCrop } from '@/components/ImageCrop';
import { pickImage, uploadAvatar } from '@/storage/uploads';
import { messageFor } from '@/lib/errors';
import { useSeed } from '@/hooks/useSeed';
import { Avatar, Button, Caption, Input, Notice } from '@/components/ui';
import { OnboardingShell } from '@/components/OnboardingShell';
import { colors, spacing } from '@/theme';

/** Step 1 of 3 — name, handle and a real profile photo. */
export default function OnboardingProfileScreen() {
  const { profile, refreshProfile } = useAuth();
  const { crop } = useImageCrop();

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);

  // Only fills blanks: whatever is already typed wins over what the server has.
  //
  // The handle is deliberately *not* seeded from the profile. The account is
  // created with one derived automatically, and pre-filling it makes it read as
  // settled — people kept the generated handle because it looked like a fact.
  // It starts empty, with a suggestion underneath, so picking one is a choice.
  useSeed(profile, (loaded) => {
    setDisplayName((current) => current || loaded.display_name || '');
    setBio((current) => current || loaded.bio || '');
    setAvatarUrl((current) => current || loaded.avatar_url);
  });

  // Only ever a placeholder. The handle is whatever they typed and nothing
  // else — falling back to a suggestion means the app picked their name for
  // them while looking as though it had asked.
  const suggestion = suggestUsername(displayName);
  const handle = username.trim();

  // Checked while typing, debounced, so the answer arrives before the save
  // rather than as a failure afterwards.
  const availability = useQuery({
    queryKey: ['username', handle],
    queryFn: () => checkUsername(handle),
    enabled: USERNAME_RULE.test(handle),
    staleTime: 30_000,
  });

  const taken = availability.data?.reason === 'TAKEN';

  const changePhoto = async () => {
    setError(null);
    try {
      const picked = await pickImage({ source: 'library', aspect: [1, 1] });
      if (!picked) return;

      const cropped = await crop({
        uri: picked.uri, size: [1024, 1024], circle: true, title: 'Orezať profilovku',
      });
      if (!cropped) return;

      setUploading(true);
      const url = await uploadAvatar(cropped);
      setAvatarUrl(url);
      await refreshProfile();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    setError(null);
    setUsernameError(null);

    if (displayName.trim().length < 2) {
      setError('Doplň meno, nech ťa ľudia spoznajú.');
      return;
    }

    if (handle.length === 0) {
      setUsernameError('Vyber si meno, pod ktorým ťa ľudia nájdu.');
      return;
    }
    if (!USERNAME_RULE.test(handle)) {
      setUsernameError('3–24 znakov: písmená, čísla, bodka alebo podčiarkovník.');
      return;
    }

    setSaving(true);
    try {
      const available = await isUsernameAvailable(handle);
      if (!available) {
        setUsernameError('Toto meno je už obsadené.');
        return;
      }

      await updateProfile({
        display_name: displayName.trim(),
        username: handle,
        bio: bio.trim() || null,
      });

      await refreshProfile();
      router.push('/(onboarding)/interests');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <OnboardingShell
      step={0}
      title="Kto si?"
      subtitle="Meno a fotka. Takto ťa uvidia ostatní, keď si niekam blupnete spolu."
      ctaLabel="Pokračovať"
      onCta={submit}
      ctaLoading={saving}
    >
      {error ? <Notice tone="danger" title="Niečo sa pokazilo" body={error} /> : null}

      <View style={styles.avatarSection}>
        <Pressable onPress={changePhoto} disabled={uploading} accessibilityRole="button">
          <Avatar url={avatarUrl} name={displayName} size={104} />
          {uploading ? (
            <View style={styles.avatarOverlay}>
              <ActivityIndicator color={colors.text} />
            </View>
          ) : null}
        </Pressable>
        <Button
          title={avatarUrl ? 'Zmeniť fotku' : 'Pridať fotku'}
          variant="ghost"
          compact
          onPress={changePhoto}
          disabled={uploading}
        />
        <Caption>Nahráva sa do tvojho storage bucketu, nezostáva len v telefóne.</Caption>
      </View>

      <Input
        label="Meno"
        value={displayName}
        onChangeText={setDisplayName}
        placeholder="Alex Kováč"
        autoCapitalize="words"
        editable={!saving}
      />

      <Input
        label="Tvoje @meno"
        value={username}
        onChangeText={(value) => { setUsernameError(null); setUsername(sanitizeUsername(value)); }}
        placeholder={suggestion || 'alex'}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={USERNAME_MAX}
        error={usernameError ?? (taken ? `@${handle} už niekto má. Skús iné.` : null)}
        hint={
          handle.length === 0
            ? 'Vyber si, ako ťa majú ľudia nájsť. Písmená, čísla, bodka a podčiarkovník.'
            : handle.length < 3
              ? 'Aspoň tri znaky. Písmená, čísla, bodka a podčiarkovník.'
              : !USERNAME_RULE.test(handle)
                ? 'Môžu tam byť iba písmená, čísla, bodka a podčiarkovník.'
                : availability.isLoading
                  ? `@${handle} — overujem…`
                  : availability.data?.ok
                    ? `@${handle} je voľné.`
                    : taken
                      ? 'Toto meno je obsadené.'
                      : 'Toto meno sa nedá použiť.'
        }
        editable={!saving}
      />

      <Input
        label="O tebe"
        value={bio}
        onChangeText={setBio}
        placeholder="Techno, lezenie a dlhé kávy."
        multiline
        numberOfLines={3}
        maxLength={300}
        style={styles.bio}
        hint={`${bio.length}/300`}
        editable={!saving}
      />

    </OnboardingShell>
  );
}

const styles = StyleSheet.create({
  intro: { color: colors.textTertiary, marginBottom: spacing.xl },
  avatarSection: { alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xl },
  avatarOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: 52,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bio: { height: 90, textAlignVertical: 'top', paddingTop: spacing.md },
});
