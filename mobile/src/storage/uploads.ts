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
/** A GIF cannot be compressed on the way up, so it gets its own, larger cap. */
const GIF_MAX_BYTES = 8 * 1024 * 1024;
/**
 * What a story video may weigh.
 *
 * This is a backstop, not the mechanism. Twenty-five megabytes used to be the
 * limit and it refused almost everything, because fifteen seconds off a phone
 * camera is twenty to thirty megabytes — 1080p60 at a high bitrate. Rejecting
 * that is answering the wrong question.
 *
 * The size is handled where it is created instead: a story shot in the app
 * records 720p and the recorder holds its own 12 MB ceiling, so a full fifteen
 * seconds lands at a few megabytes. This number only has to catch what comes
 * in by another route — a file picked from the library in a browser, where
 * nothing can transcode it — and it matches what the bucket accepts, so a file
 * that passes here is not rejected a second later by storage.
 */
const STORY_VIDEO_MAX_BYTES = 75 * 1024 * 1024;
export const STORY_VIDEO_SECONDS = 15;

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

/**
 * Picks a GIF out of the library.
 *
 * Separate from pickImage() because of `allowsEditing`. The crop UI hands back
 * a cropped *still*, which is the one thing a GIF must not become — so this
 * path never offers to edit, and it keeps whatever the picker returns.
 */
export async function pickGif(): Promise<PickedImage | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error('Prístup k fotkám je vypnutý. Zapni ho v Nastaveniach, ak chceš poslať GIF.');
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 1,
  });

  if (result.canceled || !result.assets?.[0]) return null;

  const asset = result.assets[0];
  const looksGif = (asset.mimeType ?? '').includes('gif')
    || (asset.fileName ?? '').toLowerCase().endsWith('.gif')
    || asset.uri.toLowerCase().includes('.gif');

  if (!looksGif) {
    throw new Error('Vyber GIF — toto je obyčajná fotka. Tá sa posiela cez ＋.');
  }

  return {
    uri: asset.uri,
    width: asset.width ?? 0,
    height: asset.height ?? 0,
    mimeType: 'image/gif',
  };
}

/**
 * Picks a story: a photo or a short video.
 *
 * `videoMaxDuration` and `videoQuality` are not suggestions the app checks
 * afterwards — the system picker enforces them and hands back a file it has
 * already re-encoded, using the phone's own hardware encoder. That is the
 * "prekonvertuje pri nahrávaní" part, and it is why a fifteen-second clip
 * arrives as a few megabytes instead of a few dozen.
 *
 * The web has no such picker: a browser returns the file untouched. So the
 * size is checked before the upload and a too-large file is refused with a
 * sentence that says what to do, rather than failing inside storage.
 */
export interface PickedStory extends PickedImage {
  kind: 'image' | 'video';
  /** Seconds. Only known for video, and only where the picker reports it. */
  duration?: number;
}

export async function pickStory(
  source: PickSource = 'library',
): Promise<PickedStory | null> {
  const permission =
    source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();

  if (!permission.granted) {
    throw new Error(
      source === 'camera'
        ? 'Prístup ku kamere je vypnutý. Zapni ho v Nastaveniach.'
        : 'Prístup k fotkám je vypnutý. Zapni ho v Nastaveniach.',
    );
  }

  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images', 'videos'],
    allowsEditing: false,
    quality: 0.9,
    // Fifteen seconds is what a story is. It also bounds what has to be stored
    // for the day it lives, which is the whole reason a cap exists.
    videoMaxDuration: STORY_VIDEO_SECONDS,
    videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
  };

  const result = source === 'camera'
    ? await ImagePicker.launchCameraAsync(options)
    : await ImagePicker.launchImageLibraryAsync(options);

  if (result.canceled || !result.assets?.[0]) return null;

  const asset = result.assets[0];
  const isVideo = asset.type === 'video'
    || (asset.mimeType ?? '').startsWith('video/');

  return {
    uri: asset.uri,
    width: asset.width ?? 0,
    height: asset.height ?? 0,
    mimeType: asset.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg'),
    kind: isVideo ? 'video' : 'image',
    duration: asset.duration ? asset.duration / 1000 : undefined,
  };
}

