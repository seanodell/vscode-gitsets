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
  const provider = new GitSetsProvider();

  // Watchers are scoped to the configured root folder and recreated when it
  // changes. Stored outside subscriptions so they can be disposed on reset.
  let watchers: vscode.Disposable[] = [];

  function resetWatchers(): void {
    watchers.forEach(d => d.dispose());
    watchers = [];
    const rootFolder = getRootFolder();
    if (!rootFolder) return;
    const base = vscode.Uri.file(rootFolder);
    const refresh = () => provider.refresh();
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

  const treeView = vscode.window.createTreeView('gitsets.view', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand('gitsets.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('gitsets.expandAll', async () => {
      if (!getRootFolder()) return;
      await treeView.reveal(provider.reposSection, { expand: 3 });
      await treeView.reveal(provider.setsSection, { expand: 3 });
    }),
    vscode.commands.registerCommand('gitsets.openRepository', (node?: RepoNode) => openRepository(node)),
    vscode.commands.registerCommand('gitsets.addSet', () => addSet(provider)),
    vscode.commands.registerCommand('gitsets.openSet', (node?: SetNode) => openSet(node)),
    vscode.commands.registerCommand('gitsets.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:seanodell.git-sets'),
    ),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(`${CONFIG_SECTION}.rootFolder`)) {
        resetWatchers();
        provider.refresh();
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

async function addSet(provider: GitSetsProvider): Promise<void> {
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

  // 2. Repositories (multi-select from discovered repos).
  const picks = await vscode.window.showQuickPick(
    repoPaths.map(repo => ({ label: path.basename(repo), description: repo, repo })),
    {
      canPickMany: true,
      title: 'New Set — Repositories',
      placeHolder: 'Select one or more repositories for the set',
    },
  );
  if (!picks || picks.length === 0) return;

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

// --- Tree --------------------------------------------------------------------

type TreeNode = SectionNode | RepoNode | RepoGroupNode | SetGroupNode | SetNode | SetMemberNode | MessageNode;

class GitSetsProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // Stable references required by TreeView.reveal(), which matches by identity.
  readonly reposSection = new SectionNode('repos');
  readonly setsSection = new SectionNode('sets');

  // Cached per refresh cycle; cleared by refresh() so the next render rescans.
  private _scanPromise: Promise<ScanResult> | undefined;

  refresh(): void {
    this._scanPromise = undefined;
    this._onDidChangeTreeData.fire();
  }

  scan(): Promise<ScanResult> {
    if (!this._scanPromise) {
      const rootFolder = getRootFolder();
      this._scanPromise = rootFolder
        ? scanRoots(rootFolder)
        : Promise.resolve({ repos: [], sets: [] });
    }
    return this._scanPromise;
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  // Required by TreeView.reveal(). Section nodes are roots so their parent is
  // undefined; we only ever reveal section nodes so this is sufficient.
  getParent(_element: TreeNode): undefined {
    return undefined;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      if (!getRootFolder()) {
        return [new MessageNode('Configure gitsets.rootFolder in settings', 'gear', 'msg:no-root')];
      }
      return [this.reposSection, this.setsSection];
    }

    if (element instanceof SectionNode) {
      const { repos, sets } = await this.scan();
      if (element.section === 'repos') {
        const tree = buildPathTree(repos);
        return renderRepoLevel([], tree);
      }
      const entries = await loadSetEntries(sets);
      const tree = buildPathTree(sets);
      return renderSetLevel([], tree, entries);
    }

    if (element instanceof RepoGroupNode) {
      return renderRepoLevel(element.prefix, element.subtree);
    }

    if (element instanceof SetGroupNode) {
      const { sets } = await this.scan();
      const entries = await loadSetEntries(sets);
      return renderSetLevel(element.prefix, element.subtree, entries);
    }

    if (element instanceof SetNode) {
      const folders = await readWorkspaceFolders(element.entry.path);
      if (!folders) {
        return [new MessageNode('workspace file missing or invalid', 'warning', `msg:${element.entry.path}`)];
      }
      return folders.map(rel => new SetMemberNode(path.basename(rel), path.join(element.entry.path, rel)));
    }

    return [];
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

class SectionNode extends vscode.TreeItem {
  constructor(public readonly section: 'repos' | 'sets') {
    const isRepos = section === 'repos';
    super(isRepos ? 'Repositories' : 'Sets', vscode.TreeItemCollapsibleState.Expanded);
    this.id = `section:${section}`;
    this.contextValue = isRepos ? 'reposSection' : 'setsSection';
  }
}

class RepoNode extends vscode.TreeItem {
  constructor(public readonly repoPath: string, label = path.basename(repoPath)) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = `repo:${repoPath}`;
    this.description = repoPath;
    this.tooltip = repoPath;
    this.iconPath = new vscode.ThemeIcon('repo', new vscode.ThemeColor('notificationsInfoIcon.foreground'));
    this.contextValue = 'repository';
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
  constructor(public readonly entry: SetEntry, label = path.basename(entry.path)) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `set:${entry.path}`;
    this.description = entry.path;
    this.tooltip = entry.broken ? `${entry.path}\n(gitsets.json missing or invalid)` : entry.path;
    if (entry.broken) this.iconPath = new vscode.ThemeIcon('warning');
    this.contextValue = 'set';
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

// --- tree rendering ----------------------------------------------------------

function renderRepoLevel(prefix: string[], tree: PathTree): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const [seg, sub] of Object.entries(tree.groups)) {
    nodes.push(new RepoGroupNode([...prefix, seg], sub));
  }
  for (const name of tree.leaves) {
    nodes.push(new RepoNode(path.join(tree.root, ...prefix, name), name));
  }
  return nodes;
}

function renderSetLevel(prefix: string[], tree: PathTree, entries: SetEntry[]): TreeNode[] {
  const byPath = new Map(entries.map(e => [e.path, e]));
  const nodes: TreeNode[] = [];
  for (const [seg, sub] of Object.entries(tree.groups)) {
    nodes.push(new SetGroupNode([...prefix, seg], sub));
  }
  for (const name of tree.leaves) {
    const entry = byPath.get(path.join(tree.root, ...prefix, name));
    if (entry) nodes.push(new SetNode(entry, name));
  }
  return nodes;
}

// --- util --------------------------------------------------------------------

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
