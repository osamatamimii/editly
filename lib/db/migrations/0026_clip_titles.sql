-- What each clip is about, in the speaker's own words.
--
-- "Clip 2 - 0:41 to 1:10" tells you where a piece came from; it does not tell
-- you which piece is the one about pricing. The worker already holds the
-- transcript at the moment it chooses the windows, so the opening words of
-- each window become the clip's title - the speaker's words, never invented
-- copy, which is the same rule motion titles live by. NULL when nothing was
-- heard: a clip cut by even division has no words to be titled with, and a
-- made-up title would be the product pretending to have listened.
ALTER TABLE clips ADD COLUMN IF NOT EXISTS title text;

COMMENT ON COLUMN clips.title IS
  'The opening words spoken in this clip''s window, taken from the transcript. NULL when the clip was placed without one - a title the product invented would be a title the speaker never said.';
