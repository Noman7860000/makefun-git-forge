// store.ts — the forge's in-memory store: repositories, git objects, refs, issues, pull
// requests, labels and comments. Everything lives in plain Maps; there is no database.
//
// Determinism: every user-visible timestamp comes from a logical clock (a counter off a
// fixed base), never from Date.now(). Two runs that perform the same operations in the
// same order therefore produce the same bytes everywhere it matters.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  diffTrees,
  flattenTree,
  hashObject,
  isAncestor,
  lineDiff,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
} from './gitobjs.ts';

/** The login the trial's bearer token names (the scenario's viewer, fixed by the kit's seed). */
export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export const DEFAULT_BRANCH = 'main';

/** Base of the logical clock: 2026-01-01T00:00:00Z, one second per tick. */
const CLOCK_BASE_UNIX = 1_767_225_600;

export interface Label {
  dbId: number;
  name: string;
  color: string;
  description: string;
  isDefault: boolean;
}

export interface Comment {
  dbId: number;
  nodeId: string;
  body: string;
  author: string;
  createdSeq: number;
  updatedSeq: number;
}

export interface Issue {
  dbId: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  updatedSeq: number;
  closedSeq: number | null;
  author: string;
  isPullRequest: false;
}

export interface Pull {
  dbId: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  merged: boolean;
  mergeable: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
  updatedSeq: number;
  closedSeq: number | null;
  mergedSeq: number | null;
  mergeCommitSha: string | null;
  author: string;
  isPullRequest: true;
}

export interface Repo {
  id: number;
  nodeId: string;
  name: string;
  owner: string;
  fullName: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  updatedSeq: number;
  pushedSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  nextNumber: number;
}

