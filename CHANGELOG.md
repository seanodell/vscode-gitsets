# Changelog

All notable changes to the Git Sets extension are documented here.

## [0.3.1] - 2026-06-23

### Added
- **Expand All** / **Collapse All** buttons in the GitSets panel header; folders default to collapsed
- Repository picker when creating a set groups repos by folder, matching the configured root folder hierarchy; folder name shown as description and as a separator between groups — typing an org name filters to just that group

## [0.3.0] - 2026-06-23

### Added
- Filesystem watchers on `**/.git` and `**/gitsets.json` under the root folder — the tree refreshes automatically when repos or sets appear or disappear

### Changed
- Repos and sets are now discovered by scanning a configurable root folder (`gitsets.rootFolder`) instead of being manually registered per workspace
- Removed **Add Repository**, **Remove Repository**, and **Remove Set** commands — the filesystem is the source of truth
- **Add Set** now always creates the set folder under `gitsets.rootFolder`; no root folder picker step
- Extension no longer requires an open workspace
- `gitsets.newSetDefaultRoot` renamed to `gitsets.rootFolder`

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