/**
 * A story video, uploaded as it came out of the picker.
 *
 * Deliberately no re-encode here. The picker already did one with the phone's
 * hardware encoder; doing a second pass in JavaScript would take minutes, heat
 * the device and make the file worse. What this does instead is refuse a file
 * that is too big *before* it is uploaded, so the failure is a sentence rather
 * than a rejected request from storage.
 */
export async function uploadStoryVideo(uri: string, mimeType?: string): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const response = await fetch(uri);
  const arrayBuffer = await response.arrayBuffer();

  if (arrayBuffer.byteLength > STORY_VIDEO_MAX_BYTES) {
    const mb = Math.round(arrayBuffer.byteLength / (1024 * 1024));
    throw new Error(
      `Toto video má ${mb} MB, a viac než 75 MB sa nahrať nedá. `
      + 'Natoč ho rovno v príbehu — vtedy sa nahráva rovno v menšej kvalite '
      + `a ${STORY_VIDEO_SECONDS} sekúnd vyjde na pár megabajtov.`,
    );
  }

  // The bucket accepts mp4, quicktime and webm; anything else is refused there
  // too, so guessing a type it does not know would only move the error.
  //
  // With no type given — which is the case for a clip the camera just recorded
  // — the extension is the only thing that knows: iOS writes .mov, Android
  // .mp4. Calling a QuickTime file mp4 makes storage reject it.
  const fromName = /\.mov($|\?)/i.test(uri) ? 'video/quicktime'
    : /\.webm($|\?)/i.test(uri) ? 'video/webm'
      : 'video/mp4';
  const type = (mimeType ?? '').startsWith('video/') ? mimeType! : fromName;
  const extension = type === 'video/quicktime' ? 'mov' : type === 'video/webm' ? 'webm' : 'mp4';

  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;

  const { error } = await supabase.storage
    .from('stories')
    .upload(path, arrayBuffer, { contentType: type, upsert: false });

  if (error) throw error;

  const { data } = supabase.storage.from('stories').getPublicUrl(path);
  return data.publicUrl;
}

/**
 * A story picture. Public bucket, path `<owner>/<id>.jpg` — a story is shown to
 * everybody who follows you, and signing one URL per viewer per story would be
 * a round trip each without making the picture any less reachable.
 */
export async function uploadStoryImage(uri: string, sourceWidth?: number): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const compressed = await compress(uri, 1440, sourceWidth);
  return uploadToBucket({
    bucket: 'stories',
    // Never overwritten: two stories posted in the same second are two stories.
    path: `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`,
    uri: compressed.uri,
  });
}

/**
 * Downscales and re-encodes so a 12 MP phone photo does not become a 6 MB
 * upload.
 *
 * `resize({ width })` sets the width, it does not cap it — handed a 900px
 * picture and a 1920 limit it *enlarges* it, which costs bytes and buys blur.
 * So when the source is already small enough, only the re-encode happens.
 */
