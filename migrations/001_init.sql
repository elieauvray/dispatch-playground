CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages (created_at DESC);
