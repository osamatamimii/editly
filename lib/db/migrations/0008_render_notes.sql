-- Every degradation the pipeline reports has been going into a log line.
--
-- `enrich.ts` opens by promising that "every degradation comes back as a note
-- that reaches the job record and the user". It reached neither. There was no
-- column, no field in the API response, and nothing in the UI — so a render
-- that skipped captions because a key had expired came back looking exactly
-- like one that had done everything asked of it.
--
-- That is the specific failure this product is built against. The machinery for
-- saying "we could not do this part, and here is why" exists throughout the
-- worker, is tested, and was being thrown away one function call from the
-- customer.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS notes jsonb;

COMMENT ON COLUMN jobs.notes IS
  'What the render did and could not do, in the customer''s language. Written by the worker, shown in the UI.';
