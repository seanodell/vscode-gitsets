import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as os from 'node:os';
import { runGit } from './git';
import { buildPathTree, PathTree } from './tree';

const CONFIG_SECTION = 'gitsets';
const GITSETS_FILE = 'gitsets.json';

export function activate(context: vscode.ExtensionContext) {
  const store = new GitSetsStore(context);

  // Watchers are scoped to the configured root folder and recreated when it
  // changes. Stored outside subscriptions so they can be disposed on reset.
  let watchers: vscode.Disposable[] = [];

  function resetWatchers(): void {
    watchers.forEach(d => d.dispose());
    watchers = [];
    const rootFolder = getRootFolder();
    if (!rootFolder) return;
    const base = vscode.Uri.file(rootFolder);
    const refresh = () => store.refresh();
    const gitWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(base, '**/.git'),
    );
    const setsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(base, '**/gitsets.json'),
    );
    watchers = [
      gitWatcher,
      gitWatcher.onDidCreate(refresh),
      gitWatcher.onDidDelete(refresh),
      setsWatcher,
      setsWatcher.onDidCreate(refresh),
      setsWatcher.onDidDelete(refresh),
      setsWatcher.onDidChange(refresh),
    ];
  }

  resetWatchers();

  const favoritesProvider = new FavoritesProvider(store);
  const reposProvider = new ReposProvider(store);
  const setsProvider = new SetsProvider(store);

  const favoritesView = vscode.window.createTreeView('gitsets.favoritesView', {
    treeDataProvider: favoritesProvider,
  });
  const reposView = vscode.window.createTreeView('gitsets.reposView', {
    treeDataProvider: reposProvider,
    showCollapseAll: true,
  });
  const setsView = vscode.window.createTreeView('gitsets.setsView', {
    treeDataProvider: setsProvider,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    favoritesView,
    reposView,
    setsView,
    vscode.commands.registerCommand('gitsets.refresh', () => store.refresh()),
    vscode.commands.registerCommand('gitsets.expandAll', async () => {
      if (!getRootFolder()) return;
      const { repos, sets } = await store.scan();
      const repoRoots = renderRepoLevel([], buildPathTree(repos), store.favorites);
      const setEntries = await loadSetEntries(sets);
      const setRoots = renderSetLevel([], buildPathTree(sets), setEntries, store.favorites);
      await Promise.all([
        ...repoRoots.map(n => reposView.reveal(n, { expand: 3 })),
        ...setRoots.map(n => setsView.reveal(n, { expand: 3 })),
      ]);
    }),
    vscode.commands.registerCommand('gitsets.openRepository', (node?: RepoNode) => openRepository(node)),
    vscode.commands.registerCommand('gitsets.addFavorite', (node?: RepoNode | SetNode) => {
      if (!node) return;
      store.toggleFavorite(node instanceof RepoNode ? node.repoPath : node.entry.path);
    }),
    vscode.commands.registerCommand('gitsets.removeFavorite', async (node?: RepoNode | SetNode) => {
      if (!node) return;
      if (node.id?.startsWith('fav-')) {
        const label = node instanceof RepoNode ? path.basename(node.repoPath) : node.entry.name;
        const answer = await vscode.window.showWarningMessage(
          `Remove "${label}" from favorites?`,
          'Remove',
        );
        if (answer !== 'Remove') return;
      }
      store.toggleFavorite(node instanceof RepoNode ? node.repoPath : node.entry.path);
    }),
    vscode.commands.registerCommand('gitsets.addSet', () => addSet(store)),
    vscode.commands.registerCommand('gitsets.openSet', (node?: SetNode) => openSet(node)),
    vscode.commands.registerCommand('gitsets.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:seanodell.git-sets'),
    ),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(`${CONFIG_SECTION}.rootFolder`)) {
        resetWatchers();
        store.refresh();
      }
    }),
    { dispose: () => { watchers.forEach(d => d.dispose()); watchers = []; } },
  );
}

export function deactivate() {}

// --- Discovery ---------------------------------------------------------------

function getRootFolder(): string | undefined {
  const configured = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('rootFolder', '');
  const trimmed = configured.trim();
  return trimmed ? resolveRoot(trimmed) : undefined;
}

// VS Code does not expand these shorthands for settings read through the extension API.
function resolveRoot(value: string): string {
  let p = value.trim();
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  p = p.replace(/\$\{userHome\}/g, os.homedir());
  p = p.replace(/\$\{env:([^}]+)\}/g, (_, name) => process.env[name] ?? '');
  return p;
}

interface ScanResult {
  repos: string[];
  sets: string[];
}

