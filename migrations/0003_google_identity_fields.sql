ALTER TABLE users ADD COLUMN google_email TEXT;

ALTER TABLE users ADD COLUMN google_email_verified INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub
ON users(google_sub)
WHERE google_sub IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_email
ON users(google_email)
WHERE google_email IS NOT NULL;