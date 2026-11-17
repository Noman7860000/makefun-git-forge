// mcp.ts — Model Context Protocol over streamable HTTP at POST /mcp. One JSON-RPC
// request per POST, answered by one JSON body. Speaks the modern 2026-07-28 era
// (server/discover, no session) and the legacy handshake (initialize +
// notifications/initialized) alike, so whichever the client probes first works.
// Tools act on the same store as REST and GraphQL; the tools list is a constant, so
// two tools/list calls are byte-identical.

import { Forge, VIEWER, globalId, type Issue, type Pull, type Repo } from './store.ts';

export const MCP_SERVER_NAME = 'forge';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25', '2025-06-18'];

export interface McpResult {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: boolean;
  };
}

const stringProp = (description: string): Record<string, unknown> => ({ type: 'string', description });
const booleanProp = (description: string): Record<string, unknown> => ({ type: 'boolean', description });
const integerProp = (description: string): Record<string, unknown> => ({ type: 'integer', description });

/** The tools, built once: the list never changes, so two tools/list calls agree byte for byte. */
export const MCP_TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository. Defaults to the authenticated user.'),
        name: stringProp('The name of the repository.'),
        description: stringProp('A short description of the repository.'),
        private: booleanProp('Whether the repository is private.'),
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        title: stringProp('The title of the issue.'),
        body: stringProp('The body of the issue.'),
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to attach to the issue.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        issue_number: integerProp('The issue number.'),
      },
      required: ['owner', 'repo', 'issue_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        title: stringProp('The title of the pull request.'),
        body: stringProp('The body of the pull request.'),
        head: stringProp('The head branch (the branch with the changes).'),
        base: stringProp('The base branch (the branch the changes go into).'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        pull_number: integerProp('The pull request number.'),
        merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'The merge method.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        issue_number: integerProp('The issue number.'),
        body: stringProp('The comment body.'),
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
      additionalProperties: false,
    },
  },
]);

// ---------------------------------------------------------------------------------------------
// tool result shapes (the same objects REST returns, so the views agree)
// ---------------------------------------------------------------------------------------------