// Walk rootFolder up to maxDepth levels, collecting git repository roots
// (directories with a .git directory) and git sets (directories with a
// gitsets.json file). Stops descending once a directory is classified.
// Skips hidden directories and linked worktrees (.git file, not directory).
async function scanRoots(rootFolder: string, maxDepth = 3): Promise<ScanResult> {
  const repos: string[] = [];
  const sets: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some(e => e.isFile() && e.name === GITSETS_FILE)) {
      sets.push(dir);
      return;
    }

    const gitEntry = entries.find(e => e.name === '.git');
    if (gitEntry) {
      if (gitEntry.isDirectory()) repos.push(dir);
      return;
    }

    await Promise.all(
      entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => walk(path.join(dir, e.name), depth + 1)),
    );
  }

  await walk(rootFolder, 0);
  repos.sort();
  sets.sort();
  return { repos, sets };
}

// --- Repositories ------------------------------------------------------------

// Open a repository in place, on whatever branch it currently sits on. The repo
// is opened through a sibling `<basename>.code-workspace`, created on first
// open and reconciled on reopen so the repo's folder is always listed — never
// touching git state.
async function openRepository(node?: RepoNode): Promise<void> {
  if (!node) return;

  const repoPath = node.repoPath;
  const parent = path.dirname(repoPath);
  const base = path.basename(repoPath);
  const fileName = `${base}.code-workspace`;
  const wsPath = path.join(parent, fileName);

  let raw: string | undefined;
  try {
    raw = await fs.readFile(wsPath, 'utf8');
  } catch (err) {
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
    const present = folders.some(
      f => typeof f.path === 'string' && path.resolve(parent, f.path) === repoPath,
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

type RepoPickItem = vscode.QuickPickItem & { repo?: string };

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

async function writeCodeWorkspace(dir: string, fileName: string, folders: string[]): Promise<void> {
  const content = { folders: folders.map(f => ({ path: f })) };
  await fs.writeFile(path.join(dir, fileName), JSON.stringify(content, null, 2) + '\n', 'utf8');
}

async function findWorkspaceFile(setFolder: string): Promise<string | undefined> {
  try {
    const entries = await fs.readdir(setFolder);
    const wsFile = entries.find((e: string) => e.endsWith('.code-workspace'));
    return wsFile ? path.join(setFolder, wsFile) : undefined;
  } catch {
    return undefined;
  }
}

async function readWorkspaceFolders(setFolder: string): Promise<string[] | undefined> {
  const wsPath = await findWorkspaceFile(setFolder);
  if (!wsPath) return undefined;
  try {
    const raw = await fs.readFile(wsPath, 'utf8');
    const parsed = JSON.parse(raw) as { folders?: { path?: string }[] };
    return (parsed.folders ?? [])
      .map(f => f.path)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
  } catch {
    return undefined;
  }
}

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

async function openSet(node?: SetNode): Promise<void> {
  if (!node) return;
  const wsPath = await findWorkspaceFile(node.entry.path);
  if (!wsPath) {
    vscode.window.showErrorMessage(`No .code-workspace found in "${node.entry.path}".`);
    return;
  }
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsPath), { forceNewWindow: true });
}

async function addSet(store: GitSetsStore): Promise<void> {
  const rootFolder = getRootFolder();
  if (!rootFolder) {
    vscode.window.showErrorMessage('Configure gitsets.rootFolder in settings before creating a set.');
    return;
  }

  const { repos: repoPaths } = await scanRoots(rootFolder);
  if (repoPaths.length === 0) {
    vscode.window.showErrorMessage(`No git repositories found in "${rootFolder}".`);
    return;
  }

  // 1. Name (also the branch and folder path; "/" allowed for hierarchy).
  const name = await vscode.window.showInputBox({
    title: 'New Set',
    prompt: 'Set name — used as the branch name and folder path. "/" creates hierarchy.',
    placeHolder: 'e.g. feature/login-bug',
    validateInput: validateSetName,
  });
  if (name === undefined) return;
  const setName = name.trim();

  // 2. Repositories (multi-select from discovered repos, shown as folder tree).
  const repoPicks = await vscode.window.showQuickPick<RepoPickItem>(
    buildRepoPicks(repoPaths, rootFolder),
    {
      canPickMany: true,
      title: 'New Set — Repositories',
      placeHolder: 'Select one or more repositories for the set',
    },
  );
  if (!repoPicks || repoPicks.length === 0) return;
  // Separator items cannot be selected; every returned item has repo defined.
  const picks = repoPicks.filter((p): p is RepoPickItem & { repo: string } => p.repo !== undefined);
  if (picks.length === 0) return;

  const basenames = picks.map(p => path.basename(p.repo));
  if (new Set(basenames).size !== basenames.length) {
    vscode.window.showErrorMessage(
      'Selected repositories have duplicate folder names; they cannot share one set folder.',
    );
    return;
  }

  const setFolder = path.join(rootFolder, ...setName.split('/'));

  try {
    await fs.access(setFolder);
    vscode.window.showErrorMessage(`A folder already exists at: ${setFolder}`);
    return;
  } catch {
    // Expected: folder does not yet exist.
  }

  await fs.mkdir(setFolder, { recursive: true });

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

  const leaf = setName.split('/').pop() ?? setName;
  const workspaceFile = `${leaf}.code-workspace`;
  await writeGitSet(setFolder, { name: setName });
  await writeCodeWorkspace(setFolder, workspaceFile, worktrees);
  store.refresh();

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

// --- Store -------------------------------------------------------------------

class GitSetsStore {
  private _scanPromise: Promise<ScanResult> | undefined;
  private _favorites: Set<string>;
  private readonly _onChange = new vscode.EventEmitter<void>();
  readonly onChange = this._onChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this._favorites = new Set(context.globalState.get<string[]>('gitsets.favorites', []));
  }

  get favorites(): ReadonlySet<string> { return this._favorites; }

  scan(): Promise<ScanResult> {
    if (!this._scanPromise) {
      const rootFolder = getRootFolder();
      this._scanPromise = rootFolder
        ? scanRoots(rootFolder)
        : Promise.resolve({ repos: [], sets: [] });
    }
    return this._scanPromise;
  }

  async toggleFavorite(itemPath: string): Promise<void> {
    if (this._favorites.has(itemPath)) {
      this._favorites.delete(itemPath);
    } else {
      this._favorites.add(itemPath);
    }
    await this.context.globalState.update('gitsets.favorites', [...this._favorites]);
    this.refresh();
  }

  refresh(): void {
    this._scanPromise = undefined;
    this._onChange.fire();
  }
}

// --- Tree providers ----------------------------------------------------------

type TreeNode = RepoNode | RepoGroupNode | SetNode | SetGroupNode | SetMemberNode | MessageNode;

class FavoritesProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: GitSetsStore) {
    store.onChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: TreeNode): vscode.TreeItem { return element; }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element instanceof SetNode) return getSetMembers(element);
    if (element) return [];
    if (!getRootFolder()) return [];
    const { repos, sets } = await this.store.scan();
    const entries = await loadSetEntries(sets);
    const favRepos = repos.filter(r => this.store.favorites.has(r));
    const favSets = entries.filter(e => this.store.favorites.has(e.path));
    if (favRepos.length === 0 && favSets.length === 0) {
      return [new MessageNode('No favorites yet — click ♥ on a repo or set', 'heart', 'msg:no-favorites')];
    }
    return [
      ...favRepos.map(r => new RepoNode(r, path.basename(r), true, true)),
      ...favSets.map(e => new SetNode(e, path.basename(e.path), true, true)),
    ];
  }
}

class ReposProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: GitSetsStore) {
    store.onChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: TreeNode): vscode.TreeItem { return element; }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element instanceof RepoGroupNode) {
      return renderRepoLevel(element.prefix, element.subtree, this.store.favorites);
    }
    if (element) return [];
    if (!getRootFolder()) {
      return [new MessageNode('Configure gitsets.rootFolder in settings', 'gear', 'msg:no-root')];
    }
    const { repos } = await this.store.scan();
    return renderRepoLevel([], buildPathTree(repos), this.store.favorites);
  }
}

class SetsProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: GitSetsStore) {
    store.onChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: TreeNode): vscode.TreeItem { return element; }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element instanceof SetGroupNode) {
      const { sets } = await this.store.scan();
      const entries = await loadSetEntries(sets);
      return renderSetLevel(element.prefix, element.subtree, entries, this.store.favorites);
    }
    if (element instanceof SetNode) return getSetMembers(element);
    if (element) return [];
    if (!getRootFolder()) {
      return [new MessageNode('Configure gitsets.rootFolder in settings', 'gear', 'msg:no-root')];
    }
    const { sets } = await this.store.scan();
    const entries = await loadSetEntries(sets);
    return renderSetLevel([], buildPathTree(sets), entries, this.store.favorites);
  }
}

async function loadSetEntries(setPaths: string[]): Promise<SetEntry[]> {
  return Promise.all(
    setPaths.map(async setPath => {
      const gitSet = await readGitSet(setPath);
      return gitSet
        ? { path: setPath, name: gitSet.name, broken: false }
        : { path: setPath, name: path.basename(setPath), broken: true };
    }),
  );
}

