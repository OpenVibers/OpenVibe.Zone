-- phase: migrate
-- Every bucket that existed before sharing is registered once, so canView has a row for all of them.
-- A bucket is private storage: everyone's rows are Only me, and the project's members keep the S3
-- access they always had (their keys, not this row). Buckets with no recorded maker belong to Zone
-- itself, which nobody can sign in as.
INSERT INTO shares (service, kind, resource_id, owner_subject, audience)
SELECT
    'zone', 'zone', z.id,
    CASE
        WHEN z.created_by LIKE 'usr\_%' THEN jsonb_build_object('type', 'user', 'id', z.created_by)
        WHEN z.created_by LIKE 'gst\_%' THEN jsonb_build_object('type', 'guest', 'id', z.created_by)
        ELSE jsonb_build_object('type', 'service', 'id', 'zone')
    END,
    'private'
FROM zone_zones z
WHERE z.state <> 'deleted'
ON CONFLICT (service, kind, resource_id) DO NOTHING;
