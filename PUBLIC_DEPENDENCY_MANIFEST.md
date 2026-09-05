# Public Maintenance Dependency Manifest

All inherited execution source comes from golden commit
ac3e6222aa58c3f81ff77f240bd5d7d0aca4ee83. Public metadata and portable acceptance
tests are prepared in this candidate and included in its canonical
[public inventory](deployment/stateful-relay-public-maintenance.manifest.json).

The runtime package has no external package dependencies. It uses Node built-in
modules and requires the existing Node engine contract. The exact source
closure is independently hash-bound by
[the golden source manifest](deployment/stateful-relay-v13-golden-source.manifest.json).

The optional Windows launcher requires Windows PowerShell and a separately
authorized owner deployment. Its public source does not include any installed
Scheduler definition, credential data, owner mapping or live configuration.
The Native executor requires a separately verified official Codex binary; the
accepted 0.153.4 executable identity and capability digest are non-secret
compatibility records, not an installation or runtime-rebind action.

Independent tests execute a byte-identical export outside the project workspace
with an isolated empty Codex home and no inherited private deployment variables.
All fixtures are created in temporary directories. No private sibling checkout,
auth store, live queue, runtime binding or visualization artifact is a dependency.
