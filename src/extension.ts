import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { runGit } from './git';

const CONFIG_SECTION = 'gitsets';
const GITSETS_FILE = 'gitsets.json';

export function activate(context: vscode.ExtensionContext) {
  // Repositories and sets are both owned by the workspace and stored opaquely
  // in workspaceState as arrays of paths — never in the project tree or
  // settings.json.
  const repos = new PathStore(context.workspaceState, 'gitsets.repositories');
  const sets = new PathStore(context.workspaceState, 'gitsets.sets');
  const provider = new GitSetsProvider(repos, sets);

  // Heal any legacy/corrupt entries (e.g. pre-array data) once on startup.
  void Promise.all([repos.prune(), sets.prune()]).then(() => provider.refresh());

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('gitsets.view', provider),
    vscode.commands.registerCommand('gitsets.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('gitsets.addRepository', () => addRepository(provider, repos)),
    vscode.commands.registerCommand('gitsets.removeRepository', (node?: RepoNode) => removeRepository(provider, repos, node)),
    vscode.commands.registerCommand('gitsets.openRepository', (node?: RepoNode) => openRepository(node)),
    vscode.commands.registerCommand('gitsets.addSet', () => addSet(provider, repos, sets)),
    vscode.commands.registerCommand('gitsets.removeSet', (node?: SetNode) => removeSet(provider, sets, node)),
    vscode.commands.registerCommand('gitsets.openSet', (node?: SetNode) => openSet(node)),
    vscode.commands.registerCommand('gitsets.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:seanodell.git-sets'),
    ),
  );
}

export function deactivate() {}

// --- Repositories ------------------------------------------------------------

// Workspace-scoped, opaque list of paths backed by `workspaceState`. Used for
// both repositories and set folders — each is just an array of strings.
class PathStore {
  constructor(
    private readonly memento: vscode.Memento,
    private readonly key: string,
  ) {}

  list(): string[] {
    return PathStore.sanitize(this.memento.get<unknown>(this.key, []));
  }

  async add(value: string): Promise<boolean> {
    const current = this.list();
    if (current.includes(value)) {
      return false;
    }
    await this.memento.update(this.key, [...current, value]);
    return true;
  }

  async remove(value: string): Promise<void> {
    await this.memento.update(
      this.key,
      this.list().filter((p) => p !== value),
    );
  }

  // Rewrite storage to the sanitized form once, removing legacy/corrupt entries.
  async prune(): Promise<void> {
    const raw = this.memento.get<unknown>(this.key, []);
    const clean = PathStore.sanitize(raw);
    if (JSON.stringify(raw) !== JSON.stringify(clean)) {
      await this.memento.update(this.key, clean);
    }
  }

  // Drop anything that isn't a non-empty string, and de-duplicate. Tolerates
  // corrupt or legacy data (e.g. old object entries) without crashing the view.
  private static sanitize(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of raw) {
      if (typeof value === 'string' && value.length > 0 && !seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
    }
    return out;
  }
}

// The extension operates on the open workspace; an empty window has nothing to
// act on and no workspace to own the state.
function hasWorkspace(): boolean {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
}

async function addRepository(provider: GitSetsProvider, repos: PathStore): Promise<void> {
  if (!hasWorkspace()) {
    vscode.window.showErrorMessage('Open a folder or workspace before adding a repository.');
    return;
  }

  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Add Repository',
    title: 'Select a Git Repository',
  });
  if (!picked || picked.length === 0) {
    return;
  }

  const folder = picked[0].fsPath;

  // A repository root has a `.git` *directory*. Linked worktrees and submodules
  // have a `.git` *file* (a gitdir pointer) — reject those.
  let isRepoRoot = false;
  try {
    const stat = await fs.stat(path.join(folder, '.git'));
    isRepoRoot = stat.isDirectory();
  } catch {
    isRepoRoot = false;
  }
  if (!isRepoRoot) {
    vscode.window.showErrorMessage(
      `Not a git repository root: "${folder}" has no .git directory. ` +
        `(Linked worktrees and submodules have a .git file, not a folder.)`,
    );
    return;
  }

  const added = await repos.add(folder);
  if (!added) {
    vscode.window.showInformationMessage(`Repository already added: ${folder}`);
    return;
  }
  provider.refresh();
}

