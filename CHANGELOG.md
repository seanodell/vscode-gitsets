# Changelog

All notable changes to the Git Sets extension are documented here.

## [0.2.0] - 2026-06-23

### Added
- Repos and sets displayed as path trees with common ancestor prefix stripped and single-child directory compression

### Changed
- Colored icons distinguish repositories (blue) from set members (green)
- Group nodes show expand arrow only — no folder icon
- Healthy sets show no icon; broken sets retain the warning icon
- Set members always shown flat (they share a common parent folder)

## [0.1.0] - 2026-06-22

### Added

- **Git Sets panel** in the Explorer sidebar for managing sets and repositories
- **Add Repository** — register any local git repository root with the current workspace
- **Open Repository** — open a repository in a new window via a generated `.code-workspace` file
- **Add Set** — create a named set that provisions a linked worktree in each selected repository, all on the same branch, under a shared folder with a generated `.code-workspace`
- **Open Set** — open a set's `.code-workspace` in a new window
- **Remove Repository / Remove Set** — untrack without touching anything on disk
- `gitsets.newSetDefaultRoot` setting to configure where new set folders are created
- Hierarchical set names (e.g. `feature/login-bug`) rendered as a collapsible tree
- Startup pruning of corrupt or legacy workspace state entries