/** The six labels every repository starts with (the scenario's label set). */
export function defaultLabels(startId: number): Label[] {
  const defs: Array<[string, string, string]> = [
    ['bug', 'd73a4a', "Something isn't working"],
    ['enhancement', 'a2eeef', 'New feature or request'],
    ['documentation', '0075ca', 'Improvements or additions to documentation'],
    ['question', 'd876e3', 'Further information is requested'],
    ['good first issue', '7057ff', 'Good for newcomers'],
    ['help wanted', '008672', 'Extra attention is needed'],
  ];
  return defs.map(([name, color, description], index) => ({
    dbId: startId + index,
    name,
    color,
    description,
    isDefault: true,
  }));
}

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const pieces = decoded.split(':');
    if (pieces.length < 2) return null;
    return { kind: pieces[0], parts: pieces.slice(1) };
  } catch {
    return null;
  }
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private clockSeq = 0;
  private nextRepoId = 5000;
  private nextDbId = 100000;
  private nextLabelId = 300000;

  /** Advance the logical clock one second and return the new sequence number. */
  tick(): number {
    this.clockSeq += 1;
    return this.clockSeq;
  }

  isoTime(seq: number): string {
    return new Date((CLOCK_BASE_UNIX + seq) * 1000).toISOString();
  }

  unixTime(seq: number): number {
    return CLOCK_BASE_UNIX + seq;
  }

  /** The git author/committer line for the viewer at a logical time. */
  identLine(seq: number): string {
    return `${VIEWER.name} <${VIEWER.email}> ${this.unixTime(seq)} +0000`;
  }

  nextRepoDbId(): number {
    return this.nextRepoId++;
  }

  nextItemDbId(): number {
    return this.nextDbId++;
  }

  nextLabelDbId(): number {
    return this.nextLabelId++;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  findRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(options: { name: string; description?: string; isPrivate?: boolean; autoInit?: boolean }): Repo {
    const id = this.nextRepoDbId();
    const seq = this.tick();
    const repo: Repo = {
      id,
      nodeId: globalId('Repository', id),
      name: options.name,
      owner: VIEWER.login,
      fullName: `${VIEWER.login}/${options.name}`,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: seq,
      updatedSeq: seq,
      pushedSeq: seq,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: defaultLabels(this.nextLabelDbId()),
      nextNumber: 1,
    };
    // Label ids come from a block: advance the counter past the six defaults.
    this.nextLabelId += 5;
    this.repos.set(this.repoKey(repo.owner, repo.name), repo);
    if (options.autoInit === true) {
      this.commitFile(repo, {
        branch: DEFAULT_BRANCH,
        path: 'README.md',
        content: Buffer.from(`# ${options.name}\n`, 'utf8'),
        message: 'Initial commit',
      });
    }
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  // -------------------------------------------------------------------------------------------
  // git object helpers on a repo
  // -------------------------------------------------------------------------------------------

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid) => repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** All branch names in the repo, sorted. */
  branchNames(repo: Repo): string[] {
    const names: string[] = [];
    for (const ref of repo.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }

  /** When a ref points at an annotated tag, the tag's target commit (else null). */
  tagTarget(repo: Repo, ref: string): { tagOid: string; targetOid: string } | null {
    const oid = repo.refs.get(ref);
    if (oid === undefined) return null;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tag') return null;
    return { tagOid: oid, targetOid: parseTag(object.data).object };
  }

  /**
   * Commit a file change on a branch: build the new tree from the branch tip's tree (or an
   * empty tree), write the blob, tree and commit objects, and move the branch. A branch that
   * does not exist yet is created from the default branch's tip (or from nothing).
   */
  commitFile(repo: Repo, options: { branch: string; path: string; content: Buffer; message: string }): {
    commitSha: string;
    blobSha: string;
    treeSha: string;
  } {
    const seq = this.tick();
    const branchRef = `refs/heads/${options.branch}`;
    const parentTip = repo.refs.get(branchRef) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const parentTree = parentTip === undefined ? null : parseCommit(repo.objects.get(parentTip)!.data).tree;
    const blobSha = this.putObject(repo, 'blob', options.content);
    const treeSha = this.writeTreeWithFile(repo, parentTree, options.path, blobSha);
    const parents = parentTip === undefined ? [] : [parentTip];
    const ident = this.identLine(seq);
    const commitData = buildCommit({ tree: treeSha, parents, author: ident, committer: ident, message: options.message });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(branchRef, commitSha);
    repo.updatedSeq = seq;
    repo.pushedSeq = seq;
    return { commitSha, blobSha, treeSha };
  }

  /**
   * Delete a file on a branch: rebuild the tree without the path and commit. Returns null
   * when the file is not present on the branch.
   */
  deleteFile(repo: Repo, options: { branch: string; path: string; message: string }): { commitSha: string } | null {
    const seq = this.tick();
    const branchRef = `refs/heads/${options.branch}`;
    const parentTip = repo.refs.get(branchRef);
    if (parentTip === undefined) return null;
    const parentTree = parseCommit(repo.objects.get(parentTip)!.data).tree;
    const flat = flattenTree(this.lookup(repo), parentTree);
    if (!flat.has(options.path)) return null;
    const treeSha = this.writeTreeWithoutFile(repo, parentTree, options.path);
    const ident = this.identLine(seq);
    const commitData = buildCommit({ tree: treeSha, parents: [parentTip], author: ident, committer: ident, message: options.message });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(branchRef, commitSha);
    repo.updatedSeq = seq;
    repo.pushedSeq = seq;
    return { commitSha };
  }

  /** Write a tree that is `baseTree` with `path` set to `blobSha` (creating subtrees as needed). */
  writeTreeWithFile(repo: Repo, baseTree: string | null, path: string, blobSha: string): string {
    const segments = path.split('/').filter((segment) => segment !== '');
    return this.writeTreeLevel(repo, baseTree, segments, blobSha);
  }

  private writeTreeLevel(repo: Repo, baseTree: string | null, segments: string[], blobSha: string): string {
    const entries = baseTree === null ? [] : parseTree(repo.objects.get(baseTree)!.data);
    const [head, ...rest] = segments;
    const existing = entries.find((entry) => entry.name === head);
    let newEntries: Array<{ mode: string; name: string; oid: string }>;
    if (rest.length === 0) {
      // Leaf: replace (or add) the blob entry.
      newEntries = entries.filter((entry) => entry.name !== head);
      newEntries.push({ mode: '100644', name: head, oid: blobSha });
    } else {
      // Recurse into (or create) the subtree.
      const subTree = existing !== undefined && existing.mode === '40000' ? existing.oid : null;
      const newSubTree = this.writeTreeLevel(repo, subTree, rest, blobSha);
      newEntries = entries.filter((entry) => entry.name !== head);
      newEntries.push({ mode: '40000', name: head, oid: newSubTree });
    }
    return this.putObject(repo, 'tree', buildTree(newEntries));
  }

  /** Write a tree that is `baseTree` with `path` removed (pruning empty subtrees). */
  writeTreeWithoutFile(repo: Repo, baseTree: string, path: string): string {
    const segments = path.split('/').filter((segment) => segment !== '');
    return this.removeTreeLevel(repo, baseTree, segments);
  }

  private removeTreeLevel(repo: Repo, baseTree: string, segments: string[]): string {
    const entries = parseTree(repo.objects.get(baseTree)!.data);
    const [head, ...rest] = segments;
    let newEntries: Array<{ mode: string; name: string; oid: string }>;
    if (rest.length === 0) {
      newEntries = entries.filter((entry) => entry.name !== head);
    } else {
      const existing = entries.find((entry) => entry.name === head);
      if (existing === undefined || existing.mode !== '40000') return baseTree;
      const newSubTree = this.removeTreeLevel(repo, existing.oid, rest);
      newEntries = entries.filter((entry) => entry.name !== head);
      // Keep the subtree only when it still holds entries.
      if (parseTree(repo.objects.get(newSubTree)!.data).length > 0) {
        newEntries.push({ mode: '40000', name: head, oid: newSubTree });
      }
    }
    return this.putObject(repo, 'tree', buildTree(newEntries));
  }

  /** The blob a path resolves to at a tree, or null. */
  blobAtPath(repo: Repo, treeOid: string, path: string): { oid: string; mode: string } | null {
    const flat = flattenTree(this.lookup(repo), treeOid);
    return flat.get(path) ?? null;
  }

  /** Commits reachable from a ref, newest first (breadth-first from the tip). */
  listCommits(repo: Repo, ref: string): Array<{ sha: string; commit: ReturnType<typeof parseCommit> }> {
    const tip = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`);
    if (tip === undefined) return [];
    const lookup = this.lookup(repo);
    const seen = new Set<string>();
    const order: string[] = [];
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      const object = lookup(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      order.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return order.map((sha) => ({ sha, commit: parseCommit(lookup(sha)!.data) }));
  }

  // -------------------------------------------------------------------------------------------
  // issues and pull requests
  // -------------------------------------------------------------------------------------------

  createIssue(repo: Repo, options: { title: string; body?: string; labels?: string[] }): Issue {
    const seq = this.tick();
    const dbId = this.nextItemDbId();
    const number = repo.nextNumber++;
    const issue: Issue = {
      dbId,
      nodeId: globalId('Issue', repo.id, number),
      number,
      title: options.title,
      body: options.body ?? '',
      state: 'open',
      labels: options.labels ?? [],
      comments: [],
      createdSeq: seq,
      updatedSeq: seq,
      closedSeq: null,
      author: VIEWER.login,
      isPullRequest: false,
    };
    repo.issues.push(issue);
    repo.updatedSeq = seq;
    return issue;
  }

  findIssue(repo: Repo, number: number): Issue | Pull | undefined {
    const issue = repo.issues.find((entry) => entry.number === number);
    if (issue !== undefined) return issue;
    return repo.pulls.find((entry) => entry.number === number);
  }

  createPull(repo: Repo, options: { title: string; head: string; base: string; body?: string }): Pull | { error: string } {
    const headSha = this.branchTip(repo, options.head);
    const baseSha = this.branchTip(repo, options.base);
    if (headSha === undefined) return { error: `head branch ${options.head} does not exist` };
    if (baseSha === undefined) return { error: `base branch ${options.base} does not exist` };
    const seq = this.tick();
    const dbId = this.nextItemDbId();
    const number = repo.nextNumber++;
    const lookup = this.lookup(repo);
    const base = mergeBase(lookup, headSha, baseSha);
    const mergeable = this.pullMergeable(repo, headSha, baseSha, base);
    const pull: Pull = {
      dbId,
      nodeId: globalId('PullRequest', repo.id, number),
      number,
      title: options.title,
      body: options.body ?? '',
      state: 'open',
      merged: false,
      mergeable,
      headRef: options.head,
      baseRef: options.base,
      headSha,
      baseSha,
      createdSeq: seq,
      updatedSeq: seq,
      closedSeq: null,
      mergedSeq: null,
      mergeCommitSha: null,
      author: VIEWER.login,
      isPullRequest: true,
    };
    repo.pulls.push(pull);
    repo.updatedSeq = seq;
    return pull;
  }

  /** Whether a squash merge of head into base would apply cleanly (no overlapping change). */
  pullMergeable(repo: Repo, headSha: string, baseSha: string, base: string | null): boolean {
    if (base === null) return false;
    const lookup = this.lookup(repo);
    const headTree = parseCommit(lookup(headSha)!.data).tree;
    const baseTree = parseCommit(lookup(base)!.data).tree;
    const tipTree = parseCommit(lookup(baseSha)!.data).tree;
    const headChanges = diffTrees(lookup, baseTree, headTree);
    const tipChanges = diffTrees(lookup, baseTree, tipTree);
    const tipByPath = new Map(tipChanges.map((change) => [change.path, change]));
    for (const change of headChanges) {
      const tipChange = tipByPath.get(change.path);
      if (tipChange === undefined) continue;
      if (tipChange.newOid !== change.newOid) return false;
    }
    return true;
  }

  /** The file changes of a pull request (merge-base tree -> head tree), with line counts. */
  pullFiles(repo: Repo, pull: Pull): Array<{
    path: string;
    status: 'added' | 'removed' | 'modified';
    additions: number;
    deletions: number;
    changes: number;
  }> {
    const lookup = this.lookup(repo);
    const base = mergeBase(lookup, pull.headSha, pull.baseSha) ?? pull.baseSha;
    const baseTree = parseCommit(lookup(base)!.data).tree;
    const headTree = parseCommit(lookup(pull.headSha)!.data).tree;
    const out: Array<{ path: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }> = [];
    for (const change of diffTrees(lookup, baseTree, headTree)) {
      const oldText = change.oldOid === null ? '' : lookup(change.oldOid)?.data.toString('utf8') ?? '';
      const newText = change.newOid === null ? '' : lookup(change.newOid)?.data.toString('utf8') ?? '';
      const counts = lineDiff(oldText, newText);
      out.push({
        path: change.path,
        status: change.status,
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
    return out;
  }

  /**
   * Squash-merge a pull request onto its base branch: one new commit on the base tip whose
   * tree is the base tree with the head's net changes applied. Returns the merge commit or
   * a conflict marker. A merged pull request's state becomes 'merged'.
   */
  mergePull(repo: Repo, pull: Pull): { merged: true; sha: string; message: string } | { merged: false; reason: string } {
    if (pull.state === 'merged') return { merged: false, reason: 'already merged' };
    if (pull.state === 'closed') return { merged: false, reason: 'pull request is closed' };
    const lookup = this.lookup(repo);
    const baseTip = this.branchTip(repo, pull.baseRef);
    const headTip = this.branchTip(repo, pull.headRef);
    if (baseTip === undefined || headTip === undefined) return { merged: false, reason: 'branch not found' };
    const base = mergeBase(lookup, headTip, baseTip);
    if (base === null) return { merged: false, reason: 'no merge base' };
    if (!this.pullMergeable(repo, headTip, baseTip, base)) return { merged: false, reason: 'merge conflict' };
    const seq = this.tick();
    const baseTree = parseCommit(lookup(baseTip)!.data).tree;
    const mergeBaseTree = parseCommit(lookup(base)!.data).tree;
    const headTree = parseCommit(lookup(headTip)!.data).tree;
    // Apply the head's net changes (vs the merge base) onto the base tip's tree.
    let treeOid = baseTree;
    const changes = diffTrees(lookup, mergeBaseTree, headTree);
    for (const change of changes) {
      if (change.status === 'removed') {
        treeOid = this.writeTreeWithoutFile(repo, treeOid, change.path);
      } else {
        treeOid = this.writeTreeWithFile(repo, treeOid, change.path, change.newOid!);
      }
    }
    const ident = this.identLine(seq);
    const message = `${pull.title} (#${pull.number})`;
    const commitData = buildCommit({ tree: treeOid, parents: [baseTip], author: ident, committer: ident, message });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
    pull.state = 'merged';
    pull.merged = true;
    pull.mergeable = false;
    pull.mergedSeq = seq;
    pull.mergeCommitSha = commitSha;
    pull.updatedSeq = seq;
    repo.updatedSeq = seq;
    repo.pushedSeq = seq;
    return { merged: true, sha: commitSha, message };
  }

  /** Every object reachable from a repo's refs (used by the clone workload's setup, not by checks). */
  repoObjectCount(repo: Repo): number {
    return repo.objects.size;
  }
}

export { collectReachable, isAncestor };