async function removeRepository(provider: GitSetsProvider, repos: PathStore, node?: RepoNode): Promise<void> {
  if (!node) {
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    `Remove "${node.repoPath}" from Git Sets?`,
    { modal: true, detail: 'This only removes it from the list. The repository on disk is untouched.' },
    'Remove',
  );
  if (choice !== 'Remove') {
    return;
  }

  await repos.remove(node.repoPath);
  provider.refresh();
}

// Open a repository in place, on whatever branch it currently sits on. The repo
// is opened through a sibling `<basename>.code-workspace` (same naming as sets),
// created on first open and reconciled on reopen so the repo's folder is always
// listed — never touching git state.
async function openRepository(node?: RepoNode): Promise<void> {
  if (!node) {
    return;
  }

  const repoPath = node.repoPath;
  const parent = path.dirname(repoPath);
  const base = path.basename(repoPath);
  const fileName = `${base}.code-workspace`;
  const wsPath = path.join(parent, fileName);

  let raw: string | undefined;
  try {
    raw = await fs.readFile(wsPath, 'utf8');
  } catch (err) {
    // Absent is the common case: create a fresh workspace listing this repo.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await writeCodeWorkspace(parent, fileName, [base]);
    } else {
      vscode.window.showErrorMessage(`Could not read "${wsPath}": ${errorText(err)}`);
      return;
    }
  }

  if (raw !== undefined) {
    let parsed: { folders?: { path?: string }[] };
    try {
      parsed = JSON.parse(raw) as { folders?: { path?: string }[] };
    } catch {
      vscode.window.showErrorMessage(
        `"${wsPath}" is not a valid .code-workspace file; leaving it untouched.`,
      );
      return;
    }

    const folders = Array.isArray(parsed.folders) ? parsed.folders : [];
    // Membership by resolved absolute path, so a folder recorded as either a
    // relative or absolute path is recognized and never duplicated.
    const present = folders.some(
      (f) => typeof f.path === 'string' && path.resolve(parent, f.path) === repoPath,
    );
    if (!present) {
      parsed.folders = [...folders, { path: base }];
      await fs.writeFile(wsPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    }
  }

  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsPath), { forceNewWindow: true });
}

// --- Sets --------------------------------------------------------------------

// The set folder carries this manifest. It stores only the one thing nothing
// else can provide: the full path-like name (e.g. "feature/login-bug"). The
// member folders come from the .code-workspace; the branch and each member's
// source repo are owned by git and derived on demand — never duplicated here.
interface GitSet {
  name: string;
}

// A rendered set: its folder path plus the name read from gitsets.json (or a
// fallback when the manifest is missing/invalid). Derived on read — nothing
// but the path is stored.
interface SetEntry {
  path: string;
  name: string;
  broken: boolean;
}

// Resolve a configured root path. Empty means the user's home directory.
// VS Code does not expand these for settings read through the extension API,
// so we do it ourselves.
function resolveRoot(value: string): string {
  let p = value.trim();
  if (!p) {
    return os.homedir();
  }
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  p = p.replace(/\$\{userHome\}/g, os.homedir());
  p = p.replace(/\$\{env:([^}]+)\}/g, (_, name) => process.env[name] ?? '');
  return p;
}

function getDefaultSetRoot(): string {
  const configured = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('newSetDefaultRoot', '');
  return resolveRoot(configured);
}

