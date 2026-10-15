-- phase: expand
-- A zone's metered usage (ADR-031 section 8, server/zone/usage.js): the hourly rollups Media sends as
-- media.usage.recorded, one row per zone, hour and series. Zone never counts; it keeps what Media reports and sums it.
CREATE TABLE zone_usage (
    zone_id         text COLLATE "C" NOT NULL,
    window_start    bigint NOT NULL,                              -- ms since the epoch, on the hour (UTC)
    capability      text COLLATE "C" NOT NULL,                    -- media.object.upload | read | list | delete
    unit            text COLLATE "C" NOT NULL,                    -- byte_hours | requests | egress_bytes
    quantity        bigint NOT NULL,
    errors          bigint NOT NULL DEFAULT 0,
    revision        integer NOT NULL,
    event_id        text COLLATE "C" NOT NULL,
    recorded_at     bigint NOT NULL,
    PRIMARY KEY (zone_id, window_start, capability, unit)
);