async function compress(
  uri: string,
  maxWidth: number,
  sourceWidth?: number,
): Promise<{ uri: string; width: number; height: number }> {
  // Already cropped and encoded by the crop sheet, at exactly the size asked
  // for. Re-encoding it would only cost a second generation of JPEG artefacts.
  if (uri.startsWith('data:image/jpeg')) {
    return { uri, width: sourceWidth ?? maxWidth, height: 0 };
  }

  const context = ImageManipulator.ImageManipulator.manipulate(uri);
  if (!sourceWidth || sourceWidth > maxWidth) {
    context.resize({ width: maxWidth });
  }
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

/**
 * A chat wallpaper, which only its owner ever sees.
 *
 * Into the avatars bucket under the owner's own folder: the storage policy
 * derives ownership from that path, so this needs no new bucket and no new
 * policy — and a wallpaper is the same kind of thing as an avatar, a picture
 * you chose about yourself.
 */
export async function uploadChatWallpaper(uri: string): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  // 1080 wide is enough behind text on any phone, and keeps a photo from a
  // modern camera from becoming a two-megabyte download on every chat open.
  const compressed = await compress(uri, 1080);
  return uploadToBucket({
    bucket: 'avatars',
    path: `${userId}/chat-wallpaper.jpg`,
    uri: compressed.uri,
  });
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
export interface UploadedCover {
  url: string;
  width: number;
  height: number;
}

export async function uploadEventCover(
  uri: string,
  draftId: string,
  sourceWidth?: number,
): Promise<UploadedCover> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  // 1920×1080 by the time it gets here: the crop sheet fixes the shape, because
  // the card, the map pin and the link preview all assume it. A portrait photo
  // left alone either letterboxes the card or gets stretched across it.
  const compressed = await compress(uri, 1920, sourceWidth);
  const url = await uploadToBucket({
    bucket: 'event-images',
    path: `${userId}/${draftId}/cover.jpg`,
    uri: compressed.uri,
  });

  // A cropped cover is 16:9 by construction; `compress` cannot measure a data
  // URI, so the shape is stated rather than guessed at.
  const cropped = uri.startsWith('data:image/jpeg');
  return {
    url,
    width: cropped ? 1920 : compressed.width,
    height: cropped ? 1080 : compressed.height,
  };
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

/**
 * A GIF sent in a chat.
 *
 * Deliberately not uploadChatImage(). Every other picture in this app goes
 * through compress(), which re-encodes to JPEG — right for a 12 MP photo and
 * fatal here: a JPEG has one frame, so the animation arrives as a still and the
 * sender has no way of knowing. The bytes go up exactly as they came in.
 *
 * `source` is either a file the person picked from their library or an https
 * URL from the GIF picker. In both cases the bytes are fetched and stored in
 * this conversation's own private bucket: a message that points at somebody
 * else's CDN stops being a message the day that CDN changes its mind.
 */
export async function uploadChatGif(source: string, conversationId: string): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const response = await fetch(source);
  if (!response.ok) throw new Error('GIF sa nepodarilo načítať.');
  const arrayBuffer = await response.arrayBuffer();

  // A GIF is heavier per pixel than a photo and nothing here can shrink one, so
  // the limit is checked before the upload rather than left to storage to
  // reject with a message nobody can read.
  if (arrayBuffer.byteLength > GIF_MAX_BYTES) {
    throw new Error('Tento GIF je príliš veľký (max 8 MB).');
  }
  if (arrayBuffer.byteLength === 0) {
    throw new Error('GIF je prázdny.');
  }

  // GIF87a / GIF89a. Checked because the extension and the content-type are
  // both things a caller can get wrong, and the bucket will refuse anything
  // that is not really a GIF anyway — better to say so here.
  const header = new TextDecoder().decode(new Uint8Array(arrayBuffer.slice(0, 6)));
  if (!header.startsWith('GIF8')) {
    throw new Error('Tento súbor nie je GIF.');
  }

  const path = `${conversationId}/${userId}/${Date.now()}.gif`;

  const { error } = await supabase.storage
    .from('chat-media')
    .upload(path, arrayBuffer, { contentType: 'image/gif', upsert: false });

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

/**
 * A venue plan.
 *
 * Public, because a buyer picks a seat from it. Kept at 1600 rather than the
 * 600 a logo gets: this is a drawing people zoom into to read a row label, and
 * the sectors drawn on it are stored as fractions, so a legible plan and a
 * blurry one place them identically — only the reading suffers.
 *
 * Returns the URL along with the dimensions, which the sector coordinates are
 * relative to.
 */
export async function uploadVenuePlan(
  uri: string,
  organizationId: string,
): Promise<{ url: string; width: number; height: number }> {
  const compressed = await compress(uri, 1600);
  const url = await uploadToBucket({
    bucket: 'org-assets',
    path: `${organizationId}/plans/${Date.now()}.jpg`,
    uri: compressed.uri,
  });

  const size = await ImageManipulator.ImageManipulator.manipulate(compressed.uri)
    .renderAsync()
    .then((image) => ({ width: image.width, height: image.height }))
    .catch(() => ({ width: 1600, height: 1200 }));

  return { url, width: size.width, height: size.height };
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
