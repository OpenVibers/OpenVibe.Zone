# Changelog

All notable changes to OpenVibe.Zone.

## 0.1.0 — 2026-10-14

- First release (ADR-031 amendment 2026-10-02, contracts 0.173.0).
- **Zones:** named object zones per project environment.
  - Each environment has a default zone.
  - Names are never reused.
  - Every change reaches OpenVibe.Media by revision; a zone is active only once Media has it.
  - Deletion is recursive, refuses held objects and completes once Media reports nothing left.
- **API:** for developer apps and project members, plus the resource index and control for OpenVibe.Services.
- **Console:** at openvibe.zone, with each project's zones, their usage, and S3 access keys issued through Media. A secret is shown once.