function repoView(forge: Forge, repo: Repo, baseUrl: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: forge.isoTime(repo.createdSeq),
    updated_at: forge.isoTime(repo.updatedSeq),
    pushed_at: forge.isoTime(repo.pushedSeq),
    html_url: `${baseUrl}/${repo.owner}/${repo.name}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `${baseUrl}/${repo.owner}/${repo.name}.git`,
  };
}

function issueView(forge: Forge, repo: Repo, issue: Issue | Pull, baseUrl: string): Record<string, unknown> {
  const isPull = issue.isPullRequest;
  return {
    id: issue.dbId,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: isPull ? (issue.state === 'merged' ? 'closed' : issue.state) : issue.state,
    user: { login: issue.author, id: VIEWER.id, type: 'User' },
    labels: isPull ? [] : issue.labels.map((name) => ({ name })),
    comments: isPull ? 0 : issue.comments.length,
    created_at: forge.isoTime(issue.createdSeq),
    updated_at: forge.isoTime(issue.updatedSeq),
    closed_at: issue.closedSeq === null ? null : forge.isoTime(issue.closedSeq),
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullView(forge: Forge, repo: Repo, pull: Pull, baseUrl: string): Record<string, unknown> {
  return {
    id: pull.dbId,
    node_id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'merged' ? 'closed' : pull.state,
    merged: pull.merged,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha },
    user: { login: pull.author, id: VIEWER.id, type: 'User' },
    created_at: forge.isoTime(pull.createdSeq),
    updated_at: forge.isoTime(pull.updatedSeq),
    merged_at: pull.mergedSeq === null ? null : forge.isoTime(pull.mergedSeq),
    merge_commit_sha: pull.mergeCommitSha,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------------------------
// tool execution
// ---------------------------------------------------------------------------------------------

type ToolOutcome =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

function requireArgs(args: Record<string, unknown>, required: string[]): string | null {
  for (const name of required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return name;
  }
  return null;
}

function executeTool(forge: Forge, name: string, args: Record<string, unknown>, baseUrl: string): ToolOutcome {
  const tool = MCP_TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return { ok: false, message: `Unknown tool: ${name}` };
  const missing = requireArgs(args, tool.inputSchema.required);
  if (missing !== null) return { ok: false, message: `Missing required argument: ${missing}` };

  const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER.login;
  const repoName = args.repo as string | undefined;

  switch (name) {
    case 'create_repo': {
      const repoNameArg = args.name as string;
      if (owner !== VIEWER.login) return { ok: false, message: `Cannot create a repository for ${owner}` };
      if (forge.findRepo(owner, repoNameArg) !== undefined) return { ok: false, message: `Repository ${owner}/${repoNameArg} already exists` };
      const repo = forge.createRepo({
        name: repoNameArg,
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      return { ok: true, value: repoView(forge, repo, baseUrl) };
    }
    case 'get_repo': {
      const repo = forge.findRepo(owner, repoName!);
      if (repo === undefined) return { ok: false, message: `Repository ${owner}/${repoName} not found` };
      return { ok: true, value: repoView(forge, repo, baseUrl) };
    }
    case 'create_issue': {
      const repo = forge.findRepo(owner, repoName!);
      if (repo === undefined) return { ok: false, message: `Repository ${owner}/${repoName} not found` };
      const labels = Array.isArray(args.labels) ? (args.labels as unknown[]) : [];
      const labelNames: string[] = [];
      for (const label of labels) {
        if (typeof label !== 'string') return { ok: false, message: 'labels must be strings' };
        const found = repo.labels.find((entry) => entry.name.toLowerCase() === label.toLowerCase());
        if (found === undefined) return { ok: false, message: `label ${label} does not exist` };
        labelNames.push(found.name);
      }
      const issue = forge.createIssue(repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        labels: labelNames,
      });
      return { ok: true, value: issueView(forge, repo, issue, baseUrl) };
    }
    case 'list_issues': {
      const repo = forge.findRepo(owner, repoName!);
      if (repo === undefined) return { ok: false, message: `Repository ${owner}/${repoName} not found` };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let items: Array<Issue | Pull> = [...repo.issues, ...repo.pulls];
      if (state !== 'all') {
        const wanted = state === 'closed' ? 'closed' : 'open';
        items = items.filter((item) => (item.isPullRequest ? item.state === wanted || (wanted === 'closed' && item.state === 'merged') : item.state === wanted));
      }
      items.sort((a, b) => a.number - b.number);
      return { ok: true, value: { issues: items.map((item) => issueView(forge, repo, item, baseUrl)) } };
    }
    case 'get_issue': {
      const repo = forge.findRepo(owner, repoName!);
      if (repo === undefined) return { ok: false, message: `Repository ${owner}/${repoName} not found` };
      const number = args.issue_number as number;
      const found = forge.findIssue(repo, number);
      if (found === undefined) return { ok: false, message: `Issue #${number} not found` };
      return { ok: true, value: issueView(forge, repo, found, baseUrl) };
    }
    case 'create_pull_request': {
      const repo = forge.findRepo(owner, repoName!);
      if (repo === undefined) return { ok: false, message: `Repository ${owner}/${repoName} not found` };
      const created = forge.createPull(repo, {
        title: args.title as string,
        head: args.head as string,
        base: args.base as string,
        body: typeof args.body === 'string' ? args.body : '',
      });
      if ('error' in created) return { ok: false, message: created.error };
      return { ok: true, value: pullView(forge, repo, created, baseUrl) };
    }
    case 'merge_pull_request': {
      const repo = forge.findRepo(owner, repoName!);
      if (repo === undefined) return { ok: false, message: `Repository ${owner}/${repoName} not found` };
      const number = args.pull_number as number;
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return { ok: false, message: `Pull request #${number} not found` };
      const result = forge.mergePull(repo, pull);
      if (!result.merged) return { ok: false, message: result.reason };
      return { ok: true, value: { merged: true, sha: result.sha, message: result.message, number: pull.number, ...pullView(forge, repo, pull, baseUrl) } };
    }
    case 'list_pull_requests': {
      const repo = forge.findRepo(owner, repoName!);
      if (repo === undefined) return { ok: false, message: `Repository ${owner}/${repoName} not found` };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let items = [...repo.pulls];
      if (state !== 'all') {
        const wanted = state === 'closed' ? 'closed' : 'open';
        items = items.filter((pull) => (wanted === 'closed' ? pull.state === 'closed' || pull.state === 'merged' : pull.state === 'open'));
      }
      items.sort((a, b) => a.number - b.number);
      return { ok: true, value: { pull_requests: items.map((pull) => pullView(forge, repo, pull, baseUrl)) } };
    }
    case 'add_issue_comment': {
      const repo = forge.findRepo(owner, repoName!);
      if (repo === undefined) return { ok: false, message: `Repository ${owner}/${repoName} not found` };
      const number = args.issue_number as number;
      const found = forge.findIssue(repo, number);
      if (found === undefined || found.isPullRequest) return { ok: false, message: `Issue #${number} not found` };
      const seq = forge.tick();
      const comment = {
        dbId: forge.nextItemDbId(),
        nodeId: globalId('IssueComment', repo.id, found.number, found.comments.length + 1),
        body: args.body as string,
        author: VIEWER.login,
        createdSeq: seq,
        updatedSeq: seq,
      };
      found.comments.push(comment);
      found.updatedSeq = seq;
      return {
        ok: true,
        value: {
          id: comment.dbId,
          node_id: comment.nodeId,
          body: comment.body,
          user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
          created_at: forge.isoTime(seq),
          updated_at: forge.isoTime(seq),
        },
      };
    }
    default:
      return { ok: false, message: `Unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC transport
// ---------------------------------------------------------------------------------------------

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }), headers: { 'content-type': 'application/json' } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), headers: { 'content-type': 'application/json' } };
}

export function handleMcp(forge: Forge, bodyText: string, baseUrl: string): McpResult {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    // A body that is not JSON answers HTTP 400 with JSON-RPC -32700.
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const record = body as Record<string, unknown>;
  const id = record.id === undefined ? null : record.id;
  const method = record.method;
  if (typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request', 400);
  const params = (record.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) are acknowledged with 202 and no body.
  if (record.id === undefined) {
    return { status: 202, body: '', headers: { 'content-type': 'application/json' } };
  }

  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        supportedVersions: [...MCP_SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP tools.',
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
      const chosen = offered !== undefined && MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : MCP_SUPPORTED_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    }
    case 'tools/list': {
      return rpcResult(id, { tools: MCP_TOOLS });
    }
    case 'tools/call': {
      const name = params.name as string | undefined;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (typeof name !== 'string' || name === '') {
        return rpcError(id, -32602, 'Invalid params: tools/call needs a tool name');
      }
      const tool = MCP_TOOLS.find((entry) => entry.name === name);
      if (tool === undefined) {
        // An unknown tool name answers -32601 (or -32602), never HTTP 500.
        return rpcError(id, -32601, `Unknown tool: ${name}`);
      }
      const missing = requireArgs(args, tool.inputSchema.required);
      if (missing !== null) {
        return rpcError(id, -32602, `Invalid params: missing required argument: ${missing}`);
      }
      const outcome = executeTool(forge, name, args, baseUrl);
      if (!outcome.ok) {
        return rpcResult(id, {
          content: [{ type: 'text', text: outcome.message }],
          structuredContent: { error: outcome.message },
          isError: true,
        });
      }
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
        structuredContent: outcome.value,
        isError: false,
      });
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
