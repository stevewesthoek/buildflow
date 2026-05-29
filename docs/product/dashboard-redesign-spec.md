# BuildFlow Local Dashboard Redesign Spec

## Goal

Design the BuildFlow Local dashboard as a compact local repo workbench.

The dashboard should implement the generated BuildFlow three-panel mockup direction:

1. Overview dashboard for at-a-glance health, source metrics, activity, plans, and workflow.
2. Context & Sources dashboard for source health, indexed content, active source management, and context mode.
3. Plans & Tasks dashboard for local plan progress, task state, and execution handoff readiness.

The dashboard should feel closer to:

- ChatGPT app familiarity
- Codex app shell
- Linear density
- Vercel precision
- Apple restraint

This is a visual and information-architecture pass, not a backend rewrite.

## Principles

- Keep the shell fixed-height and contained
- Prefer dense, readable rows over bulky cards
- Make source management feel like a workspace browser
- Keep actions in compact chrome instead of repeated large buttons
- Preserve reliability states and cached source visibility
- Keep the dashboard calm in both light and dark mode
- BuildFlow dashboard components should share a small primitive layer for buttons, panels, rows, status, and section headers
- Use one professional icon source or no icons at all
- Default controls should be rectangular, not pill-shaped
- UI text should use the system font stack; code, prompts, and paths should use JetBrains Mono or JetBrainsMono Nerd Font
- Prefer flat panels and subtle surfaces; avoid a grid of boxed cards
- Each data point should have one primary owner in the layout

## Layout

### Top bar

- BuildFlow identity
- current section label
- compact source/agent/write chips
- refresh
- compact theme toggle

### Left rail

- Overview
- Sources
- Activity
- Plans
- Handoff
- Settings
- compact source/repo browser if practical

### Main workspace

- Overview view for summary and next action
- Sources view for the compact source list and source actions
- Activity view for recent events and status timeline
- Plans view for packet and progress placeholders
- Handoff view for copy-ready prompts
- Settings view for context and write-mode state

### Right inspector

- workspace health
- source summary
- recent activity
- contextual hints
- selected source or section detail when available

## Sources view

- Render sources as a compact list or table
- Include a header row when practical
- Keep columns for:
  - source
  - status/files
  - enabled
  - active
  - access/write profile if available
  - actions
- Use a three-dot overflow menu for source actions
- Avoid repeated visible action buttons on every row

## Activity view

- Present recent events as a compact timeline
- Use subtle dividers and small status dots
- Prefer small rows over large stacked cards
- Keep the empty state simple and calm

## Visual treatment

- Reduce the number of large rounded cards
- Prefer `rounded-lg` and `rounded-xl`
- Use flat panels, subtle borders, and precise spacing
- Avoid default Tailwind admin-dashboard spacing
- Make light mode feel intentional, not generic
- Make dark mode feel dense and premium
- Do not use pill-shaped controls by default
- Use one icon source or no icons at all
- Keep status text short enough to fit the inspector without overflow
- Prefer dots and plain text over badges in source rows

## Reliability requirements

- Do not regress source visibility when refresh fails
- Do not break add/toggle/enable/disable/reindex/remove actions
- Keep the agent responsive during reindex
- Keep cached source state visible if the agent temporarily fails

## Non-goals for this pass

- backend/API route redesign
- OpenAPI schema changes
- Custom GPT schema changes
- chat implementation
- new source-management permissions model
- managed/private repo changes
