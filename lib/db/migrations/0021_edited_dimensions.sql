-- The player draws the frame from `width`/`height` — the dimensions of the
-- *upload*. That was right until the first landscape source was rendered to a
-- vertical platform: the edited file is 720x1280 and the stored pair still
-- says 1920x1080, so the player draws a small landscape box around a portrait
-- video. On a browser that decodes the file, the shape snaps right once
-- metadata arrives; on one that cannot decode it, the stored pair is the only
-- truth there is, and it is the wrong one.
--
-- The worker knows the real output size — it chose it — so it writes the pair
-- here next to `edited_video_path`, and the player prefers it whenever the
-- edited file is the one on screen.
alter table projects add column if not exists edited_width  integer;
alter table projects add column if not exists edited_height integer;
