// rest.ts — GitHub REST v3: repositories, branches, commits, contents, issues, comments,
// labels, pull requests and the Git Data refs API. Every reply is application/json with a
// non-empty X-GitHub-Request-Id (added by the server layer); errors are {message}.

import { mergeBase, parseCommit, parseTree } from './gitobjs.ts';
import {
  Forge,
  VIEWER,
  globalId,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';

export interface RestRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer | null;
  baseUrl: string;
}

export interface RestResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const json = (status: number, value: unknown, extraHeaders: Record<string, string> = {}): RestResult => ({
  status,
  headers: { 'content-type': 'application/json', 'x-oauth-scopes': 'repo, read:org', ...extraHeaders },
  body: JSON.stringify(value),
});

const error = (status: number, message: string): RestResult => json(status, { message });

function parseBody(request: RestRequest): { ok: true; value: unknown } | { ok: false; result: RestResult } {
  if (request.body === null || request.body.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(request.body.toString('utf8')) };
  } catch {
    return { ok: false, result: error(400, 'Problems parsing JSON') };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(body: unknown, field: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------------------------
// serializers
// ---------------------------------------------------------------------------------------------

function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: login === VIEWER.login ? VIEWER.id : 0,
    node_id: globalId('User', login),
    avatar_url: '',
    gravatar_id: '',
    url: '',
    html_url: '',
    type: 'User',
    site_admin: false,
  };
}

function repoJson(forge: Forge, repo: Repo, baseUrl: string): Record<string, unknown> {
  const openCount = repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: forge.isoTime(repo.createdSeq),
    updated_at: forge.isoTime(repo.updatedSeq),
    pushed_at: forge.isoTime(repo.pushedSeq),
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openCount,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `${baseUrl}/${repo.owner}/${repo.name}.git`,
    git_url: `${baseUrl}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.invalid:${repo.owner}/${repo.name}.git`,
  };
}

function labelJson(repo: Repo, label: Label, baseUrl: string): Record<string, unknown> {
  return {
    id: label.dbId,
    node_id: globalId('Label', repo.id, label.dbId),
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: label.isDefault,
  };
}

function labelByName(repo: Repo, name: string): Label | undefined {
  return repo.labels.find((label) => label.name.toLowerCase() === name.toLowerCase());
}

