'use strict';
// What openvibe.zone tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this site really serves: the zone API at /api/v1 and the usage guide at /docs.
// Sign-in is OpenVibe's Network OIDC; the S3 endpoint takes a zone access key, not a Network token.
module.exports = {
    id: 'zone',
    name: 'OpenVibe.Zone',
    purpose: 'Private S3-compatible storage zones for OpenVibe projects: create zones, issue access keys scoped to them, and use the AWS SDKs, rclone or any S3 tool.',
    home: 'https://openvibe.zone',
    site: 'openvibe.zone',
    api: '/api/v1',
    docs: '/docs',
    policy: {
        auth: ['none', 'Network OIDC', 'zone access key (S3 Signature Version 4)'],
    },
};
