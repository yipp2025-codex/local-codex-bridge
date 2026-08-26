# Migration notes

- Start a fresh deployment-owned Relay database for this candidate. Do not
  copy or publish a local database, logs, or runtime output.
- Recreate trusted project aliases in deployment configuration. A public
  caller must not be allowed to replace an alias with an arbitrary path.
- Preserve the manual workflow: dispatch, inbox, report, results, review,
  and explicit recovery through status or resume.
- Treat the deprecated Relay-spawn execution path as removed from Stateful
  Relay V1.
- Production integration, automatic execution, polling, and push notification
  require separate future authorization.
