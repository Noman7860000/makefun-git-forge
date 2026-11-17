// graphql.ts — a small, targeted GraphQL executor for the documents gh and
// github-mcp-server send: repository/issue/pull-request reads, the five mutations,
// node(id:), batched operations and the __type introspection probes. It parses the
// document (fields, aliases, arguments, variables, inline fragments), validates field
// names against the known schema (an unknown field is a 200 with an errors array
// naming it, never an HTTP error), and resolves against the forge's store.

import { mergeBase } from './gitobjs.ts';
import {
  Forge,
  VIEWER,
  globalId,
  parseGlobalId,
  type Comment,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// document parsing
// ---------------------------------------------------------------------------------------------

interface FieldNode {
  alias: string;
  name: string;
  args: Record<string, unknown>;
  children: FieldNode[];
  /** Inline fragment: the type condition, e.g. "Repository" for `... on Repository`. */
  fragmentType?: string;
}

interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  fields: FieldNode[];
}

class ParseError extends Error {}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():[]!=$@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z_0-9-]/.test(input[j])) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = tokenize(input);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new ParseError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new ParseError(`expected ${token}, got ${got}`);
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new ParseError('empty document');
    return operations;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const head = this.peek();
    if (head === 'query' || head === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName !== '(' && maybeName !== '{') {
        name = this.next();
      }
    }
    // Variable definitions: ($name: Type, ...) — parsed and discarded; values come from `variables`.
    if (this.peek() === '(') this.parseVariableDefinitions();
    const fields = this.parseSelectionSet();
    return { kind, name, fields };
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token === '(') depth += 1;
      else if (token === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === undefined) throw new ParseError('unterminated selection set');
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  private parseField(): FieldNode {
    if (this.peek() === '...') {
      this.next();
      let fragmentType: string | undefined;
      if (this.peek() === 'on') {
        this.next();
        fragmentType = this.next();
      }
      const children = this.parseSelectionSet();
      return { alias: '', name: '', args: {}, children, fragmentType };
    }
    let alias = '';
    let name = this.next();
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Record<string, unknown> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    let children: FieldNode[] = [];
    if (this.peek() === '{') children = this.parseSelectionSet();
    return { alias: alias === '' ? name : alias, name, args, children };
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token === '$') return { $var: this.next() };
    if (token === '[') {
      const items: unknown[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return items;
    }
    if (token === '{') {
      const object: Record<string, unknown> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        object[key] = this.parseValue();
      }
      this.expect('}');
      return object;
    }
    if (token.startsWith('"')) return JSON.parse(token) as string;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (/^-?\d+$/.test(token)) return Number.parseInt(token, 10);
    if (/^-?\d*\.\d+$/.test(token)) return Number.parseFloat(token);
    return token; // enum literal: a bare name reads as its string
  }
}

/** Replace {$var: name} markers with the operation's variable values. */
function resolveVariables(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.$var === 'string' && Object.keys(record).length === 1) {
      return variables[record.$var] ?? null;
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) out[key] = resolveVariables(child, variables);
    return out;
  }
  if (Array.isArray(value)) return value.map((child) => resolveVariables(child, variables));
  return value;
}

