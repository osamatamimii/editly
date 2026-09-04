-- Three formats the renderer could always read and the product always refused.
--
-- `lib/api-zod/src/limits.ts` says it above `UPLOAD_CONTENT_TYPES`, and 0043
-- says it too: "Changing this list means changing the bucket in the same
-- breath." This is that breath. The list has learned `video/x-msvideo`,
-- `video/3gpp` and `image/gif`.
--
-- None of them is new capability. ffmpeg demuxes all three, and that was
-- checked against the version in the worker's image rather than assumed --
-- avi is what a decade of camcorders and screen recorders write, 3gp is what a
-- cheap phone writes, and a gif is a piece of b-roll people actually have. The
-- browser refused each of them with "that file is not a video", on behalf of a
-- renderer that would have read it, and the request was never made.
--
-- `image/heic` and `image/heif` are deliberately NOT here, and that is the
-- interesting half. HEIC is the iPhone's default camera format, so it is by
-- far the most-refused file in the product -- and the ffmpeg in the deployed
-- image cannot decode it. Accepting it would move the failure from a sentence
-- in the browser, before anything is uploaded, to a render that fails minutes
-- later with a customer watching. That is the trade this codebase refuses
-- everywhere else. What changed instead is the refusal: it now names the
-- format and says how to get a JPEG out of the same phone.
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
     'font/woff2'
   ]
 where id = 'videos';