// Validate a set name as a git branch name (slashes allowed as hierarchy).
function validateSetName(raw: string): string | undefined {
  const v = raw.trim();
  if (!v) return 'Name cannot be empty';
  if (v.startsWith('/') || v.endsWith('/')) return 'Name cannot start or end with "/"';
  if (v.includes('//')) return 'Name cannot contain "//"';
  if (/\s/.test(v)) return 'Name cannot contain whitespace';
  if (/[~^:?*\[\\]/.test(v)) return 'Name cannot contain ~ ^ : ? * [ or \\';
  if (v.includes('..')) return 'Name cannot contain ".."';
  if (v.endsWith('.lock')) return 'Name cannot end with ".lock"';
  for (const seg of v.split('/')) {
    if (seg.startsWith('.')) return 'Path segments cannot start with "."';
  }
  return undefined;
}

async function readGitSet(setFolder: string): Promise<GitSet | undefined> {
  try {
    const raw = await fs.readFile(path.join(setFolder, GITSETS_FILE), 'utf8');
    return JSON.parse(raw) as GitSet;
  } catch {
    return undefined;
  }
}

async function writeGitSet(setFolder: string, set: GitSet): Promise<void> {
  await fs.mkdir(setFolder, { recursive: true });
  await fs.writeFile(path.join(setFolder, GITSETS_FILE), JSON.stringify(set, null, 2) + '\n', 'utf8');
}

// Generate the multi-root .code-workspace that lists each worktree folder as a
// root, so opening it gives a ready-to-go workspace.
async function writeCodeWorkspace(setFolder: string, fileName: string, worktrees: string[]): Promise<void> {
  const content = { folders: worktrees.map((w) => ({ path: w })) };
  await fs.writeFile(path.join(setFolder, fileName), JSON.stringify(content, null, 2) + '\n', 'utf8');
}

// Locate the .code-workspace inside a set folder (absolute path), if any.
async function findWorkspaceFile(setFolder: string): Promise<string | undefined> {
  try {
    const entries = await fs.readdir(setFolder);
    const wsFile = entries.find((e: string) => e.endsWith('.code-workspace'));
    return wsFile ? path.join(setFolder, wsFile) : undefined;
  } catch {
    return undefined;
  }
}

// The .code-workspace is the single source of truth for a set's member folders.
// Returns the relative worktree paths, or undefined if no readable workspace
// file is present.
async function readWorkspaceFolders(setFolder: string): Promise<string[] | undefined> {
  const wsPath = await findWorkspaceFile(setFolder);
  if (!wsPath) {
    return undefined;
  }
  try {
    const raw = await fs.readFile(wsPath, 'utf8');
    const parsed = JSON.parse(raw) as { folders?: { path?: string }[] };
    return (parsed.folders ?? [])
      .map((f) => f.path)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
  } catch {
    return undefined;
  }
}

async function openSet(node?: SetNode): Promise<void> {
  if (!node) {
    return;
  }
  const wsPath = await findWorkspaceFile(node.entry.path);
  if (!wsPath) {
    vscode.window.showErrorMessage(`No .code-workspace found in "${node.entry.path}".`);
    return;
  }
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsPath), { forceNewWindow: true });
}

