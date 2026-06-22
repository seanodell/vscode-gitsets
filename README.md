# Git Sets

A VS Code extension for managing **Git Sets** — collections of git worktrees that live together in one folder with a generated `.code-workspace`, so you can open a focused, ready-to-work window from inside the editor instead of the terminal.

## What problem does this solve?

When you work across multiple repositories simultaneously — for example, a backend and a frontend that share a feature branch — you normally have to:

- `cd` into each repo and `git worktree add` by hand
- Create a `.code-workspace` file manually
- Keep branch names in sync across repos

Git Sets automates all of that. You give a set a name (e.g. `feature/login-bug`), pick which repositories to include, and the extension creates a linked worktree in each one on a new branch with that name, writes a `.code-workspace` that lists all the worktrees, and opens the whole thing in a new window.

## Concepts

| Term | Meaning |
|---|---|
| **Repository** | A local git repository root (must have a `.git` directory, not a linked worktree). Registered once per workspace; shared across all sets. |
| **Set** | A named collection of linked worktrees, one per selected repository, all on the same branch. Lives in its own folder with a `.code-workspace`. |

## Usage

### 1. Open the Git Sets panel

The **Git Sets** panel appears in the Explorer sidebar. It has two sections: **Repositories** and **Sets**.

### 2. Add a repository

Click the **+** button on the Repositories section header, then select a folder that contains a `.git` directory. The repository is registered with the current workspace.

> Linked worktrees and submodules (which have a `.git` *file*, not a directory) are intentionally rejected — register the main repository root instead.

### 3. Create a set

Click the **+** button on the Sets section header (or run **Git Sets: Add Set** from the Command Palette). You will be prompted for:

1. **Name** — used as both the branch name and the set folder path. Slashes create hierarchy (e.g. `feature/login-bug`). Must be a valid git branch name segment.
2. **Repositories** — pick one or more from your registered repositories.
3. **Root folder** — the parent directory where the set folder is created. Defaults to the value of `gitsets.newSetDefaultRoot` (or your home directory if unset).

The extension then:

- Creates the set folder (e.g. `~/sets/feature/login-bug/`)
- Runs `git worktree add -b <name> <folder>/<repo> main` for each selected repository
- Writes a `gitsets.json` manifest in the set folder
- Writes a `<name>.code-workspace` listing all the worktree folders
- Offers to open the workspace immediately

### 4. Open a set

Click the **open window** icon on a set in the tree, or right-click and choose **Open Set**. The set's `.code-workspace` opens in a new VS Code window with all worktrees as roots.

### 5. Open a repository

Click the **open window** icon on a repository entry, or right-click and choose **Open Repository**. A `<repo>.code-workspace` is created next to the repository folder (or updated if it already exists) and opened in a new window.

### 6. Remove a repository or set

Click the **×** icon or right-click and choose **Remove Repository** / **Remove Set**. Removal only unregisters the item from this workspace — nothing on disk is deleted or modified.

## Requirements

- VS Code 1.90 or newer
- Git must be installed and available (the extension reuses the path resolved by VS Code's built-in Git extension)
- New worktrees are branched from `main`; each selected repository must have a `main` branch

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `gitsets.newSetDefaultRoot` | `""` (home directory) | Default root folder under which new set folders are created. Accepts an absolute path, `~`, `${userHome}`, or `${env:VAR}`. |

## Known Limitations

- New worktrees always branch from `main`. Configurable base-branch support is planned.
- Set state (registered repositories and set paths) is stored in VS Code's workspace state, so it is scoped to the workspace where you registered them.

## License

Apache 2.0 — see [LICENSE](LICENSE).
