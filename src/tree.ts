import * as path from 'node:path';

export interface PathTree {
  root: string;
  // Keys are display names for folder nodes (may be multi-segment like "a/b"
  // when a chain of single-child directories has been compressed).
  groups: Record<string, PathTree>;
  // Display names of leaf items at this level (may be multi-segment like
  // "dev/projectA" when a single-child chain collapsed into one entry).
  leaves: string[];
}

// Build a PathTree from an array of absolute paths. The common ancestor
// directory of all paths becomes the root; items that share an intermediate
// directory are grouped under it. Groups and leaves are both sorted.
export function buildPathTree(paths: string[]): PathTree {
  if (paths.length === 0) {
    return { root: path.sep, groups: {}, leaves: [] };
  }
  const root = commonDirPrefix(paths);
  return buildLevel(root, paths, []);
}

function buildLevel(root: string, paths: string[], prefix: string[]): PathTree {
  const depth = prefix.length;
  const groupNames = new Set<string>();
  const leaves: string[] = [];

  for (const p of paths) {
    const segs = path.relative(root, p).split(path.sep).filter(Boolean);
    if (segs.length <= depth) continue;
    if (!prefix.every((s, i) => segs[i] === s)) continue;
    if (segs.length === depth + 1) {
      leaves.push(segs[depth]);
    } else {
      groupNames.add(segs[depth]);
    }
  }

  const groups: Record<string, PathTree> = {};
  for (const name of [...groupNames].sort()) {
    const sub = buildLevel(root, paths, [...prefix, name]);
    const subKeys = Object.keys(sub.groups);
    if (sub.leaves.length === 0 && subKeys.length === 1) {
      // Single sub-group, no leaves: compress the chain into a deeper key.
      // "a" containing only "b" becomes group key "a/b".
      groups[path.join(name, subKeys[0])] = sub.groups[subKeys[0]];
    } else if (sub.leaves.length === 1 && subKeys.length === 0) {
      // Single leaf, no sub-groups: fold into a combined leaf name.
      // "dev" containing only "projectA" becomes leaf "dev/projectA".
      leaves.push(path.join(name, sub.leaves[0]));
    } else {
      groups[name] = sub;
    }
  }

  return { root, groups, leaves: leaves.sort() };
}

// Returns the longest common parent directory shared by all paths.
// Single path → its parent. Multiple paths → deepest common ancestor directory.
export function commonDirPrefix(paths: string[]): string {
  if (paths.length === 0) return path.sep;
  if (paths.length === 1) return path.dirname(paths[0]);
  const parts = paths.map((p) => p.split(path.sep));
  // Exclude the leaf component of the shortest path so we never return an
  // item's own directory as the prefix when all items share one parent.
  const minLen = Math.min(...parts.map((p) => p.length - 1));
  let i = 0;
  while (i < minLen && parts.every((p) => p[i] === parts[0][i])) {
    i++;
  }
  return parts[0].slice(0, i).join(path.sep) || path.sep;
}
