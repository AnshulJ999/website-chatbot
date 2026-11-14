ALTER TABLE visitors ADD COLUMN region TEXT;
ALTER TABLE visitors ADD COLUMN number INTEGER;
ALTER TABLE chats ADD COLUMN test INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

-- Number the visitors who already wrote, per site, in order of first visit.
UPDATE visitors SET number = (
  SELECT rn FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY site ORDER BY first_seen) AS rn
    FROM visitors WHERE id IN (SELECT visitor_id FROM chats WHERE message_count > 0)
  ) t WHERE t.id = visitors.id
);

-- Every chat before this migration came from the owner's own testing (the live sites were off).
UPDATE chats SET test = 1;
