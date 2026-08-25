import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';

/**
 * Image uploads: pick → downscale → upload to Supabase Storage → return the
 * public URL. The URL is then written to the database by the caller, so the
 * image is a real stored object, not a local file path that dies on reinstall.
 *
 * Storage paths are always `<owner-id>/<filename>` because the storage RLS
 * policies derive ownership from the first path segment.
 */

const MAX_BYTES = 5 * 1024 * 1024;

export type PickSource = 'library' | 'camera';

export interface PickedImage {
  uri: string;
  width: number;
  height: number;
  mimeType: string;
}

export async function pickImage(options: {
  source?: PickSource;
  aspect?: [number, number];
} = {}): Promise<PickedImage | null> {
  const source = options.source ?? 'library';

  const permission =
    source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();

  if (!permission.granted) {
    throw new Error(
      source === 'camera'
        ? 'Prístup ku kamere je vypnutý. Zapni ho v Nastaveniach, ak chceš fotiť.'
        : 'Prístup k fotkám je vypnutý. Zapni ho v Nastaveniach, ak chceš vybrať fotku.',
    );
  }

  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync({
          allowsEditing: true,
          aspect: options.aspect ?? [1, 1],
          quality: 0.9,
        })
      : await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsEditing: true,
          aspect: options.aspect ?? [1, 1],
          quality: 0.9,
        });

  if (result.canceled || !result.assets?.[0]) return null;

  const asset = result.assets[0];
  return {
    uri: asset.uri,
    width: asset.width ?? 0,
    height: asset.height ?? 0,
    mimeType: asset.mimeType ?? 'image/jpeg',
  };
}

/** Downscales and re-encodes so a 12 MP phone photo does not become a 6 MB upload. */
async function compress(uri: string, maxWidth: number): Promise<{ uri: string }> {
  const context = ImageManipulator.ImageManipulator.manipulate(uri);
  context.resize({ width: maxWidth });
  const image = await context.renderAsync();
  return image.saveAsync({ compress: 0.82, format: ImageManipulator.SaveFormat.JPEG });
}

async function uploadToBucket(params: {
  bucket: string;
  path: string;
  uri: string;
}): Promise<string> {
  // React Native's fetch gives us a Blob/ArrayBuffer for a file:// URI.
  const response = await fetch(params.uri);
  const arrayBuffer = await response.arrayBuffer();

  if (arrayBuffer.byteLength > MAX_BYTES) {
    throw new Error('Táto fotka je príliš veľká (max 5 MB po kompresii).');
  }

  const { error } = await supabase.storage
    .from(params.bucket)
    .upload(params.path, arrayBuffer, {
      contentType: 'image/jpeg',
      upsert: true,
      cacheControl: '3600',
    });

  if (error) throw error;

  const { data } = supabase.storage.from(params.bucket).getPublicUrl(params.path);
  // Cache-bust so a replaced avatar shows immediately.
  return `${data.publicUrl}?v=${Date.now()}`;
}

/** Uploads an avatar and writes the URL to the profile in one step. */
export async function uploadAvatar(uri: string): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const compressed = await compress(uri, 800);
  const url = await uploadToBucket({
    bucket: 'avatars',
    path: `${userId}/avatar.jpg`,
    uri: compressed.uri,
  });

  const { error } = await supabase.from('profiles').update({ avatar_url: url }).eq('id', userId);
  if (error) throw error;

  return url;
}

export async function removeAvatar(): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  await supabase.storage.from('avatars').remove([`${userId}/avatar.jpg`]);

  const { error } = await supabase.from('profiles').update({ avatar_url: null }).eq('id', userId);
  if (error) throw error;
}

/** Event cover: uploaded before the event exists, so it is keyed by a draft id. */
export async function uploadEventCover(uri: string, draftId: string): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  // 1920 wide, which at the picker's 16:9 crop is 1920×1080 — the size the
  // card, the detail hero and the link-preview crawler all want, and small
  // enough that a phone on mobile data still loads the feed.
  const compressed = await compress(uri, 1920);
  return uploadToBucket({
    bucket: 'event-images',
    path: `${userId}/${draftId}/cover.jpg`,
    uri: compressed.uri,
  });
}

