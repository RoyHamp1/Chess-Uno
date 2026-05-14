-- Run once against database "ChUno" (or use: npm run db:migrate)

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email VARCHAR(320) NOT NULL UNIQUE,
  username VARCHAR(32) NOT NULL,
  password_hash TEXT NOT NULL,
  ranked_rating INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));

CREATE TABLE IF NOT EXISTS password_resets (
  email VARCHAR(320) PRIMARY KEY REFERENCES users (email) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

-- If `users` was created before ranked_rating existed (works on older PostgreSQL):
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'ranked_rating'
  ) THEN
    ALTER TABLE users ADD COLUMN ranked_rating INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;
