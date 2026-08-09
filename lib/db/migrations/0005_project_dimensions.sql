-- The clip's own pixel dimensions.
--
-- The player was a fixed 16:9 box, so a 9:16 phone recording — which is the
-- entire point of this product — pillarboxed down to a stamp in the middle of a
-- wall of black. Reading the ratio off the <video> element fixes that, but only
-- once the browser has decoded enough to fire loadedmetadata: until then the box
-- is the wrong shape and visibly snaps, and for a codec the browser cannot
-- decode at all it stays wrong forever.
--
-- The browser already measures both numbers at upload time (readVideoFacts) and
-- was throwing them away. Storing them means the player is the right shape on
-- first paint, from the project record, with the decoded value only ever
-- confirming it.
alter table public.projects add column if not exists width integer;
alter table public.projects add column if not exists height integer;
