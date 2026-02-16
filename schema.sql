-- Spygmo Monitor - Supabase Schema
-- Copy-paste this into Supabase SQL Editor (supabase.com > your project > SQL Editor)

-- Table: recordings
CREATE TABLE recordings (
  id           BIGINT PRIMARY KEY,
  name         TEXT NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration     INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  data         JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for listing recordings ordered by date
CREATE INDEX idx_recordings_recorded_at ON recordings (recorded_at DESC);

-- Enable Row Level Security
ALTER TABLE recordings ENABLE ROW LEVEL SECURITY;

-- Allow all operations (single-user app, no auth)
CREATE POLICY "Allow all operations" ON recordings
  FOR ALL
  USING (true)
  WITH CHECK (true);
