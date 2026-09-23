-- ---------------------------------------------------------------------------
-- GIFy v chate.
--
-- The chat bucket accepted jpeg, png, webp and heic. A GIF uploaded into it was
-- rejected by storage itself, so there was nothing to fix in the app until this
-- line changed.
--
-- A GIF also has to survive the trip intact. Every other picture in this app is
-- re-encoded to JPEG on the way up, which is right for a 12 MP photo and fatal
-- for an animation — it arrives as a single still frame, and the person who
-- sent it has no way of knowing. The client-side upload path for GIFs skips the
-- re-encode entirely; this is the half of that which lives in the database.
--
-- The size limit stays where it was. An animation is far heavier per pixel than
-- a photo, so 10 MB is already generous, and a chat is not a file transfer.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not present – skipping chat gif mime update';
    return;
  end if;

  update storage.buckets
    set allowed_mime_types =
      array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/gif']
    where id = 'chat-media';
end
$$;
