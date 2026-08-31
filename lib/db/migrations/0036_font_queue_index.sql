-- The font sweep was a sequential scan every five seconds, per worker.
--
-- `caption_faces_user_idx` is `(user_id, script, status)`, which serves the
-- picker: "this person's ready Arabic faces". The worker's sweep asks a
-- different question entirely —
--
--   where status = 'pending'
--      or (status = 'preparing' and updated_at < now() - interval '10 minutes')
--
-- — with no `user_id` at all, so it cannot use that index and Postgres reads
-- the whole table. Today that table has one row and the cost is nothing. With
-- a hundred workers polling and a year of uploads behind it, it is a hundred
-- sequential scans a second over a table nobody is otherwise touching.
--
-- Partial, and the `where` is the point: the rows this query wants are the two
-- states that are *transient*. Every other row in the table is `ready` or
-- `refused` and will stay that way for ever, so indexing them would mean an
-- index that grows with the product for ever to answer a question about the
-- handful of rows that are in motion. A partial index stays the size of the
-- queue.
CREATE INDEX IF NOT EXISTS caption_faces_queue_idx
  ON caption_faces (created_at)
  WHERE status IN ('pending', 'preparing');

COMMENT ON INDEX caption_faces_queue_idx IS
  'The worker sweep, which asks by status with no user_id. Partial so it stays the size of the queue rather than the size of the table.';
