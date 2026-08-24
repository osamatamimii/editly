-- A still from each clip, so the panel can show what a piece looks like
-- without loading the piece.
--
-- Six clips meant six <video> elements fetching metadata at once; a poster
-- frame is one small image each, and the player then loads nothing at all
-- until somebody presses play.
--
-- Nullable on purpose, like every other artefact the worker makes
-- best-effort: a clip whose still could not be grabbed is still a clip.
ALTER TABLE clips ADD COLUMN IF NOT EXISTS thumbnail_path text;

COMMENT ON COLUMN clips.thumbnail_path IS
  'Storage key of a frame grabbed from the middle of this clip. NULL when it could not be made - a missing poster must never cost a render.';