/** Adds a photo to an event gallery and records the row. */
export async function uploadEventGalleryImage(uri: string, eventId: string): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const compressed = await compress(uri, 1600);
  const filename = `${Date.now()}.jpg`;
  const path = `${userId}/${eventId}/${filename}`;

  const url = await uploadToBucket({ bucket: 'event-images', path, uri: compressed.uri });

  const { data: existing } = await supabase
    .from('event_images')
    .select('sort_order')
    .eq('event_id', eventId)
    .order('sort_order', { ascending: false })
    .limit(1);

  const { error } = await supabase.from('event_images').insert({
    event_id: eventId,
    url,
    storage_path: path,
    sort_order: (existing?.[0]?.sort_order ?? -1) + 1,
  });

  if (error) throw error;
  return url;
}

export async function deleteEventGalleryImage(imageId: string): Promise<void> {
  const { data: image } = await supabase
    .from('event_images')
    .select('storage_path')
    .eq('id', imageId)
    .maybeSingle();

  if (image?.storage_path) {
    await supabase.storage.from('event-images').remove([image.storage_path]);
  }

  const { error } = await supabase.from('event_images').delete().eq('id', imageId);
  if (error) throw error;
}

/**
 * A photo sent in a chat.
 *
 * Goes to the PRIVATE `chat-media` bucket — a picture in a private thread must
 * not be readable by URL alone. What is stored on the message is the object
 * path; the app turns it into a short-lived signed URL when it renders it.
 */
export async function uploadChatImage(uri: string, conversationId: string): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const compressed = await compress(uri, 1400);

  const response = await fetch(compressed.uri);
  const arrayBuffer = await response.arrayBuffer();

  if (arrayBuffer.byteLength > MAX_BYTES) {
    throw new Error('Fotka je príliš veľká (max 5 MB po kompresii).');
  }

  const path = `${conversationId}/${userId}/${Date.now()}.jpg`;

  const { error } = await supabase.storage
    .from('chat-media')
    .upload(path, arrayBuffer, { contentType: 'image/jpeg', upsert: false });

  if (error) throw error;
  return path;
}

/** Signs a chat attachment path for viewing. Valid for an hour. */
export async function signChatImage(path: string): Promise<string | null> {
  // Older messages may already hold a full URL; leave those alone.
  if (/^https?:\/\//.test(path)) return path;

  const { data, error } = await supabase.storage
    .from('chat-media')
    .createSignedUrl(path, 3600);

  if (error) return null;
  return data?.signedUrl ?? null;
}

/** A photo attached to a community post. Public bucket — the feed is public. */
export async function uploadCommunityImage(uri: string, communityId: string): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const compressed = await compress(uri, 1400);
  return uploadToBucket({
    bucket: 'event-images',
    path: `${userId}/community/${communityId}/${Date.now()}.jpg`,
    uri: compressed.uri,
  });
}

export async function uploadOrganizationLogo(uri: string, organizationId: string): Promise<string> {
  const compressed = await compress(uri, 600);
  return uploadToBucket({
    bucket: 'org-assets',
    path: `${organizationId}/logo.jpg`,
    uri: compressed.uri,
  });
}

/** Verification documents go to a PRIVATE bucket; only the org and admins can read them. */
export async function uploadVerificationDocument(
  uri: string,
  organizationId: string,
  kind: string,
): Promise<{ path: string; kind: string }> {
  const response = await fetch(uri);
  const arrayBuffer = await response.arrayBuffer();
  const path = `${organizationId}/${kind}-${Date.now()}.jpg`;

  const { error } = await supabase.storage
    .from('verification-docs')
    .upload(path, arrayBuffer, {
      contentType: Platform.OS === 'web' ? 'application/octet-stream' : 'image/jpeg',
      upsert: false,
    });

  if (error) throw error;
  return { path, kind };
}
