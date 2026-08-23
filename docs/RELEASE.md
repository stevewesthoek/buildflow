# Workbench Release Process

## Private release

1. Implement and validate the scoped change.
2. Run type checks, tests, contract checks, and provenance validation.
3. Create and push the approved private release commit.

## Public release

1. Generate the public snapshot from the approved private release revision.
2. Review the README, release notes, installation documentation, and public
   file boundary.
3. Run public scope, build/install, documentation, secret, and diff checks.
4. Obtain explicit publication approval.
5. Create the public commit and release tag, then publish the release.

Public publication is never automatic. Private-only implementation details,
internal reconciliation material, credentials, and unreleased roadmap work
must remain outside the public snapshot.
