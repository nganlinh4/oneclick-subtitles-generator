DROP INDEX IF EXISTS jobs_state_idx;

CREATE INDEX IF NOT EXISTS jobs_state_updated_idx ON jobs(state, updated_at_ms DESC, id DESC);