async function getSetMembers(node: SetNode): Promise<TreeNode[]> {
  const folders = await readWorkspaceFolders(node.entry.path);
  if (!folders) {
    return [new MessageNode('workspace file missing or invalid', 'warning', `msg:${node.entry.path}`)];
  }
  return folders.map(rel => new SetMemberNode(path.basename(rel), path.join(node.entry.path, rel)));
}

// --- Tree nodes --------------------------------------------------------------

class RepoNode extends vscode.TreeItem {
  constructor(public readonly repoPath: string, label = path.basename(repoPath), favorited = false, inFavoritesSection = false) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = `${inFavoritesSection ? 'fav-' : ''}repo:${repoPath}`;
    this.description = repoPath;
    this.tooltip = repoPath;
    this.iconPath = new vscode.ThemeIcon('repo', new vscode.ThemeColor('notificationsInfoIcon.foreground'));
    this.contextValue = favorited ? 'repository.favorited' : 'repository';
    this.resourceUri = vscode.Uri.file(repoPath);
  }
}

class RepoGroupNode extends vscode.TreeItem {
  constructor(public readonly prefix: string[], public readonly subtree: PathTree) {
    super(prefix[prefix.length - 1], vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `repogroup:${subtree.root}:${prefix.join('/')}`;
    this.contextValue = 'repoGroup';
  }
}

class SetGroupNode extends vscode.TreeItem {
  constructor(public readonly prefix: string[], public readonly subtree: PathTree) {
    super(prefix[prefix.length - 1], vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `setgroup:${subtree.root}:${prefix.join('/')}`;
    this.contextValue = 'setGroup';
  }
}

class SetNode extends vscode.TreeItem {
  constructor(public readonly entry: SetEntry, label = path.basename(entry.path), favorited = false, inFavoritesSection = false) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `${inFavoritesSection ? 'fav-' : ''}set:${entry.path}`;
    this.description = entry.path;
    this.tooltip = entry.broken ? `${entry.path}\n(gitsets.json missing or invalid)` : entry.path;
    if (entry.broken) this.iconPath = new vscode.ThemeIcon('warning');
    this.contextValue = favorited ? 'set.favorited' : 'set';
    this.resourceUri = vscode.Uri.file(entry.path);
  }
}

class SetMemberNode extends vscode.TreeItem {
  constructor(label: string, worktreePath: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = `setmember:${worktreePath}`;
    this.description = worktreePath;
    this.tooltip = worktreePath;
    this.iconPath = new vscode.ThemeIcon('git-branch', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
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

// --- Tree rendering ----------------------------------------------------------

function renderRepoLevel(prefix: string[], tree: PathTree, favorites: ReadonlySet<string>): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const [seg, sub] of Object.entries(tree.groups)) {
    nodes.push(new RepoGroupNode([...prefix, seg], sub));
  }
  for (const name of tree.leaves) {
    const repoPath = path.join(tree.root, ...prefix, name);
    nodes.push(new RepoNode(repoPath, name, favorites.has(repoPath)));
  }
  return nodes;
}

function renderSetLevel(prefix: string[], tree: PathTree, entries: SetEntry[], favorites: ReadonlySet<string>): TreeNode[] {
  const byPath = new Map(entries.map(e => [e.path, e]));
  const nodes: TreeNode[] = [];
  for (const [seg, sub] of Object.entries(tree.groups)) {
    nodes.push(new SetGroupNode([...prefix, seg], sub));
  }
  for (const name of tree.leaves) {
    const entry = byPath.get(path.join(tree.root, ...prefix, name));
    if (entry) nodes.push(new SetNode(entry, name, favorites.has(entry.path)));
  }
  return nodes;
}

function buildRepoPicks(repoPaths: string[], root: string): RepoPickItem[] {
  if (repoPaths.length === 0) return [];

  const rootLevel: string[] = [];
  const groups = new Map<string, string[]>();

  for (const repoPath of repoPaths) {
    const segs = path.relative(root, repoPath).split(path.sep).filter(Boolean);
    if (segs.length === 1) {
      rootLevel.push(repoPath);
    } else {
      const groupKey = segs.slice(0, -1).join('/');
      const bucket = groups.get(groupKey);
      if (bucket) bucket.push(repoPath);
      else groups.set(groupKey, [repoPath]);
    }
  }

  const items: RepoPickItem[] = [];

  for (const repoPath of rootLevel.sort()) {
    items.push({ label: path.basename(repoPath), description: repoPath, repo: repoPath });
  }

  for (const [groupKey, repos] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    items.push({ label: groupKey, kind: vscode.QuickPickItemKind.Separator });
    for (const repoPath of [...repos].sort()) {
      items.push({ label: path.basename(repoPath), description: groupKey, repo: repoPath });
    }
  }

  return items;
}

// --- util --------------------------------------------------------------------

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