// ---------------------------------------------------------------------------------------------
// schema: the fields each type exposes (introspection answers and validation share this)
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'issue', 'issues',
    'pullRequest', 'pullRequests', 'forkCount', 'stargazerCount', 'watcherCount', 'homepageUrl',
    'licenseInfo', 'primaryLanguage', 'topics',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'url', 'labels',
    'comments', 'closedAt', 'assignees', 'locked', 'milestone', 'reactions',
  ],
  PullRequest: [
    'id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'headRef', 'baseRef',
    'mergeable', 'merged', 'files', 'createdAt', 'updatedAt', 'author', 'url', 'isDraft', 'additions',
    'deletions', 'changedFiles', 'comments', 'reviews', 'commits', 'closedAt', 'mergedAt',
  ],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl'],
  Ref: ['id', 'name', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentEdge: ['node', 'cursor'],
  Label: ['id', 'name', 'color', 'description'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['queryType', 'mutationType', 'types', 'description'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

const TYPE_KIND: Record<string, string> = {
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeMethod: 'ENUM',
};

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface GqlContext {
  forge: Forge;
  baseUrl: string;
}

type NodeValue = { __typename: string; data: unknown } | null;

function node(typename: string, data: unknown): NodeValue {
  return data === null || data === undefined ? null : { __typename: typename, data };
}

function isNodeValue(value: unknown): value is { __typename: string; data: unknown } {
  return value !== null && typeof value === 'object' && '__typename' in (value as Record<string, unknown>);
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match === null ? null : Number.parseInt(match[1], 10);
  } catch {
    return null;
  }
}

interface ConnectionItem {
  number: number;
  node: NodeValue;
}

function buildConnection(items: ConnectionItem[], args: Record<string, unknown>, typename: string): { __typename: string; data: unknown } {
  const first = typeof args.first === 'number' ? args.first : 100;
  const after = typeof args.after === 'string' ? cursorNumber(args.after) : null;
  let startIndex = 0;
  if (after !== null) {
    const index = items.findIndex((item) => item.number === after);
    startIndex = index < 0 ? items.length : index + 1;
  }
  const page = items.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + page.length < items.length;
  return {
    __typename: typename,
    data: {
      items: page,
      hasNextPage,
      totalCount: items.length,
    },
  };
}

class Executor {
  private readonly ctx: GqlContext;
  private errors: Array<{ message: string }> = [];

  constructor(ctx: GqlContext) {
    this.ctx = ctx;
  }

  execute(operation: Operation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
    const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    const data: Record<string, unknown> = {};
    for (const field of operation.fields) {
      const value = this.resolveField(rootType, null, field, variables);
      if (field.fragmentType !== undefined) {
        // A top-level inline fragment spreads its fields into the parent object.
        if (value !== undefined && typeof value === 'object') Object.assign(data, value as Record<string, unknown>);
        continue;
      }
      data[field.alias] = value;
    }
    const out: { data: Record<string, unknown>; errors?: Array<{ message: string }> } = { data };
    if (this.errors.length > 0) out.errors = this.errors;
    return out;
  }

  private resolveField(typeName: string, parent: NodeValue, field: FieldNode, variables: Record<string, unknown>): unknown {
    // Inline fragments apply only when the parent's type matches the condition.
    if (field.fragmentType !== undefined) {
      if (parent === null || parent.__typename !== field.fragmentType) return undefined;
      const out: Record<string, unknown> = {};
      for (const child of field.children) {
        const value = this.resolveField(typeName, parent, child, variables);
        if (value !== undefined) out[child.alias] = value;
      }
      return out;
    }
    const allowed = TYPE_FIELDS[typeName];
    if (allowed !== undefined && !allowed.includes(field.name)) {
      this.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      return null;
    }
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(field.args)) args[key] = resolveVariables(value, variables);
    const value = this.resolve(typeName, parent, field.name, args);
    if (value === undefined) return null;
    if (field.children.length === 0) {
      // A node selected without subfields is not a valid selection; answer null.
      if (isNodeValue(value)) return null;
      return value;
    }
    return this.resolveChildren(value, field.children, variables);
  }

  /** Resolve a value's selected subfields: a node, an array of nodes/records, or a plain record. */
  private resolveChildren(value: unknown, children: FieldNode[], variables: Record<string, unknown>): unknown {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.map((element) => this.resolveChildren(element, children, variables));
    if (isNodeValue(value)) {
      const out: Record<string, unknown> = {};
      for (const child of children) {
        const childValue = this.resolveField(value.__typename, value, child, variables);
        if (childValue === undefined) continue;
        if (child.fragmentType !== undefined) {
          // An inline fragment spreads its fields into the parent object.
          if (typeof childValue === 'object') Object.assign(out, childValue as Record<string, unknown>);
          continue;
        }
        out[child.alias] = childValue;
      }
      return out;
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const child of children) {
        if (child.fragmentType !== undefined) {
          const recordType = typeof record.__typename === 'string' ? record.__typename : undefined;
          if (recordType !== undefined && recordType !== child.fragmentType) continue;
          const sub = this.resolveChildren(value, child.children, variables);
          if (sub !== null && typeof sub === 'object') Object.assign(out, sub as Record<string, unknown>);
          continue;
        }
        const raw = record[child.name];
        if (raw === undefined) {
          out[child.alias] = null;
          continue;
        }
        if (child.children.length === 0) {
          out[child.alias] = isNodeValue(raw) ? null : raw;
          continue;
        }
        out[child.alias] = this.resolveChildren(raw, child.children, variables);
      }
      return out;
    }
    return value;
  }

  private resolve(typeName: string, parent: NodeValue, field: string, args: Record<string, unknown>): unknown {
    const forge = this.ctx.forge;
    switch (typeName) {
      case 'Query': return this.resolveQuery(field, args);
      case 'Mutation': return this.resolveMutation(field, args);
      case 'Repository': return this.resolveRepository(parent, field, args);
      case 'Issue': return this.resolveIssue(parent, field, args);
      case 'PullRequest': return this.resolvePullRequest(parent, field, args);
      case 'User': return this.resolveUser(parent, field);
      case 'Ref': return this.resolveRef(parent, field);
      case 'IssueConnection':
      case 'PullRequestConnection':
      case 'PullRequestFileConnection':
      case 'IssueCommentConnection':
      case 'LabelConnection':
      case 'Connection':
        return this.resolveConnection(parent, field, args);
      case 'IssueComment': return this.resolveComment(parent, field);
      case 'Label': return this.resolveLabel(parent, field);
      case 'PullRequestFile': return this.resolvePullRequestFile(parent, field);
      case '__Type': return this.resolveIntrospectionType(parent, field, args);
      case '__Schema': return this.resolveIntrospectionSchema(parent, field);
      default:
        // Payload types: the data is a plain record; read the field off it.
        if (parent !== null && typeof parent.data === 'object' && parent.data !== null) {
          const record = parent.data as Record<string, unknown>;
          if (field in record) {
            const value = record[field];
            if (field === 'issue' && value !== null && typeof value === 'object' && 'number' in (value as Record<string, unknown>)) {
              return node('Issue', value);
            }
            if (field === 'pullRequest' && value !== null && typeof value === 'object' && 'number' in (value as Record<string, unknown>)) {
              return node('PullRequest', value);
            }
            return value;
          }
        }
        return undefined;
    }
  }

  private resolveQuery(field: string, args: Record<string, unknown>): unknown {
    const forge = this.ctx.forge;
    switch (field) {
      case 'viewer':
        return node('User', { login: VIEWER.login, name: VIEWER.name, email: VIEWER.email });
      case 'repository': {
        const owner = args.owner as string;
        const name = args.name as string;
        const repo = forge.findRepo(owner, name);
        return node('Repository', repo ?? null);
      }
      case 'node': {
        const id = args.id as string;
        const parsed = parseGlobalId(id);
        if (parsed === null) return null;
        if (parsed.kind === 'Repository') {
          const repoId = Number.parseInt(parsed.parts[0], 10);
          const repo = [...forge.repos.values()].find((entry) => entry.id === repoId);
          return node('Repository', repo ?? null);
        }
        if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
          const repoId = Number.parseInt(parsed.parts[0], 10);
          const number = Number.parseInt(parsed.parts[1], 10);
          const repo = [...forge.repos.values()].find((entry) => entry.id === repoId);
          if (repo === undefined) return null;
          if (parsed.kind === 'Issue') {
            const issue = repo.issues.find((entry) => entry.number === number);
            return node('Issue', issue ?? null);
          }
          const pull = repo.pulls.find((entry) => entry.number === number);
          return node('PullRequest', pull ?? null);
        }
        return null;
      }
      case '__type': {
        const name = args.name as string;
        if (TYPE_FIELDS[name] !== undefined || ENUM_VALUES[name] !== undefined) {
          return node('__Type', { name });
        }
        return null;
      }
      case '__schema':
        return node('__Schema', {});
      default:
        return undefined;
    }
  }

  private resolveMutation(field: string, args: Record<string, unknown>): unknown {
    const forge = this.ctx.forge;
    const input = (args.input ?? {}) as Record<string, unknown>;
    switch (field) {
      case 'createIssue': {
        const repo = this.repoFromGlobalId(input.repositoryId as string);
        if (repo === null) {
          this.errors.push({ message: 'Could not resolve to a Repository with the provided repositoryId.' });
          return node('CreateIssuePayload', null);
        }
        const issue = forge.createIssue(repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
        });
        return node('CreateIssuePayload', { issue });
      }
      case 'closeIssue': {
        const issue = this.issueFromGlobalId(input.issueId as string);
        if (issue === null) {
          this.errors.push({ message: 'Could not resolve to an Issue with the provided issueId.' });
          return node('CloseIssuePayload', null);
        }
        issue.state = 'closed';
        issue.closedSeq = forge.tick();
        issue.updatedSeq = forge.tick();
        return node('CloseIssuePayload', { issue });
      }
      case 'createPullRequest': {
        const repo = this.repoFromGlobalId(input.repositoryId as string);
        if (repo === null) {
          this.errors.push({ message: 'Could not resolve to a Repository with the provided repositoryId.' });
          return node('CreatePullRequestPayload', null);
        }
        const created = forge.createPull(repo, {
          title: String(input.title ?? ''),
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
        });
        if ('error' in created) {
          this.errors.push({ message: created.error });
          return node('CreatePullRequestPayload', null);
        }
        return node('CreatePullRequestPayload', { pullRequest: created });
      }
      case 'mergePullRequest': {
        const pull = this.pullFromGlobalId(input.pullRequestId as string);
        if (pull === null) {
          this.errors.push({ message: 'Could not resolve to a PullRequest with the provided pullRequestId.' });
          return node('MergePullRequestPayload', null);
        }
        const repo = this.repoOfPull(pull);
        if (repo === null) {
          this.errors.push({ message: 'Could not resolve the pull request repository.' });
          return node('MergePullRequestPayload', null);
        }
        const result = forge.mergePull(repo, pull);
        if (!result.merged) {
          this.errors.push({ message: result.reason });
          return node('MergePullRequestPayload', { pullRequest: pull });
        }
        return node('MergePullRequestPayload', { pullRequest: pull });
      }
      case 'addComment': {
        const target = this.issueOrPullFromGlobalId(input.subjectId as string);
        if (target === null || target.issue === undefined) {
          this.errors.push({ message: 'Could not resolve to an Issue with the provided subjectId.' });
          return node('AddCommentPayload', null);
        }
        const { repo, issue } = target;
        const seq = forge.tick();
        const comment: Comment = {
          dbId: forge.nextItemDbId(),
          nodeId: globalId('IssueComment', repo.id, issue.number, issue.comments.length + 1),
          body: String(input.body ?? ''),
          author: VIEWER.login,
          createdSeq: seq,
          updatedSeq: seq,
        };
        issue.comments.push(comment);
        issue.updatedSeq = seq;
        return node('AddCommentPayload', { commentEdge: { node: node('IssueComment', comment) } });
      }
      default:
        return undefined;
    }
  }

  private repoFromGlobalId(id: string): Repo | null {
    const parsed = parseGlobalId(id);
    if (parsed === null || parsed.kind !== 'Repository') return null;
    const repoId = Number.parseInt(parsed.parts[0], 10);
    return [...this.ctx.forge.repos.values()].find((entry) => entry.id === repoId) ?? null;
  }

  private issueFromGlobalId(id: string): Issue | null {
    const parsed = parseGlobalId(id);
    if (parsed === null || parsed.kind !== 'Issue') return null;
    const repoId = Number.parseInt(parsed.parts[0], 10);
    const number = Number.parseInt(parsed.parts[1], 10);
    const repo = [...this.ctx.forge.repos.values()].find((entry) => entry.id === repoId);
    return repo?.issues.find((entry) => entry.number === number) ?? null;
  }

  private pullFromGlobalId(id: string): Pull | null {
    const parsed = parseGlobalId(id);
    if (parsed === null || parsed.kind !== 'PullRequest') return null;
    const repoId = Number.parseInt(parsed.parts[0], 10);
    const number = Number.parseInt(parsed.parts[1], 10);
    const repo = [...this.ctx.forge.repos.values()].find((entry) => entry.id === repoId);
    return repo?.pulls.find((entry) => entry.number === number) ?? null;
  }

  private repoOfPull(pull: Pull): Repo | null {
    for (const repo of this.ctx.forge.repos.values()) {
      if (repo.pulls.includes(pull)) return repo;
    }
    return null;
  }

  private issueOrPullFromGlobalId(id: string): { repo: Repo; issue: Issue } | null {
    const parsed = parseGlobalId(id);
    if (parsed === null) return null;
    const repoId = Number.parseInt(parsed.parts[0], 10);
    const number = Number.parseInt(parsed.parts[1], 10);
    const repo = [...this.ctx.forge.repos.values()].find((entry) => entry.id === repoId);
    if (repo === undefined) return null;
    if (parsed.kind === 'Issue') {
      const issue = repo.issues.find((entry) => entry.number === number);
      return issue === undefined ? null : { repo, issue };
    }
    return null;
  }

  private resolveRepository(parent: NodeValue, field: string, args: Record<string, unknown>): unknown {
    const forge = this.ctx.forge;
    const repo = parent?.data as Repo;
    switch (field) {
      case 'id': return repo.nodeId;
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return repo.fullName;
      case 'description': return repo.description;
      case 'url': return `${this.ctx.baseUrl}/${repo.owner}/${repo.name}`;
      case 'createdAt': return forge.isoTime(repo.createdSeq);
      case 'updatedAt': return forge.isoTime(repo.updatedSeq);
      case 'isPrivate': return repo.isPrivate;
      case 'owner': return node('User', { login: repo.owner });
      case 'defaultBranchRef': {
        const tip = forge.branchTip(repo, repo.defaultBranch);
        return tip === undefined ? null : node('Ref', { name: repo.defaultBranch, oid: tip });
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'forkCount': return 0;
      case 'stargazerCount': return 0;
      case 'watcherCount': return 0;
      case 'homepageUrl': return null;
      case 'licenseInfo': return null;
      case 'primaryLanguage': return null;
      case 'topics': return [];
      case 'issue': {
        const number = args.number as number;
        const issue = repo.issues.find((entry) => entry.number === number);
        return node('Issue', issue ?? null);
      }
      case 'issues': {
        let items = [...repo.issues];
        const states = args.states as string[] | undefined;
        if (states !== undefined && states.length > 0) {
          const wanted = new Set(states.map((state) => state.toLowerCase()));
          items = items.filter((issue) => wanted.has(issue.state));
        }
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        if (orderBy?.field === 'CREATED_AT' && orderBy?.direction === 'DESC') {
          items.sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
        } else if (orderBy?.field === 'CREATED_AT' && orderBy?.direction === 'ASC') {
          items.sort((a, b) => a.createdSeq - b.createdSeq || a.number - b.number);
        } else {
          items.sort((a, b) => a.number - b.number);
        }
        return buildConnection(
          items.map((issue) => ({ number: issue.number, node: node('Issue', issue) })),
          args,
          'IssueConnection',
        );
      }
      case 'pullRequest': {
        const number = args.number as number;
        const pull = repo.pulls.find((entry) => entry.number === number);
        return node('PullRequest', pull ?? null);
      }
      case 'pullRequests': {
        let items = [...repo.pulls];
        const states = args.states as string[] | undefined;
        if (states !== undefined && states.length > 0) {
          const wanted = new Set(states.map((state) => state.toUpperCase()));
          items = items.filter((pull) => {
            const state = pull.state === 'merged' ? 'MERGED' : pull.state.toUpperCase();
            return wanted.has(state) || (wanted.has('CLOSED') && state === 'MERGED');
          });
        } else {
          items = items.filter((pull) => pull.state === 'open');
        }
        items.sort((a, b) => a.number - b.number);
        return buildConnection(
          items.map((pull) => ({ number: pull.number, node: node('PullRequest', pull) })),
          args,
          'PullRequestConnection',
        );
      }
      default:
        return undefined;
    }
  }

  private resolveIssue(parent: NodeValue, field: string, args: Record<string, unknown>): unknown {
    const forge = this.ctx.forge;
    const issue = parent?.data as Issue;
    switch (field) {
      case 'id': return issue.nodeId;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issue.state.toUpperCase();
      case 'body': return issue.body;
      case 'createdAt': return forge.isoTime(issue.createdSeq);
      case 'updatedAt': return forge.isoTime(issue.updatedSeq);
      case 'closedAt': return issue.closedSeq === null ? null : forge.isoTime(issue.closedSeq);
      case 'author': return node('User', { login: issue.author });
      case 'url': return `${this.ctx.baseUrl}/issues/${issue.number}`;
      case 'locked': return false;
      case 'assignees': return [];
      case 'milestone': return null;
      case 'reactions': return { totalCount: 0 };
      case 'labels': {
        return buildConnection(
          issue.labels.map((name, index) => ({ number: index + 1, node: node('Label', { name }) })),
          args,
          'LabelConnection',
        );
      }
      case 'comments': {
        return buildConnection(
          issue.comments.map((comment, index) => ({ number: index + 1, node: node('IssueComment', comment) })),
          args,
          'IssueCommentConnection',
        );
      }
      default:
        return undefined;
    }
  }

  private resolvePullRequest(parent: NodeValue, field: string, args: Record<string, unknown>): unknown {
    const forge = this.ctx.forge;
    const pull = parent?.data as Pull;
    switch (field) {
      case 'id': return pull.nodeId;
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'state': return pull.state === 'merged' ? 'MERGED' : pull.state.toUpperCase();
      case 'body': return pull.body;
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'headRef': return node('Ref', { name: pull.headRef, oid: pull.headSha });
      case 'baseRef': return node('Ref', { name: pull.baseRef, oid: pull.baseSha });
      case 'mergeable': {
        // GitHub's PullRequest.mergeable is a MergeableState enum, not a boolean.
        const repo = this.repoOfPull(pull);
        if (repo === null) return 'UNKNOWN';
        if (pull.state !== 'open') return 'CONFLICTING';
        const headTip = forge.branchTip(repo, pull.headRef);
        const baseTip = forge.branchTip(repo, pull.baseRef);
        if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
        const base = mergeBase(forge.lookup(repo), headTip, baseTip);
        if (base === null) return 'CONFLICTING';
        return forge.pullMergeable(repo, headTip, baseTip, base) ? 'MERGEABLE' : 'CONFLICTING';
      }
      case 'merged': return pull.merged;
      case 'createdAt': return forge.isoTime(pull.createdSeq);
      case 'updatedAt': return forge.isoTime(pull.updatedSeq);
      case 'closedAt': return pull.closedSeq === null ? null : forge.isoTime(pull.closedSeq);
      case 'mergedAt': return pull.mergedSeq === null ? null : forge.isoTime(pull.mergedSeq);
      case 'author': return node('User', { login: pull.author });
      case 'url': return `${this.ctx.baseUrl}/pull/${pull.number}`;
      case 'isDraft': return false;
      case 'additions': {
        const repo = this.repoOfPull(pull);
        if (repo === null) return 0;
        return forge.pullFiles(repo, pull).reduce((sum, file) => sum + file.additions, 0);
      }
      case 'deletions': {
        const repo = this.repoOfPull(pull);
        if (repo === null) return 0;
        return forge.pullFiles(repo, pull).reduce((sum, file) => sum + file.deletions, 0);
      }
      case 'changedFiles': {
        const repo = this.repoOfPull(pull);
        return repo === null ? 0 : forge.pullFiles(repo, pull).length;
      }
      case 'comments':
        return buildConnection([], args, 'IssueCommentConnection');
      case 'reviews':
        return buildConnection([], args, 'Connection');
      case 'commits':
        return buildConnection([], args, 'Connection');
      case 'files': {
        const repo = this.repoOfPull(pull);
        const files = repo === null ? [] : forge.pullFiles(repo, pull);
        return buildConnection(
          files.map((file, index) => ({
            number: index + 1,
            node: node('PullRequestFile', { path: file.path, additions: file.additions, deletions: file.deletions }),
          })),
          args,
          'PullRequestFileConnection',
        );
      }
      default:
        return undefined;
    }
  }

  private resolveUser(parent: NodeValue, field: string): unknown {
    const user = parent?.data as { login: string; name?: string; email?: string };
    switch (field) {
      case 'id': return globalId('User', user.login);
      case 'login': return user.login;
      case 'name': return user.name ?? user.login;
      case 'email': return user.email ?? '';
      case 'url': return `${this.ctx.baseUrl}/${user.login}`;
      case 'avatarUrl': return '';
      default: return undefined;
    }
  }

  private resolveRef(parent: NodeValue, field: string): unknown {
    const ref = parent?.data as { name: string; oid?: string };
    switch (field) {
      case 'id': return globalId('Ref', ref.name);
      case 'name': return ref.name;
      case 'target': return ref.oid === undefined ? null : node('Ref', { name: ref.name, oid: ref.oid });
      default: return undefined;
    }
  }

  private resolveConnection(parent: NodeValue, field: string, _args: Record<string, unknown>): unknown {
    const connection = parent?.data as { items: ConnectionItem[]; hasNextPage: boolean; totalCount: number } | undefined;
    if (connection === undefined) return undefined;
    switch (field) {
      case 'nodes':
        return connection.items.map((item) => item.node);
      case 'edges':
        return connection.items.map((item) => ({ node: item.node, cursor: cursorFor(item.number) }));
      case 'pageInfo': {
        const items = connection.items;
        return {
          hasNextPage: connection.hasNextPage,
          hasPreviousPage: false,
          startCursor: items.length === 0 ? null : cursorFor(items[0].number),
          endCursor: items.length === 0 ? null : cursorFor(items[items.length - 1].number),
        };
      }
      case 'totalCount':
        return connection.totalCount;
      default:
        return undefined;
    }
  }

  private resolveComment(parent: NodeValue, field: string): unknown {
    const comment = parent?.data as Comment;
    switch (field) {
      case 'id': return comment.nodeId;
      case 'body': return comment.body;
      case 'author': return node('User', { login: comment.author });
      case 'createdAt': return this.ctx.forge.isoTime(comment.createdSeq);
      case 'updatedAt': return this.ctx.forge.isoTime(comment.updatedSeq);
      default: return undefined;
    }
  }

  private resolveLabel(parent: NodeValue, field: string): unknown {
    const label = parent?.data as { name: string; color?: string; description?: string };
    switch (field) {
      case 'id': return globalId('Label', label.name);
      case 'name': return label.name;
      case 'color': return label.color ?? '';
      case 'description': return label.description ?? '';
      default: return undefined;
    }
  }

  private resolvePullRequestFile(parent: NodeValue, field: string): unknown {
    const file = parent?.data as { path: string; additions: number; deletions: number };
    switch (field) {
      case 'path': return file.path;
      case 'additions': return file.additions;
      case 'deletions': return file.deletions;
      case 'changeType': return 'MODIFIED';
      default: return undefined;
    }
  }

  private resolveIntrospectionType(parent: NodeValue, field: string, args: Record<string, unknown>): unknown {
    const type = parent?.data as { name: string };
    switch (field) {
      case 'name': return type.name;
      case 'kind': return TYPE_KIND[type.name] ?? 'OBJECT';
      case 'description': return null;
      case 'fields': {
        const names = TYPE_FIELDS[type.name];
        if (names === undefined) return null;
        return names.map((name) => ({ name, description: null, args: [], type: null }));
      }
      case 'enumValues': {
        const values = ENUM_VALUES[type.name];
        if (values === undefined) return null;
        return values.map((name) => ({ name, description: null }));
      }
      default: return undefined;
    }
  }

  private resolveIntrospectionSchema(_parent: NodeValue, field: string): unknown {
    switch (field) {
      case 'queryType': return { name: 'Query' };
      case 'mutationType': return { name: 'Mutation' };
      case 'types': return Object.keys(TYPE_FIELDS).map((name) => ({ name }));
      case 'description': return null;
      default: return undefined;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------------------------

export interface GraphQLResult {
  status: number;
  body: string;
}

export function handleGraphQL(forge: Forge, bodyText: string, baseUrl: string): GraphQLResult {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: JSON.stringify({ errors: [{ message: 'Request body is not valid JSON.' }] }) };
  }
  const operations = Array.isArray(body) ? body : [body];
  const results: Array<Record<string, unknown>> = [];
  for (const operationBody of operations) {
    if (operationBody === null || typeof operationBody !== 'object' || typeof (operationBody as Record<string, unknown>).query !== 'string') {
      results.push({ errors: [{ message: 'Each operation needs a query string.' }] });
      continue;
    }
    const record = operationBody as Record<string, unknown>;
    const query = record.query as string;
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    try {
      const parser = new Parser(query);
      const parsed = parser.parseDocument();
      const operation = selectOperation(parsed, record.operationName as string | undefined);
      if (operation === undefined) {
        results.push({ errors: [{ message: 'No operation matches the given operationName.' }] });
        continue;
      }
      const executor = new Executor({ forge, baseUrl });
      results.push(executor.execute(operation, variables));
    } catch (err) {
      results.push({ errors: [{ message: err instanceof Error ? err.message : String(err) }] });
    }
  }
  return { status: 200, body: JSON.stringify(Array.isArray(body) ? results : results[0]) };
}

function selectOperation(operations: Operation[], operationName: string | undefined): Operation | undefined {
  if (operationName === undefined) return operations[0];
  return operations.find((operation) => operation.name === operationName);
}
