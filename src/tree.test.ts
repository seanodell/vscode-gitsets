import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildPathTree, commonDirPrefix, PathTree } from './tree.js';

// ---------------------------------------------------------------------------
// commonDirPrefix cases
// ---------------------------------------------------------------------------

interface PrefixCase {
  name: string;
  paths: string[];
  expected: string;
}

const prefixCases: PrefixCase[] = [
  {
    name: 'empty list',
    paths: [],
    expected: '/',
  },
  {
    name: 'single path',
    paths: ['/a/b/c'],
    expected: '/a/b',
  },
  {
    name: 'flat siblings under same parent',
    paths: ['/a/b/c', '/a/b/d'],
    expected: '/a/b',
  },
  {
    name: 'siblings two levels deep',
    paths: ['/a/b/c', '/a/b/d', '/a/b/e'],
    expected: '/a/b',
  },
  {
    name: 'different second-level dirs',
    paths: ['/a/b/c', '/a/x/y'],
    expected: '/a',
  },
  {
    name: 'no common prefix beyond root',
    paths: ['/a/b/c', '/d/e/f'],
    expected: '/',
  },
  {
    name: 'deeply nested common ancestor',
    paths: ['/home/user/dev/projectA', '/home/user/dev/projectB'],
    expected: '/home/user/dev',
  },
];

describe('commonDirPrefix', () => {
  for (const c of prefixCases) {
    it(c.name, () => {
      assert.equal(commonDirPrefix(c.paths), c.expected);
    });
  }
});

// ---------------------------------------------------------------------------
// buildPathTree cases
// ---------------------------------------------------------------------------

interface TreeCase {
  name: string;
  paths: string[];
  expected: PathTree;
}

// Leaves contain only the final path component (the display name).
// The full path of any leaf is path.join(root, ...groupKeys, leafName).
// Groups are keyed by the intermediate directory name shown in the UI.
const treeCases: TreeCase[] = [
  {
    name: 'empty list',
    paths: [],
    expected: { root: '/', groups: {}, leaves: [] },
  },
  {
    name: 'single item — root is its parent, leaf is its name',
    paths: ['/a/b/c'],
    expected: { root: '/a/b', groups: {}, leaves: ['c'] },
  },
  {
    name: 'flat siblings under the same parent — no groups',
    paths: ['/a/b/c', '/a/b/d'],
    expected: { root: '/a/b', groups: {}, leaves: ['c', 'd'] },
  },
  {
    name: 'single-child dir collapses into a combined leaf name',
    paths: ['/a/b/c', '/a/b/d/e'],
    // 'd' only has one item so no folder node — displayed as leaf 'd/e'
    expected: { root: '/a/b', groups: {}, leaves: ['c', 'd/e'] },
  },
  {
    name: 'all items share a deep common parent — flat, no groups',
    paths: ['/a/b/c/d', '/a/b/c/e'],
    // commonDirPrefix resolves to /a/b/c so d and e are direct leaves
    expected: { root: '/a/b/c', groups: {}, leaves: ['d', 'e'] },
  },
  {
    name: 'dir with multiple items becomes a folder node',
    paths: ['/a/b/c', '/a/b/d/e', '/a/b/d/f'],
    // 'd' has two items so it stays as a group
    expected: {
      root: '/a/b',
      groups: { d: { root: '/a/b', groups: {}, leaves: ['e', 'f'] } },
      leaves: ['c'],
    },
  },
  {
    name: 'single-child group collapses; multi-child group stays',
    paths: ['/a/b/g1/x', '/a/b/g1/y', '/a/b/g2/z'],
    // g1 has 2 items → folder node; g2 has 1 item → collapses to leaf 'g2/z'
    expected: {
      root: '/a/b',
      groups: { g1: { root: '/a/b', groups: {}, leaves: ['x', 'y'] } },
      leaves: ['g2/z'],
    },
  },
  {
    name: 'all single-child dirs collapse to flat leaves, sorted',
    paths: ['/a/b/z/item', '/a/b/a/item', '/a/b/m/item'],
    expected: { root: '/a/b', groups: {}, leaves: ['a/item', 'm/item', 'z/item'] },
  },
  {
    name: 'leaves are sorted alphabetically',
    paths: ['/a/b/z', '/a/b/a', '/a/b/m'],
    expected: { root: '/a/b', groups: {}, leaves: ['a', 'm', 'z'] },
  },
  {
    name: 'chain of single-child dirs compresses into a deep group key',
    paths: ['/a/b/c/d/e', '/a/b/c/d/f', '/a/b/x/y'],
    // c→d: c has only one child (d) so the folder key compresses to 'c/d'
    // x→y: x has only one item so it collapses to leaf 'x/y'
    expected: {
      root: '/a/b',
      groups: { 'c/d': { root: '/a/b', groups: {}, leaves: ['e', 'f'] } },
      leaves: ['x/y'],
    },
  },
  {
    name: 'single-child dirs at top level collapse to combined leaf names',
    paths: ['/home/dev/projectA', '/home/work/projectB'],
    // Both dev and work each hold exactly one item — no folder nodes needed
    expected: {
      root: '/home',
      groups: {},
      leaves: ['dev/projectA', 'work/projectB'],
    },
  },
];

describe('buildPathTree', () => {
  for (const c of treeCases) {
    it(c.name, () => {
      assert.deepEqual(buildPathTree(c.paths), c.expected);
    });
  }
});
