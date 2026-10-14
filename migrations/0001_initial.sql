-- phase: expand
-- OpenVibe.Zone (ADR-031 amendment 2026-10-02): named object zones per project environment. Zone owns the record;
-- OpenVibe.Media owns everything inside a zone (objects, bytes, keys, quotas, the deletion path) and keeps a
-- projection of each record, pushed with a higher revision on every change (pushed_revision is what Media has).

CREATE TABLE zone_zones (
    id              text COLLATE "C" PRIMARY KEY,                 -- zon_<ULID>, never reused
    project_id      text COLLATE "C" NOT NULL,
    env             text COLLATE "C" NOT NULL CHECK (env IN ('sandbox', 'production')),
    name            text COLLATE "C" NOT NULL,
    is_default      boolean NOT NULL DEFAULT false,
    description     text,
    state           text COLLATE "C" NOT NULL CHECK (state IN ('provisioning', 'active', 'deleting', 'deleted')),
    quota_bytes     bigint,
    revision        integer NOT NULL,
    pushed_revision integer NOT NULL DEFAULT 0,
    created_at      bigint NOT NULL,
    updated_at      bigint,
    deletion_requested_at bigint,
    deletion_completed_at bigint,
    -- A name belongs to one zone of its environment for ever, deleted or not.
    UNIQUE (project_id, env, name)
);
CREATE INDEX zone_zones_project ON zone_zones (project_id, env, id);
CREATE INDEX zone_zones_pending ON zone_zones (id) WHERE pushed_revision < revision OR state = 'deleting';

-- The first answer to each create (caller, Idempotency-Key), returned again for a repeat.
CREATE TABLE zone_idempotency (
    caller          text COLLATE "C" NOT NULL,
    idempotency_key text COLLATE "C" NOT NULL,
    digest          text COLLATE "C" NOT NULL,
    zone_id         text COLLATE "C" NOT NULL,
    created_at      bigint NOT NULL,
    PRIMARY KEY (caller, idempotency_key)
);

-- ADR-048 control requests from OpenVibe.Services: the first answer per (caller, project, idempotency_key).
CREATE TABLE zone_control_log (
    caller          text COLLATE "C" NOT NULL,
    project_id      text COLLATE "C" NOT NULL,
    idempotency_key text COLLATE "C" NOT NULL,
    digest          text COLLATE "C" NOT NULL,
    response        jsonb NOT NULL,
    created_at      bigint NOT NULL,
    PRIMARY KEY (caller, project_id, idempotency_key)
);
