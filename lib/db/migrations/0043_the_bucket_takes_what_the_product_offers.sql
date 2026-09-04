-- The bucket accepted four types while the product offered sixteen.
--
-- `lib/api-zod/src/limits.ts` declares `UPLOAD_CONTENT_TYPES` and says, in the
-- comment above it: "Changing this list means changing the bucket in the same
-- breath." The list has been widened twice since 0004 and the bucket has not
-- been touched by a migration since — so an empty Postgres plus every file in
-- this directory, which is the property this whole directory exists to
-- establish, produced a bucket that refused twelve of the sixteen.
--
-- Nothing failed on our side, and that is the point. The API checks the
-- filename, decides the type, signs the ticket and writes its log line; the
-- refusal then arrives as a 400 from Storage direct to the browser, on a
-- request no server of ours ever sees. A PNG logo, an MP3 bed, a WebP, an MKV
-- and every uploaded font were refused at the moment somebody pressed the
-- button — and `addMusic` and `overlayImage`, both built and both tested,
-- could not be handed a file at all.
--
-- Production had been widened by hand at some point, which made this worse
-- rather than better: the database the migrations build and the database the
-- customers use disagreed, silently, and every check that runs against a fresh
-- one was testing a narrower product than the deployed one.
--
-- `tools/upload-types-test.mjs` now reads this list out of this file and
-- compares it against `UPLOAD_CONTENT_TYPES`, so the two cannot drift again.
update storage.buckets
   set allowed_mime_types = array[
     -- What a person films, and what a render writes back.
     'video/mp4',
     'video/quicktime',
     'video/webm',
     'video/x-matroska',
     -- Overlays, logos, thumbnails, and the poster frame the worker grabs.
     'image/jpeg',
     'image/png',
     'image/webp',
     -- Music beds. `audio/mpeg` is mp3; the two mp4 spellings are both what a
     -- browser calls an m4a, depending on the browser.
     'audio/mpeg',
     'audio/mp4',
     'audio/x-m4a',
     'audio/aac',
     'audio/wav',
     'audio/ogg',
     -- Fonts somebody brought: the upload, the repaired face the worker writes,
     -- and the subset the picker draws its sample in.
     'font/ttf',
     'font/otf',
     'font/woff2'
   ]
 where id = 'videos';