async function addSet(provider: GitSetsProvider, repos: PathStore, sets: PathStore): Promise<void> {
  if (!hasWorkspace()) {
    vscode.window.showErrorMessage('Open a folder or workspace before adding a set.');
    return;
  }

  const repoPaths = repos.list();
  if (repoPaths.length === 0) {
    vscode.window.showErrorMessage('Add a repository before creating a set.');
    return;
  }

  // 1. Name (also the branch and folder path; "/" allowed for hierarchy).
  const name = await vscode.window.showInputBox({
    title: 'New Set',
    prompt: 'Set name — used as the branch name and folder path. "/" creates hierarchy.',
    placeHolder: 'e.g. feature/login-bug',
    validateInput: validateSetName,
  });
  if (name === undefined) {
    return;
  }
  const setName = name.trim();

  // 2. Repositories (multi-select from the added repos).
  const picks = await vscode.window.showQuickPick(
    repoPaths.map((repo) => ({ label: path.basename(repo), description: repo, repo })),
    {
      canPickMany: true,
      title: 'New Set — Repositories',
      placeHolder: 'Select one or more repositories for the set',
    },
  );
  if (!picks || picks.length === 0) {
    return;
  }

  const basenames = picks.map((p) => path.basename(p.repo));
  if (new Set(basenames).size !== basenames.length) {
    vscode.window.showErrorMessage(
      'Selected repositories have duplicate folder names; they cannot share one set folder.',
    );
    return;
  }

  // 3. Root folder (defaults to the configured default set root).
  const rootPick = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Use as Set Root',
    title: 'New Set — Root Folder',
    defaultUri: vscode.Uri.file(getDefaultSetRoot()),
  });
  if (!rootPick || rootPick.length === 0) {
    return;
  }
  const root = rootPick[0].fsPath;

  const setFolder = path.join(root, ...setName.split('/'));

  // Refuse to clobber an existing folder.
  let exists = true;
  try {
    await fs.access(setFolder);
  } catch {
    exists = false;
  }
  if (exists) {
    vscode.window.showErrorMessage(`A folder already exists at: ${setFolder}`);
    return;
  }

  await fs.mkdir(setFolder, { recursive: true });

  // Create a worktree per repo, branching from main.
  const worktrees: string[] = [];
  const failures: string[] = [];
  for (const pick of picks) {
    const sub = path.basename(pick.repo);
    const worktreePath = path.join(setFolder, sub);
    try {
      await runGit(['worktree', 'add', '-b', setName, worktreePath, 'main'], { cwd: pick.repo });
      worktrees.push(sub);
    } catch (err) {
      failures.push(`${sub}: ${errorText(err)}`);
    }
  }

  if (worktrees.length === 0) {
    vscode.window.showErrorMessage(`Could not create any worktrees.\n${failures.join('\n')}`);
    await fs.rm(setFolder, { recursive: true, force: true }).catch(() => undefined);
    return;
  }

  // gitsets.json stores only the path-like name; the .code-workspace owns the
  // member folder list and is the openable artifact.
  const leaf = setName.split('/').pop() ?? setName;
  const workspaceFile = `${leaf}.code-workspace`;
  await writeGitSet(setFolder, { name: setName });
  await writeCodeWorkspace(setFolder, workspaceFile, worktrees);
  await sets.add(setFolder);
  provider.refresh();

  if (failures.length > 0) {
    vscode.window.showWarningMessage(
      `Set "${setName}" created with ${worktrees.length} worktree(s); ${failures.length} failed:\n${failures.join('\n')}`,
    );
    return;
  }

  const open = await vscode.window.showInformationMessage(`Set "${setName}" created.`, 'Open Workspace');
  if (open === 'Open Workspace') {
    vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(path.join(setFolder, workspaceFile)),
      { forceNewWindow: true },
    );
  }
}

async function removeSet(provider: GitSetsProvider, sets: PathStore, node?: SetNode): Promise<void> {
  if (!node) {
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    `Remove set "${node.entry.name}"?`,
    {
      modal: true,
      detail: 'This removes the set from this workspace. The folder and worktrees on disk are left untouched.',
    },
    'Remove',
  );
  if (choice !== 'Remove') {
    return;
  }

  await sets.remove(node.entry.path);
  provider.refresh();
}

// --- Tree --------------------------------------------------------------------

type TreeNode = SectionNode | RepoNode | SetGroupNode | SetNode | SetMemberNode | MessageNode;

class GitSetsProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly repos: PathStore,
    private readonly sets: PathStore,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    // Top level: two fixed sections.
    if (!element) {
      return [new SectionNode('repos'), new SectionNode('sets')];
    }

    if (element instanceof SectionNode) {
      if (element.section === 'repos') {
        return this.repos.list().map((repoPath) => new RepoNode(repoPath));
      }
      return this.setChildren([]);
    }

    // Set hierarchy: grouping nodes drill down by path segment.
    if (element instanceof SetGroupNode) {
      return this.setChildren(element.prefix);
    }

    // A set expands to its worktree members, read from the .code-workspace.
    if (element instanceof SetNode) {
      const folders = await readWorkspaceFolders(element.entry.path);
      if (!folders) {
        return [new MessageNode('workspace file missing or invalid', 'warning', `msg:${element.entry.path}`)];
      }
      return folders.map((rel) => new SetMemberNode(rel, path.join(element.entry.path, rel)));
    }

    return [];
  }

  // Resolve each stored set path to its name (from gitsets.json) so the tree
  // can group by the path-like name. A missing/invalid manifest marks the set
  // broken and falls back to the folder's basename.
  private async loadSetEntries(): Promise<SetEntry[]> {
    return Promise.all(
      this.sets.list().map(async (setPath) => {
        const gitSet = await readGitSet(setPath);
        return gitSet
          ? { path: setPath, name: gitSet.name, broken: false }
          : { path: setPath, name: path.basename(setPath), broken: true };
      }),
    );
  }

  // Build the level of the set tree at `prefix` (an array of name segments).
  // Entries whose name has more depth become grouping nodes; entries whose
  // name ends exactly here become set leaves.
  private async setChildren(prefix: string[]): Promise<TreeNode[]> {
    const depth = prefix.length;
    const groups = new Set<string>();
    const leaves: SetEntry[] = [];

    for (const entry of await this.loadSetEntries()) {
      const segments = entry.name.split('/');
      if (segments.length <= depth) {
        continue;
      }
      const matchesPrefix = prefix.every((seg, i) => segments[i] === seg);
      if (!matchesPrefix) {
        continue;
      }
      if (segments.length === depth + 1) {
        leaves.push(entry);
      } else {
        groups.add(segments[depth]);
      }
    }

    const nodes: TreeNode[] = [];
    for (const seg of [...groups].sort()) {
      nodes.push(new SetGroupNode([...prefix, seg]));
    }
    for (const entry of leaves.sort((a, b) => a.name.localeCompare(b.name))) {
      nodes.push(new SetNode(entry));
    }
    return nodes;
  }
}

class SectionNode extends vscode.TreeItem {
  constructor(public readonly section: 'repos' | 'sets') {
    const isRepos = section === 'repos';
    super(
      isRepos ? 'Repositories' : 'Sets',
      isRepos ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Expanded,
    );
    this.id = `section:${section}`;
    this.contextValue = isRepos ? 'reposSection' : 'setsSection';
  }
}

class RepoNode extends vscode.TreeItem {
  constructor(public readonly repoPath: string) {
    super(path.basename(repoPath), vscode.TreeItemCollapsibleState.None);
    this.id = `repo:${repoPath}`;
    this.description = repoPath;
    this.tooltip = repoPath;
    this.iconPath = new vscode.ThemeIcon('repo');
    this.contextValue = 'repository';
    this.resourceUri = vscode.Uri.file(repoPath);
  }
}

class SetGroupNode extends vscode.TreeItem {
  constructor(public readonly prefix: string[]) {
    super(prefix[prefix.length - 1], vscode.TreeItemCollapsibleState.Expanded);
    this.id = `setgroup:${prefix.join('/')}`;
    this.contextValue = 'setGroup';
    this.iconPath = new vscode.ThemeIcon('folder');
  }
}

class SetNode extends vscode.TreeItem {
  constructor(public readonly entry: SetEntry) {
    super(entry.name.split('/').pop() ?? entry.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `set:${entry.path}`;
    this.description = entry.path;
    this.tooltip = entry.broken ? `${entry.path}\n(gitsets.json missing or invalid)` : entry.path;
    this.iconPath = new vscode.ThemeIcon(entry.broken ? 'warning' : 'layers');
    this.contextValue = 'set';
    this.resourceUri = vscode.Uri.file(entry.path);
  }
}

class SetMemberNode extends vscode.TreeItem {
  constructor(relPath: string, worktreePath: string) {
    super(path.basename(relPath), vscode.TreeItemCollapsibleState.None);
    this.id = `setmember:${worktreePath}`;
    this.description = worktreePath;
    this.tooltip = worktreePath;
    this.iconPath = new vscode.ThemeIcon('git-branch');
    this.contextValue = 'setMember';
    this.resourceUri = vscode.Uri.file(worktreePath);
  }
}

class MessageNode extends vscode.TreeItem {
  constructor(label: string, icon: string, id: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = id;
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

// --- util --------------------------------------------------------------------

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
