# Installing Workbench Local

## Prerequisites

- macOS with a supported Apple Silicon or Intel environment.
- Node.js `20.20.2` and pnpm `10.33.0` for source builds.
- Git for repository-aware workflows.
- A local folder or repository that you choose to connect as a Workbench
  source.

Workbench is local-first. A connected source remains on your computer; add
only folders you intend to make available to your local AI workflow.

## Source installation

```sh
git clone https://github.com/prochattools/workbench.git
cd workbench
corepack enable
pnpm install
pnpm build
```

Run the repository's documented local startup command for your platform, then
connect a source through Workbench. Check status and source health before
starting a task.

## First-run checklist

1. Confirm the runtime and authentication status.
2. Add one repository or folder as a source.
3. Run or confirm the initial index.
4. Select the exact source for the conversation.
5. Begin with a read-only status or context request.

Do not add secrets, credentials, Git internals, or generated runtime data as
knowledge sources.
