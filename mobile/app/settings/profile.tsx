import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';

import { useAuth } from '@/auth/AuthProvider';
import { isUsernameAvailable, updateProfile } from '@/api/profiles';
import { pickImage, removeAvatar, uploadAvatar } from '@/storage/uploads';
import { messageFor } from '@/lib/errors';
import { Avatar, Button, Caption, Input, Notice, Screen } from '@/components/ui';
import { colors, spacing } from '@/theme';

/** Edit profile — the photo really is uploaded to Storage and saved on the row. */
export default function EditProfileScreen() {
  const { profile, refreshProfile } = useAuth();

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [city, setCity] = useState('');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!profile) return;
    setDisplayName(profile.display_name ?? '');
    setUsername(profile.username ?? '');
    setBio(profile.bio ?? '');
    setCity(profile.city ?? '');
  }, [profile]);

  const changePhoto = async (source: 'library' | 'camera') => {
    setError(null);
    try {
      const picked = await pickImage({ source, aspect: [1, 1] });
      if (!picked) return;
      setUploading(true);
      await uploadAvatar(picked.uri);
      await refreshProfile();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setUploading(false);
    }
  };

  const deletePhoto = async () => {
    setError(null);
    setUploading(true);
    try {
      await removeAvatar();
      await refreshProfile();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const handle = username.trim().toLowerCase();

      if (handle !== profile?.username) {
        const available = await isUsernameAvailable(handle);
        if (!available) {
          setError('That username is taken.');
          return;
        }
      }

      await updateProfile({
        display_name: displayName.trim(),
        username: handle,
        bio: bio.trim() || null,
        city: city.trim() || null,
      });

      await refreshProfile();
      setSaved(true);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Could not save" body={error} /> : null}
      {saved ? <Notice tone="success" title="Saved" body="Your profile is updated." /> : null}

      <View style={styles.avatarSection}>
        <Pressable onPress={() => changePhoto('library')} disabled={uploading}>
          <Avatar url={profile?.avatar_url} name={displayName} size={104} />
          {uploading ? (
            <View style={styles.overlay}>
              <ActivityIndicator color={colors.text} />
            </View>
          ) : null}
        </Pressable>

        <View style={styles.photoActions}>
          <Button title="Choose" variant="ghost" compact onPress={() => changePhoto('library')} disabled={uploading} />
          <Button title="Camera" variant="ghost" compact onPress={() => changePhoto('camera')} disabled={uploading} />
          {profile?.avatar_url ? (
            <Button title="Remove" variant="ghost" compact onPress={deletePhoto} disabled={uploading} />
          ) : null}
        </View>
      </View>

      <Input label="Name" value={displayName} onChangeText={setDisplayName} editable={!saving} />
      <Input
        label="Username"
        value={username}
        onChangeText={(value) => setUsername(value.toLowerCase())}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!saving}
      />
      <Input
        label="Bio"
        value={bio}
        onChangeText={setBio}
        multiline
        numberOfLines={3}
        maxLength={300}
        style={styles.bio}
        hint={`${bio.length}/300`}
        editable={!saving}
      />
      <Input label="City" value={city} onChangeText={setCity} placeholder="Bratislava" editable={!saving} />

      <Button title="Save changes" onPress={save} loading={saving} />
      <Button title="Back" variant="ghost" onPress={() => router.back()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatarSection: { alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xl },
  overlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: 52,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoActions: { flexDirection: 'row', gap: spacing.sm },
  bio: { height: 90, textAlignVertical: 'top', paddingTop: spacing.md },
});
