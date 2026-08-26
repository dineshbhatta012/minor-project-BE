-- Apply to databases created before draft routes were supported.
ALTER TABLE routes
    ALTER COLUMN start_stop_id DROP NOT NULL,
    ALTER COLUMN end_stop_id DROP NOT NULL;
