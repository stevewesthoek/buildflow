# Workbench 1.3.12-beta

Workbench 1.3.12-beta is a local-first release focused on controlled context
and reliable repository work.

## Highlights

- Context Intelligence foundation for selecting and controlling repository
  context.
- Repository freshness awareness, including revision and worktree state.
- More explicit indexing lifecycle and bounded refresh behavior.
- Improved doctor and diagnostics coverage for local setup and source state.
- Safety boundaries around source selection, file operations, commands, and
  confirmation-gated changes.

## What this release is

Workbench is a local AI work environment. It can work with repositories,
folders, documentation, notes, and other connected knowledge sources, while
keeping local files and execution under the user's control.

## Migration notes

1. Review the installation prerequisites in [`INSTALLATION.md`](../INSTALLATION.md).
2. Recheck connected sources and perform a manual reindex when a source was
   changed outside Workbench.
3. Keep explicit source selection enabled for conversations that span more
   than one repository.

## Deferred work

Provider architecture, managed services, external provider integrations, and
future orchestration work are not part of this release.
