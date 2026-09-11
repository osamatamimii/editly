-- The bucket learns the one plain-text thing this product ingests.
--
-- `lib/api-zod/src/limits.ts` now maps `.cube` to `text/plain`, because a
-- colour LUT is plain text by its own spec and a content type invented for
-- it would be a name Storage has never heard of. 0043 and 0045 both say the
-- rule: changing that list means changing the bucket in the same breath.
-- This is that breath.
--
-- The type is broad and the exposure is not. What an object claims to be
-- decides nothing here: the worker gates every `.cube` before `lut3d` sees
-- it (`lutUsable` -- a real LUT_3D_SIZE header, the 8 MB cap read from
-- stat), a text file uploaded as anything else still has to pass the same
-- gate to touch a render, and nothing serves bucket objects as pages. The
-- alternative -- a bespoke mime type -- would buy nothing but a second
-- spelling to keep in step.
update storage.buckets
   set allowed_mime_types = ARRAY[
     -- What a person films, and what a render writes back.
     'video/mp4',
     'video/quicktime',
     'video/webm',
     'video/x-matroska',
     'video/x-msvideo',
     'video/3gpp',
     -- Overlays, logos, thumbnails, and the poster frame the worker grabs.
     'image/jpeg',
     'image/png',
     'image/webp',
     'image/gif',
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
     'font/woff2',
     -- Colour cubes (.cube LUTs): plain text by their own spec.
     'text/plain'
   ]
 where id = 'videos';