function issueJson(forge: Forge, repo: Repo, issue: Issue | Pull, baseUrl: string): Record<string, unknown> {
  const isPull = issue.isPullRequest;
  const labels = issue.isPullRequest ? [] : issue.labels.map((name) => labelByName(repo, name)).filter((label): label is Label => label !== undefined);
  const out: Record<string, unknown> = {
    id: issue.dbId,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: isPull ? (issue.state === 'merged' ? 'closed' : issue.state) : issue.state,
    user: userJson(issue.author),
    labels: labels.map((label) => labelJson(repo, label, baseUrl)),
    assignees: [],
    assignee: null,
    locked: false,
    comments: isPull ? 0 : issue.comments.length,
    created_at: forge.isoTime(issue.createdSeq),
    updated_at: forge.isoTime(issue.updatedSeq),
    closed_at: issue.closedSeq === null ? null : forge.isoTime(issue.closedSeq),
    author_association: 'OWNER',
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
  if (isPull) {
    out.pull_request = {
      url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${issue.number}`,
      html_url: `${baseUrl}/${repo.owner}/${repo.name}/pull/${issue.number}`,
      diff_url: `${baseUrl}/${repo.owner}/${repo.name}/pull/${issue.number}.diff`,
      patch_url: `${baseUrl}/${repo.owner}/${repo.name}/pull/${issue.number}.patch`,
    };
  }
  return out;
}

function commentJson(forge: Forge, repo: Repo, issueNumber: number, comment: Comment, baseUrl: string): Record<string, unknown> {
  return {
    id: comment.dbId,
    node_id: comment.nodeId,
    body: comment.body,
    user: userJson(comment.author),
    created_at: forge.isoTime(comment.createdSeq),
    updated_at: forge.isoTime(comment.updatedSeq),
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.dbId}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.dbId}`,
    author_association: 'OWNER',
  };
}

function liveMergeable(forge: Forge, repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  const headTip = forge.branchTip(repo, pull.headRef);
  const baseTip = forge.branchTip(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return false;
  const base = mergeBase(forge.lookup(repo), headTip, baseTip);
  if (base === null) return false;
  return forge.pullMergeable(repo, headTip, baseTip, base);
}

function pullJson(forge: Forge, repo: Repo, pull: Pull, baseUrl: string): Record<string, unknown> {
  const files = forge.pullFiles(repo, pull);
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const mergeable = liveMergeable(forge, repo, pull);
  return {
    id: pull.dbId,
    node_id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'merged' ? 'closed' : pull.state,
    merged: pull.merged,
    mergeable,
    mergeable_state: pull.state !== 'open' ? 'unknown' : mergeable ? 'clean' : 'dirty',
    draft: false,
    locked: false,
    user: userJson(pull.author),
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: userJson(repo.owner),
      repo: repoJson(forge, repo, baseUrl),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: userJson(repo.owner),
      repo: repoJson(forge, repo, baseUrl),
    },
    created_at: forge.isoTime(pull.createdSeq),
    updated_at: forge.isoTime(pull.updatedSeq),
    closed_at: pull.closedSeq === null && pull.mergedSeq === null ? null : forge.isoTime(pull.closedSeq ?? pull.mergedSeq ?? pull.updatedSeq),
    merged_at: pull.mergedSeq === null ? null : forge.isoTime(pull.mergedSeq),
    merge_commit_sha: pull.mergeCommitSha,
    commits: 1,
    additions,
    deletions,
    changed_files: files.length,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    diff_url: `${baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `${baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    author_association: 'OWNER',
  };
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  // "Ada Iversen <adaiversen@example.invalid> 1763000000 +0000"
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: new Date(0).toISOString() };
  const unix = Number.parseInt(match[3], 10);
  return { name: match[1], email: match[2], date: new Date(unix * 1000).toISOString() };
}

function commitJson(forge: Forge, repo: Repo, sha: string, baseUrl: string): Record<string, unknown> {
  const object = repo.objects.get(sha)!;
  const view = parseCommit(object.data);
  const author = parseIdent(view.author);
  const committer = parseIdent(view.committer);
  return {
    sha,
    node_id: globalId('Commit', repo.id, sha),
    commit: {
      message: view.message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: view.tree },
    },
    author: userJson(author.email === VIEWER.email ? VIEWER.login : author.name),
    committer: userJson(committer.email === VIEWER.email ? VIEWER.login : committer.name),
    parents: view.parents.map((parent) => ({ sha: parent })),
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/commit/${sha}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

function paginate<T>(items: readonly T[], query: URLSearchParams, path: string, baseUrl: string): { page: T[]; link: string | null } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(Math.max(perPageRaw, 1), 100) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(pageRaw, 1) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  const urlFor = (targetPage: number): string => {
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(targetPage));
    return `<${baseUrl}${path}?${params.toString()}>`;
  };
  if (page < totalPages) links.push(`${urlFor(page + 1)}; rel="next"`);
  if (page > 1) links.push(`${urlFor(page - 1)}; rel="prev"`);
  if (totalPages > 1) {
    links.push(`${urlFor(1)}; rel="first"`);
    links.push(`${urlFor(totalPages)}; rel="last"`);
  }
  return { page: [...slice], link: links.length > 0 ? links.join(', ') : null };
}

function linkHeader(result: { link: string | null }): Record<string, string> {
  return result.link === null ? {} : { link: result.link };
}

// ---------------------------------------------------------------------------------------------
// route helpers
// ---------------------------------------------------------------------------------------------

function findRepoOr404(forge: Forge, owner: string, name: string): { repo: Repo } | { result: RestResult } {
  const repo = forge.findRepo(owner, name);
  if (repo === undefined) return { result: error(404, 'Not Found') };
  return { repo };
}

function b64decodeStrict(text: string): Buffer | null {
  const cleaned = text.replace(/[\r\n\t ]+/g, '');
  if (cleaned.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return null;
  try {
    return Buffer.from(cleaned, 'base64');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

export function handleRest(forge: Forge, request: RestRequest): RestResult {
  const { method, path } = request;
  const segments = path.split('/').filter((segment) => segment !== '').map(decodePathSegment);

  // GET /api/v3/
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3' && method === 'GET') {
    return json(200, {
      current_user_url: `${request.baseUrl}/api/v3/user`,
      current_user_authorizations_html_url: `${request.baseUrl}/settings/tokens`,
      authorizations_url: `${request.baseUrl}/api/v3/authorizations`,
      code_search_url: `${request.baseUrl}/api/v3/search/code?q={query}`,
      commit_search_url: `${request.baseUrl}/api/v3/search/commits?q={query}`,
      emails_url: `${request.baseUrl}/api/v3/user/emails`,
      emojis_url: `${request.baseUrl}/api/v3/emojis`,
      events_url: `${request.baseUrl}/api/v3/events`,
      feeds_url: `${request.baseUrl}/api/v3/feeds`,
      followers_url: `${request.baseUrl}/api/v3/user/followers`,
      following_url: `${request.baseUrl}/api/v3/user/following{/other_user}`,
      gists_url: `${request.baseUrl}/api/v3/gists{/gist_id}`,
      hub_url: `${request.baseUrl}/api/v3/hub`,
      issue_search_url: `${request.baseUrl}/api/v3/search/issues?q={query}`,
      issues_url: `${request.baseUrl}/api/v3/issues`,
      keys_url: `${request.baseUrl}/api/v3/user/keys`,
      label_search_url: `${request.baseUrl}/api/v3/search/labels?q={query}`,
      notifications_url: `${request.baseUrl}/api/v3/notifications{?since,all,participating}`,
      organization_url: `${request.baseUrl}/api/v3/orgs/{org}`,
      organization_repositories_url: `${request.baseUrl}/api/v3/orgs/{org}/repos{?type,page,per_page,sort}`,
      organization_teams_url: `${request.baseUrl}/api/v3/orgs/{org}/teams`,
      public_gists_url: `${request.baseUrl}/api/v3/gists/public`,
      rate_limit_url: `${request.baseUrl}/api/v3/rate_limit`,
      repository_url: `${request.baseUrl}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${request.baseUrl}/api/v3/search/repositories?q={query}`,
      search_url: `${request.baseUrl}/api/v3/search`,
      starred_url: `${request.baseUrl}/api/v3/user/starred{/owner}{/repo}`,
      starred_gists_url: `${request.baseUrl}/api/v3/gists/starred`,
      user_url: `${request.baseUrl}/api/v3/users/{user}`,
      user_organizations_url: `${request.baseUrl}/api/v3/users/{user}/orgs`,
      user_repositories_url: `${request.baseUrl}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
      user_search_url: `${request.baseUrl}/api/v3/search/users?q={query}`,
    });
  }

  // GET /api/v3/meta
  if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'meta' && method === 'GET') {
    return json(200, {
      verifiable_password_authentication: true,
      password_authentication: true,
      github_services_sha: '0000000000000000000000000000000000000000',
      hooks: ['pre-receive', 'post-receive'],
      git: ['127.0.0.1'],
      pages: ['127.0.0.1'],
      importer: ['127.0.0.1'],
      installed_version: '1.0.0',
    });
  }

  // GET /api/v3/user
  if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user' && method === 'GET') {
    return json(200, {
      ...userJson(VIEWER.login),
      name: VIEWER.name,
      email: VIEWER.email,
      html_url: `${request.baseUrl}/${VIEWER.login}`,
      url: `${request.baseUrl}/api/v3/users/${VIEWER.login}`,
      type: 'User',
      site_admin: false,
    });
  }

  // /api/v3/user/repos
  if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'GET') {
      const repos = [...forge.repos.values()]
        .filter((repo) => repo.owner === VIEWER.login)
        .sort((a, b) => a.createdSeq - b.createdSeq);
      const page = paginate(repos, request.query, request.path, request.baseUrl);
      return json(200, page.page.map((repo) => repoJson(forge, repo, request.baseUrl)), linkHeader(page));
    }
    if (method === 'POST') {
      const parsed = parseBody(request);
      if (!parsed.ok) return parsed.result;
      const body = parsed.value;
      const name = stringField(body, 'name');
      if (name === undefined || name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        return error(422, 'name is invalid');
      }
      if (forge.findRepo(VIEWER.login, name) !== undefined) {
        return error(422, 'name already exists on this account');
      }
      const repo = forge.createRepo({
        name,
        description: stringField(body, 'description') ?? '',
        isPrivate: isRecord(body) && body.private === true,
        autoInit: isRecord(body) && body.auto_init === true,
      });
      return json(201, repoJson(forge, repo, request.baseUrl));
    }
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos') {
    const owner = segments[3];
    const repoName = segments[4];
    const found = findRepoOr404(forge, owner, repoName);
    if ('result' in found) return found.result;
    const repo = found.repo;
    const rest = segments.slice(5);

    // GET/PATCH/DELETE /repos/{owner}/{repo}
    if (rest.length === 0) {
      if (method === 'GET') return json(200, repoJson(forge, repo, request.baseUrl));
      if (method === 'PATCH') {
        const parsed = parseBody(request);
        if (!parsed.ok) return parsed.result;
        const description = stringField(parsed.value, 'description');
        if (description !== undefined) repo.description = description;
        if (isRecord(parsed.value) && typeof parsed.value.private === 'boolean') repo.isPrivate = parsed.value.private;
        repo.updatedSeq = forge.tick();
        return json(200, repoJson(forge, repo, request.baseUrl));
      }
      if (method === 'DELETE') {
        forge.deleteRepo(repo);
        return { status: 204, headers: { 'x-oauth-scopes': 'repo, read:org' }, body: '' };
      }
    }

    // GET /repos/{owner}/{repo}/branches
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      const branches = forge.branchNames(repo).map((name) => ({
        name,
        commit: { sha: forge.branchTip(repo, name)! },
        protected: false,
      }));
      return json(200, branches);
    }

    // GET /repos/{owner}/{repo}/branches/{branch}
    if (rest.length === 2 && rest[0] === 'branches' && method === 'GET') {
      const tip = forge.branchTip(repo, rest[1]);
      if (tip === undefined) return error(404, 'Not Found');
      return json(200, { name: rest[1], commit: { sha: tip }, protected: false });
    }

    // GET /repos/{owner}/{repo}/commits
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const ref = request.query.get('sha') ?? repo.defaultBranch;
      const commits = forge.listCommits(repo, ref);
      const page = paginate(commits, request.query, request.path, request.baseUrl);
      return json(200, page.page.map((entry) => commitJson(forge, repo, entry.sha, request.baseUrl)), linkHeader(page));
    }

    // /repos/{owner}/{repo}/contents/{path...}
    if (rest.length >= 1 && rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      return handleContents(forge, repo, request, filePath);
    }

    // /repos/{owner}/{repo}/git/refs[/heads/{branch}]
    if (rest.length >= 2 && rest[0] === 'git' && rest[1] === 'refs') {
      return handleGitRefs(forge, repo, request, rest.slice(2));
    }

    // /repos/{owner}/{repo}/labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'GET') return json(200, repo.labels.map((label) => labelJson(repo, label, request.baseUrl)));
      if (method === 'POST') {
        const parsed = parseBody(request);
        if (!parsed.ok) return parsed.result;
        const name = stringField(parsed.value, 'name');
        if (name === undefined || name === '') return error(422, 'name is required');
        const existing = labelByName(repo, name);
        if (existing !== undefined) {
          // Upsert: the suite creates the scenario's first label through this route and
          // expects 201 even when the name already exists.
          const color = stringField(parsed.value, 'color');
          const description = stringField(parsed.value, 'description');
          if (color !== undefined) existing.color = color;
          if (description !== undefined) existing.description = description;
          return json(201, labelJson(repo, existing, request.baseUrl));
        }
        const label: Label = {
          dbId: forge.nextLabelDbId(),
          name,
          color: stringField(parsed.value, 'color') ?? 'ededed',
          description: stringField(parsed.value, 'description') ?? '',
          isDefault: false,
        };
        repo.labels.push(label);
        return json(201, labelJson(repo, label, request.baseUrl));
      }
    }

    // /repos/{owner}/{repo}/issues[/...]
    if (rest.length >= 1 && rest[0] === 'issues') {
      return handleIssues(forge, repo, request, rest.slice(1));
    }

    // /repos/{owner}/{repo}/pulls[/...]
    if (rest.length >= 1 && rest[0] === 'pulls') {
      return handlePulls(forge, repo, request, rest.slice(1));
    }
  }

  return error(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function handleContents(forge: Forge, repo: Repo, request: RestRequest, filePath: string): RestResult {
  const { method } = request;
  const branch = request.query.get('ref') ?? undefined;
  const branchFor = (bodyBranch?: string): string => bodyBranch ?? branch ?? repo.defaultBranch;

  if (method === 'GET') {
    const ref = branch ?? repo.defaultBranch;
    const tip = forge.branchTip(repo, ref);
    if (tip === undefined) return error(404, 'Not Found');
    const rootTree = parseCommit(repo.objects.get(tip)!.data).tree;
    // Resolve the path by walking the tree structure: a blob -> file, a tree -> listing.
    const resolve = (treeOid: string, segments: string[]): { kind: 'blob'; oid: string } | { kind: 'tree'; oid: string } | null => {
      if (segments.length === 0) return { kind: 'tree', oid: treeOid };
      const object = repo.objects.get(treeOid);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[0]);
      if (entry === undefined) return null;
      if (segments.length === 1) {
        return entry.mode === '40000' ? { kind: 'tree', oid: entry.oid } : { kind: 'blob', oid: entry.oid };
      }
      if (entry.mode !== '40000') return null;
      return resolve(entry.oid, segments.slice(1));
    };
    const segments = filePath === '' ? [] : filePath.split('/').filter((segment) => segment !== '');
    const resolved = resolve(rootTree, segments);
    if (resolved === null) return error(404, 'Not Found');
    if (resolved.kind === 'blob') {
      const object = repo.objects.get(resolved.oid)!;
      const name = segments[segments.length - 1] ?? filePath;
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: object.data.length,
        name,
        path: filePath,
        content: object.data.toString('base64'),
        sha: resolved.oid,
        url: `${request.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${filePath}`,
        html_url: `${request.baseUrl}/${repo.owner}/${repo.name}/blob/${ref}/${filePath}`,
        git_url: `${request.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${resolved.oid}`,
        download_url: `${request.baseUrl}/${repo.owner}/${repo.name}/raw/${ref}/${filePath}`,
      });
    }
    const object = repo.objects.get(resolved.oid)!;
    return json(200, parseTree(object.data).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
      name: entry.name,
      path: filePath === '' ? entry.name : `${filePath}/${entry.name}`,
      sha: entry.oid,
      url: `${request.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${filePath === '' ? entry.name : `${filePath}/${entry.name}`}`,
      html_url: `${request.baseUrl}/${repo.owner}/${repo.name}/${entry.mode === '40000' ? 'tree' : 'blob'}/${ref}/${filePath === '' ? entry.name : `${filePath}/${entry.name}`}`,
      git_url: `${request.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/git/${entry.mode === '40000' ? 'trees' : 'blobs'}/${entry.oid}`,
      download_url: entry.mode === '40000' ? null : `${request.baseUrl}/${repo.owner}/${repo.name}/raw/${ref}/${filePath === '' ? entry.name : `${filePath}/${entry.name}`}`,
    })));
  }

  if (method === 'PUT') {
    const parsed = parseBody(request);
    if (!parsed.ok) return parsed.result;
    const body = parsed.value;
    const message = stringField(body, 'message');
    const contentB64 = stringField(body, 'content');
    if (message === undefined || message === '') return error(422, 'message is required');
    if (contentB64 === undefined) return error(422, 'content is required');
    const content = b64decodeStrict(contentB64);
    if (content === null) return error(422, 'content is not valid base64');
    const targetBranch = branchFor(stringField(body, 'branch'));
    const sha = stringField(body, 'sha');
    const tip = forge.branchTip(repo, targetBranch);
    const existing = tip === undefined ? null : forge.blobAtPath(repo, parseCommit(repo.objects.get(tip)!.data).tree, filePath);
    if (existing !== null && sha === undefined) return error(422, "sha wasn't supplied");
    if (existing !== null && sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) {
      return error(409, 'sha does not match the current blob');
    }
    if (existing === null && sha !== undefined) return error(422, 'sha does not match any existing file');
    const created = existing === null;
    const result = forge.commitFile(repo, { branch: targetBranch, path: filePath, content, message });
    const name = filePath.split('/').pop() ?? filePath;
    return json(created ? 201 : 200, {
      content: {
        name,
        path: filePath,
        sha: result.blobSha,
        size: content.length,
        url: `${request.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${filePath}`,
        html_url: `${request.baseUrl}/${repo.owner}/${repo.name}/blob/${targetBranch}/${filePath}`,
        git_url: `${request.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${result.blobSha}`,
        download_url: `${request.baseUrl}/${repo.owner}/${repo.name}/raw/${targetBranch}/${filePath}`,
        type: 'file',
        encoding: 'base64',
      },
      commit: {
        sha: result.commitSha,
        message,
        author: { name: VIEWER.name, email: VIEWER.email, date: forge.isoTime(repo.updatedSeq) },
        committer: { name: VIEWER.name, email: VIEWER.email, date: forge.isoTime(repo.updatedSeq) },
      },
    });
  }

  if (method === 'DELETE') {
    const parsed = parseBody(request);
    if (!parsed.ok) return parsed.result;
    const body = parsed.value;
    const message = stringField(body, 'message');
    const sha = stringField(body, 'sha');
    if (message === undefined || message === '') return error(422, 'message is required');
    if (sha === undefined) return error(422, "sha wasn't supplied");
    const targetBranch = branchFor(stringField(body, 'branch'));
    const tip = forge.branchTip(repo, targetBranch);
    if (tip === undefined) return error(404, 'Not Found');
    const existing = forge.blobAtPath(repo, parseCommit(repo.objects.get(tip)!.data).tree, filePath);
    if (existing === null) return error(404, 'Not Found');
    if (sha.toLowerCase() !== existing.oid.toLowerCase()) return error(409, 'sha does not match the current blob');
    const deleted = forge.deleteFile(repo, { branch: targetBranch, path: filePath, message });
    if (deleted === null) return error(404, 'Not Found');
    return json(200, {
      content: null,
      commit: {
        sha: deleted.commitSha,
        message,
        author: { name: VIEWER.name, email: VIEWER.email, date: forge.isoTime(repo.updatedSeq) },
        committer: { name: VIEWER.name, email: VIEWER.email, date: forge.isoTime(repo.updatedSeq) },
      },
    });
  }

  return error(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// git refs
// ---------------------------------------------------------------------------------------------

function handleGitRefs(forge: Forge, repo: Repo, request: RestRequest, rest: string[]): RestResult {
  const { method } = request;
  // POST /git/refs — create a branch (or other ref) at a sha.
  if (rest.length === 0 && method === 'POST') {
    const parsed = parseBody(request);
    if (!parsed.ok) return parsed.result;
    const ref = stringField(parsed.value, 'ref');
    const sha = stringField(parsed.value, 'sha');
    if (ref === undefined || !ref.startsWith('refs/')) return error(422, 'ref must start with refs/');
    if (sha === undefined || !/^[0-9a-f]{40}$/i.test(sha)) return error(422, 'sha is invalid');
    if (!repo.objects.has(sha.toLowerCase())) return error(422, 'sha does not exist');
    if (repo.refs.has(ref)) return error(422, 'Reference already exists');
    repo.refs.set(ref, sha.toLowerCase());
    repo.updatedSeq = forge.tick();
    return json(201, { ref, object: { sha: sha.toLowerCase(), type: 'commit' } });
  }
  // GET /git/refs/heads/{branch}
  if (rest.length === 2 && rest[0] === 'heads' && method === 'GET') {
    const ref = `refs/heads/${rest[1]}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return error(404, 'Not Found');
    const object = repo.objects.get(tip);
    return json(200, { ref, object: { sha: tip, type: object?.type ?? 'commit' } });
  }
  // GET /git/refs/{ref...} (any other ref)
  if (rest.length >= 1 && method === 'GET') {
    const ref = `refs/${rest.join('/')}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return error(404, 'Not Found');
    const object = repo.objects.get(tip);
    return json(200, { ref, object: { sha: tip, type: object?.type ?? 'commit' } });
  }
  return error(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

function handleIssues(forge: Forge, repo: Repo, request: RestRequest, rest: string[]): RestResult {
  const { method } = request;

  // GET /issues — list (issues and pull requests, like GitHub)
  if (rest.length === 0 && method === 'GET') {
    const state = request.query.get('state') ?? 'open';
    const sort = request.query.get('sort') ?? 'created';
    const direction = request.query.get('direction') ?? 'desc';
    const labelsFilter = request.query.get('labels');
    const wantedLabels = labelsFilter === null ? null : labelsFilter.split(',').map((label) => label.trim().toLowerCase());
    let items: Array<Issue | Pull> = [...repo.issues, ...repo.pulls];
    if (state !== 'all') {
      const wanted = state === 'closed' ? 'closed' : 'open';
      items = items.filter((item) => (item.isPullRequest ? item.state === wanted || (wanted === 'closed' && item.state === 'merged') : item.state === wanted));
    }
    if (wantedLabels !== null) {
      items = items.filter((item) => !item.isPullRequest && wantedLabels.every((label) => item.labels.some((name) => name.toLowerCase() === label)));
    }
    const key = (item: Issue | Pull): number => (sort === 'updated' ? item.updatedSeq : item.createdSeq);
    items.sort((a, b) => (direction === 'asc' ? key(a) - key(b) : key(b) - key(a)));
    const page = paginate(items, request.query, request.path, request.baseUrl);
    return json(200, page.page.map((item) => issueJson(forge, repo, item, request.baseUrl)), linkHeader(page));
  }

  // POST /issues — create
  if (rest.length === 0 && method === 'POST') {
    const parsed = parseBody(request);
    if (!parsed.ok) return parsed.result;
    const title = stringField(parsed.value, 'title');
    if (title === undefined || title === '') return error(422, 'title is required');
    const body = stringField(parsed.value, 'body') ?? '';
    const labels = isRecord(parsed.value) && Array.isArray(parsed.value.labels) ? parsed.value.labels : [];
    const labelNames: string[] = [];
    for (const label of labels) {
      if (typeof label !== 'string') return error(422, 'labels must be strings');
      if (labelByName(repo, label) === undefined) return error(422, `label ${label} does not exist`);
      labelNames.push(labelByName(repo, label)!.name);
    }
    const issue = forge.createIssue(repo, { title, body, labels: labelNames });
    return json(201, issueJson(forge, repo, issue, request.baseUrl));
  }

  // /issues/{number}[/comments]
  if (rest.length >= 1) {
    const number = Number.parseInt(rest[0], 10);
    if (!Number.isInteger(number) || number < 1) return error(404, 'Not Found');
    const found = forge.findIssue(repo, number);
    if (found === undefined) return error(404, 'Not Found');

    if (rest.length === 1 && method === 'GET') {
      return json(200, issueJson(forge, repo, found, request.baseUrl));
    }
    if (rest.length === 1 && method === 'PATCH') {
      const parsed = parseBody(request);
      if (!parsed.ok) return parsed.result;
      const state = stringField(parsed.value, 'state');
      const title = stringField(parsed.value, 'title');
      const body = stringField(parsed.value, 'body');
      if (title !== undefined) found.title = title;
      if (body !== undefined) found.body = body;
      if (state === 'open' || state === 'closed') {
        if (!found.isPullRequest) {
          found.state = state;
          found.closedSeq = state === 'closed' ? forge.tick() : null;
        } else {
          found.state = state;
          found.closedSeq = state === 'closed' ? forge.tick() : null;
        }
      }
      found.updatedSeq = forge.tick();
      return json(200, issueJson(forge, repo, found, request.baseUrl));
    }
    if (rest.length === 2 && rest[1] === 'comments') {
      if (found.isPullRequest) return error(404, 'Not Found');
      if (method === 'GET') {
        return json(200, found.comments.map((comment) => commentJson(forge, repo, found.number, comment, request.baseUrl)));
      }
      if (method === 'POST') {
        const parsed = parseBody(request);
        if (!parsed.ok) return parsed.result;
        const body = stringField(parsed.value, 'body');
        if (body === undefined || body === '') return error(422, 'body is required');
        const seq = forge.tick();
        const comment: Comment = {
          dbId: forge.nextItemDbId(),
          nodeId: globalId('IssueComment', repo.id, found.number, found.comments.length + 1),
          body,
          author: VIEWER.login,
          createdSeq: seq,
          updatedSeq: seq,
        };
        found.comments.push(comment);
        found.updatedSeq = seq;
        return json(201, commentJson(forge, repo, found.number, comment, request.baseUrl));
      }
    }
  }
  return error(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function handlePulls(forge: Forge, repo: Repo, request: RestRequest, rest: string[]): RestResult {
  const { method } = request;

  // GET /pulls — list
  if (rest.length === 0 && method === 'GET') {
    const state = request.query.get('state') ?? 'open';
    const sort = request.query.get('sort') ?? 'created';
    const direction = request.query.get('direction') ?? 'desc';
    let items = [...repo.pulls];
    if (state !== 'all') {
      const wanted = state === 'closed' ? 'closed' : 'open';
      items = items.filter((pull) => (wanted === 'closed' ? pull.state === 'closed' || pull.state === 'merged' : pull.state === 'open'));
    }
    const key = (pull: Pull): number => (sort === 'updated' ? pull.updatedSeq : pull.createdSeq);
    items.sort((a, b) => (direction === 'asc' ? key(a) - key(b) : key(b) - key(a)));
    const page = paginate(items, request.query, request.path, request.baseUrl);
    return json(200, page.page.map((pull) => pullJson(forge, repo, pull, request.baseUrl)), linkHeader(page));
  }

  // POST /pulls — create
  if (rest.length === 0 && method === 'POST') {
    const parsed = parseBody(request);
    if (!parsed.ok) return parsed.result;
    const title = stringField(parsed.value, 'title');
    if (title === undefined || title === '') return error(422, 'title is required');
    const headRaw = isRecord(parsed.value) ? parsed.value.head : undefined;
    const baseRaw = isRecord(parsed.value) ? parsed.value.base : undefined;
    const head = typeof headRaw === 'string' ? headRaw : isRecord(headRaw) ? stringField(headRaw, 'ref') : undefined;
    const base = typeof baseRaw === 'string' ? baseRaw : isRecord(baseRaw) ? stringField(baseRaw, 'ref') : undefined;
    if (head === undefined || base === undefined) return error(422, 'head and base are required');
    const body = stringField(parsed.value, 'body') ?? '';
    const created = forge.createPull(repo, { title, head, base, body });
    if ('error' in created) return error(422, created.error);
    return json(201, pullJson(forge, repo, created, request.baseUrl));
  }

  // /pulls/{number}[/...]
  if (rest.length >= 1) {
    const number = Number.parseInt(rest[0], 10);
    if (!Number.isInteger(number) || number < 1) return error(404, 'Not Found');
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return error(404, 'Not Found');

    if (rest.length === 1 && method === 'GET') {
      return json(200, pullJson(forge, repo, pull, request.baseUrl));
    }
    if (rest.length === 1 && method === 'PATCH') {
      const parsed = parseBody(request);
      if (!parsed.ok) return parsed.result;
      const title = stringField(parsed.value, 'title');
      const body = stringField(parsed.value, 'body');
      const state = stringField(parsed.value, 'state');
      if (title !== undefined) pull.title = title;
      if (body !== undefined) pull.body = body;
      if (state === 'closed' && pull.state === 'open') {
        pull.state = 'closed';
        pull.closedSeq = forge.tick();
      } else if (state === 'open' && pull.state === 'closed') {
        pull.state = 'open';
        pull.closedSeq = null;
      }
      pull.updatedSeq = forge.tick();
      return json(200, pullJson(forge, repo, pull, request.baseUrl));
    }
    // GET /pulls/{number}/files
    if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
      const files = forge.pullFiles(repo, pull);
      return json(200, files.map((file) => ({
        filename: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      })));
    }
    // PUT /pulls/{number}/merge
    if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
      const result = forge.mergePull(repo, pull);
      if (!result.merged) {
        return error(405, result.reason);
      }
      return json(200, { merged: true, sha: result.sha, message: result.message });
    }
  }
  return error(404, 'Not Found');
}

