# Progress

Phase A is complete at golden commit ac3e6222aa58c3f81ff77f240bd5d7d0aca4ee83.
This public maintenance candidate derives from that immutable source and targets
main from the existing v1.0.0-stateful-relay.3 baseline.

Public documentation distinguishes AVAILABLE, EXPERIMENTAL and NOT_SHIPPED
surfaces. Exact source identity, private exclusions and independent validation
are recorded in [the public manifest](deployment/stateful-relay-public-maintenance.manifest.json).

Independent public regression passes 292/292 with no failures or skips. The test tree was exported byte-for-byte outside the project workspace and used an isolated empty Codex home with private deployment variables removed. The source/manifest and secret-leakage checks also pass.

This branch contains the prepared local maintenance candidate for owner review; its exact commit and patch identity are provided by Git and the owner review receipt.
No live mutation, new canary, Supervisor cutover, push or public tag is performed.
