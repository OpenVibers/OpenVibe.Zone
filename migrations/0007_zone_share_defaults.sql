-- phase: expand
-- A person's choice for the console audience of named buckets they create.
-- Storage access remains governed by the project's S3 keys.
CREATE TABLE IF NOT EXISTS zone_share_defaults (
    subject text PRIMARY KEY,
    audience text NOT NULL DEFAULT 'private' CHECK (audience IN ('private', 'people')),
    updated_at timestamptz NOT NULL DEFAULT now()
);
