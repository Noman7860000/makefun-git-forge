// githttp.ts — git smart HTTP: ref advertisement (v2 upload-pack, v0 receive-pack),
// v2 ls-refs and fetch, v0 fetch, and receive-pack pushes. The wire format follows the
// git protocol: pkt-lines (4 hex length + payload, 0000 flush, 0001 delim), sideband
// bands (1 pack, 2 progress, 3 error), and packfiles (see gitobjs.ts).

import {
  ZERO_OID,
  collectReachable,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  readPack,
  writePack,
  type GitObject,
} from './gitobjs.ts';
import { Forge, type Repo } from './store.ts';

export const AGENT = 'forge/1.0';

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

/** Decode a buffer of pkt-lines into payloads; returns the payloads and the byte offset where framing ended. */
function decodePktLines(buffer: Buffer): { lines: Buffer[]; offset: number } {
  const lines: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      offset += 4;
      break; // flush ends the framed section
    }
    if (length === 1 || length === 2) {
      offset += 4;
      continue; // delim / response-end: skip
    }
    if (length < 4 || offset + length > buffer.length) break;
    lines.push(buffer.subarray(offset + 4, offset + length));
    offset += length;
  }
  return { lines, offset };
}

/** Split one sideband payload (band byte + data) into chunks of at most `maxData` data bytes. */
function sidebandPackets(data: Buffer, maxData = 65515): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += maxData) {
    const chunk = data.subarray(offset, Math.min(offset + maxData, data.length));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (data.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

// ---------------------------------------------------------------------------------------------
// ref listings
// ---------------------------------------------------------------------------------------------

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** All refs of a repo, HEAD first, then sorted: branches, tags, peeled tag targets. */
function listRefs(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(defaultRef);
  lines.push({
    oid: headOid ?? ZERO_OID,
    name: 'HEAD',
    symrefTarget: defaultRef,
    unborn: headOid === undefined,
  });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') line.peeled = parseTag(object.data).object;
    }
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

/** The v2 upload-pack advertisement: service line, version 2, capabilities. */
export function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    FLUSH,
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    FLUSH,
  ]);
}

/** The v0 receive-pack advertisement: service line, then one line per ref plus capabilities. */
export function v0ReceiveAdvertisement(repo: Repo): Buffer {
  const caps = 'report-status side-band-64k delete-refs ofs-delta thin-pack agent=' + AGENT;
  const symref = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), FLUSH];
  const refs = listRefs(repo);
  const refLines = refs.filter((ref) => ref.name !== 'HEAD');
  if (refLines.length === 0) {
    // An empty repository advertises only the capabilities pseudo-ref.
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${symref} ${caps}\n`));
  } else {
    // First line: HEAD with the capabilities (and the symref) attached after a NUL.
    const headOid = refs[0].oid;
    parts.push(pktLine(`${headOid} HEAD\0${symref} ${caps}\n`));
    for (const ref of refLines) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// fetch computation
// ---------------------------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  done?: boolean;
}

export interface FetchPlan {
  /** Objects to send, by id. */
  objects: Map<string, GitObject>;
  /** New shallow boundaries to report. */
  shallow: string[];
  /** Old boundaries that are no longer shallow. */
  unshallow: string[];
  /** Haves the server acknowledges (ancestors of, or equal to, a want). */
  acks: string[];
  /** Whether any have was acknowledged; otherwise the server sends NAK. */
  nak: boolean;
  /** wanted-refs lines: [oid, ref] for refs pointing at a want. */
  wantedRefs: Array<[string, string]>;
}

/** Work out exactly which objects a fetch must send, and the shallow bookkeeping. */
export function computeFetch(forge: Forge, repo: Repo, request: FetchRequest): FetchPlan {
  const lookup = forge.lookup(repo);
  const shallowSet = new Set(request.shallow);

  // Commits the client already holds: walk parents from the haves, stopping at (but
  // including) shallow boundaries, whose parents the client does not hold.
  const heldCommits = new Set<string>();
  {
    const queue = [...request.haves];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = lookup(oid);
      if (object === undefined || object.type !== 'commit') continue;
      heldCommits.add(oid);
      if (shallowSet.has(oid)) continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
  }
  // Objects the client already holds: the held commits and everything their trees name.
  const heldObjects = new Set<string>();
  for (const oid of heldCommits) {
    heldObjects.add(oid);
    const object = lookup(oid);
    if (object === undefined) continue;
    const tree = parseCommit(object.data).tree;
    heldObjects.add(tree);
    for (const [subOid] of collectReachable(lookup, [tree])) heldObjects.add(subOid);
  }

  // Walk from the wants. A commit is included when it is within the depth limit; held
  // commits are traversed (a deepen must pass through them) but never re-sent.
  const included = new Map<string, number>(); // commit -> distance from a want
  const queue: Array<{ oid: string; dist: number }> = [];
  const wantedTags: GitObject[] = [];
  for (const want of request.wants) {
    const object = lookup(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      wantedTags.push(object);
      queue.push({ oid: parseTag(object.data).object, dist: 0 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, dist: 0 });
    }
  }
  while (queue.length > 0) {
    const { oid, dist } = queue.shift()!;
    if (included.has(oid)) continue;
    // Depth N means N generations from a want: the want itself is generation 1, so a
    // commit at distance N is the boundary — it is named in shallow-info, never sent.
    if (request.depth !== undefined && dist >= request.depth) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    included.set(oid, dist);
    const expand = request.depth === undefined || dist < request.depth;
    if (!expand) continue;
    if (heldCommits.has(oid) && request.depth === undefined) continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!included.has(parent)) queue.push({ oid: parent, dist: dist + 1 });
    }
  }

  const objects = new Map<string, GitObject>();
  for (const tag of wantedTags) {
    const oid = hashObject('tag', tag.data);
    if (!heldObjects.has(oid)) objects.set(oid, tag);
  }
  for (const oid of included.keys()) {
    if (heldCommits.has(oid)) continue;
    const object = lookup(oid)!;
    objects.set(oid, object);
    const tree = parseCommit(object.data).tree;
    for (const [subOid, subObject] of collectReachable(lookup, [tree])) {
      if (!heldObjects.has(subOid)) objects.set(subOid, subObject);
    }
  }

  // Shallow bookkeeping, only for depth-limited fetches.
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (request.depth !== undefined) {
    const postHeld = new Set<string>([...heldCommits, ...included.keys()]);
    const boundary = new Set<string>();
    for (const oid of postHeld) {
      const object = lookup(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => !postHeld.has(parent))) boundary.add(oid);
      if (included.has(oid) && included.get(oid) === request.depth - 1) boundary.add(oid);
    }
    shallow = [...boundary].sort();
    unshallow = request.shallow.filter((oid) => !boundary.has(oid)).sort();
  }

  // Acknowledgements: a have the server holds that is an ancestor of (or equal to) a want.
  const acks: string[] = [];
  for (const have of request.haves) {
    if (!isOid(have)) continue;
    const held = lookup(have);
    if (held === undefined) continue;
    const acked = request.wants.some((want) => want === have || isAncestor(lookup, have, want));
    if (acked) acks.push(have);
  }
  const nak = acks.length === 0;

  // wanted-refs: refs pointing at a wanted object.
  const wantedRefs: Array<[string, string]> = [];
  const wantSet = new Set(request.wants);
  for (const [name, oid] of [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (wantSet.has(oid)) wantedRefs.push([oid, name]);
  }

  return { objects, shallow, unshallow, acks, nak, wantedRefs };
}

/** Serialise a fetch plan as a v2 upload-pack response body. */
export function v2FetchResponse(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.nak) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  }
  parts.push(pktLine('ready\n'));
  parts.push(DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  if (plan.wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const [oid, ref] of plan.wantedRefs) parts.push(pktLine(`${oid} ${ref}\n`));
    parts.push(DELIM);
  }
  if (plan.objects.size > 0) {
    parts.push(pktLine('packfile\n'));
    const pack = writePack(plan.objects.values());
    for (const packet of sidebandPackets(pack)) parts.push(packet);
    parts.push(FLUSH);
  }
  return Buffer.concat(parts);
}

/** Serialise a fetch plan as a v0 upload-pack response body (NAK/ACK lines + sideband pack). */
export function v0FetchResponse(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  if (plan.nak) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.size > 0) {
    const pack = writePack(plan.objects.values());
    for (const packet of sidebandPackets(pack)) parts.push(packet);
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// request parsing
// ---------------------------------------------------------------------------------------------

/** Parse a v2 command request body: the command line, then argument lines after the delim. */
function parseV2Command(body: Buffer): { command: string; args: string[] } | null {
  const { lines } = decodePktLines(body);
  if (lines.length === 0) return null;
  const first = lines[0].toString('utf8');
  const match = /^command=([a-z-]+)\n?$/.exec(first);
  if (match === null) return null;
  return { command: match[1], args: lines.slice(1).map((line) => line.toString('utf8')) };
}

/** Parse a v0 fetch request body (want/have/shallow/deepen lines across two flush sections). */
function parseV0Fetch(body: Buffer): FetchRequest | null {
  const text = body.toString('utf8');
  // A v0 request is pkt-lines; decode them all (both sections) and read the lines.
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) return null;
    lines.push(body.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let done = false;
  for (const line of lines) {
    const trimmed = line.replace(/\n$/, '');
    if (trimmed.startsWith('want ')) wants.push(trimmed.slice(5).split(' ')[0]);
    else if (trimmed.startsWith('have ')) haves.push(trimmed.slice(5).split(' ')[0]);
    else if (trimmed.startsWith('shallow ')) shallow.push(trimmed.slice(8).split(' ')[0]);
    else if (trimmed.startsWith('deepen ')) depth = Number.parseInt(trimmed.slice(7), 10);
    else if (trimmed === 'done') done = true;
  }
  if (wants.length === 0) return null;
  return { wants, haves, shallow, depth, done };
}

// ---------------------------------------------------------------------------------------------
// handlers: each returns { status, contentType, body }
// ---------------------------------------------------------------------------------------------

export interface GitResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const JSON_404 = (message = 'Not Found'): GitResult => ({
  status: 404,
  contentType: 'application/json',
  body: Buffer.from(JSON.stringify({ message }), 'utf8'),
});

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(forge: Forge, owner: string, repoName: string, service: string, gitProtocol: string | null): GitResult {
  const repo = forge.findRepo(owner, repoName);
  if (repo === undefined) return JSON_404();
  if (service === 'git-upload-pack') {
    // v2 whenever the client asks for it (or whenever: the v0-shaped answer is tolerated
    // by the suite, and v2 is required when the header is present).
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0ReceiveAdvertisement(repo) };
  }
  return JSON_404();
}

/** POST /{owner}/{repo}.git/git-upload-pack — ls-refs or fetch (v2), or a v0 fetch. */
export function handleUploadPack(forge: Forge, owner: string, repoName: string, body: Buffer): GitResult {
  const repo = forge.findRepo(owner, repoName);
  if (repo === undefined) return JSON_404();
  const command = parseV2Command(body);
  if (command !== null && command.command === 'ls-refs') {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleLsRefs(repo, command.args) };
  }
  if (command !== null && command.command === 'fetch') {
    const request = parseV2FetchArgs(command.args);
    if (request === null) {
      return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'malformed fetch request' }), 'utf8') };
    }
    const plan = computeFetch(forge, repo, request);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2FetchResponse(plan) };
  }
  // Not a v2 command: treat it as a v0 fetch request.
  const v0 = parseV0Fetch(body);
  if (v0 === null) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'malformed request' }), 'utf8') };
  }
  const plan = computeFetch(forge, repo, v0);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v0FetchResponse(plan) };
}

function parseV2FetchArgs(args: string[]): FetchRequest | null {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let done = false;
  for (const raw of args) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') done = true;
  }
  if (wants.length === 0) return null;
  return { wants, haves, shallow, depth, done };
}

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const raw of args) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const refs = listRefs(repo);
  const lines: Buffer[] = [];
  for (const ref of refs) {
    if (ref.unborn === true) {
      if (prefixes.length === 0 || prefixes.some((prefix) => ref.name.startsWith(prefix) || 'HEAD'.startsWith(prefix))) {
        lines.push(pktLine(`unborn ${ref.name}${ref.symrefTarget !== undefined ? ` symref-target:${ref.symrefTarget}` : ''}\n`));
      }
      continue;
    }
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (ref.name === 'HEAD' && symrefs && ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

/** POST /{owner}/{repo}.git/git-receive-pack — apply a push and report per ref. */
export function handleReceivePack(forge: Forge, owner: string, repoName: string, body: Buffer): GitResult {
  const repo = forge.findRepo(owner, repoName);
  if (repo === undefined) return JSON_404();
  const { lines, offset } = decodePktLines(body);
  if (lines.length === 0) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'malformed push' }), 'utf8') };
  }
  // The first command line may carry "\0<capabilities>".
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let sideband = false;
  for (const raw of lines) {
    const text = raw.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    if (nul >= 0) {
      const caps = text.slice(nul + 1).replace(/\n$/, '').split(' ');
      if (caps.includes('side-band-64k')) sideband = true;
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match === null) continue;
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  if (commands.length === 0) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'no push commands' }), 'utf8') };
  }
  // The pack follows the flush packet.
  const packBytes = body.subarray(offset);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = 'error';
    }
  }
  const reportLines: string[] = [];
  if (unpackOk) {
    reportLines.push('unpack ok\n');
  } else {
    reportLines.push('unpack error\n');
  }
  const lookup = forge.lookup(repo);
  for (const command of commands) {
    let ok = false;
    let reason = '';
    if (!unpackOk) {
      reason = 'unpacker error';
    } else if (command.newOid === ZERO_OID) {
      // Delete.
      const current = repo.refs.get(command.ref);
      if (current !== undefined && current === command.oldOid) {
        repo.refs.delete(command.ref);
        ok = true;
      } else {
        reason = 'non-fast-forward';
      }
    } else if (command.oldOid === ZERO_OID) {
      // Create.
      if (repo.refs.has(command.ref)) {
        reason = 'already exists';
      } else if (!repo.objects.has(command.newOid)) {
        reason = 'object not found';
      } else {
        repo.refs.set(command.ref, command.newOid);
        ok = true;
      }
    } else {
      // Update: the old value must match and the new tip must descend from it.
      const current = repo.refs.get(command.ref);
      if (current === undefined) {
        reason = 'non-fast-forward';
      } else if (current !== command.oldOid) {
        reason = 'non-fast-forward';
      } else if (!repo.objects.has(command.newOid)) {
        reason = 'object not found';
      } else if (!isAncestor(lookup, command.oldOid, command.newOid)) {
        reason = 'non-fast-forward';
      } else {
        repo.refs.set(command.ref, command.newOid);
        ok = true;
      }
    }
    if (ok) {
      reportLines.push(`ok ${command.ref}\n`);
      repo.pushedSeq = forge.tick();
    } else {
      reportLines.push(`ng ${command.ref} ${reason}\n`);
    }
  }
  const report = Buffer.concat([...reportLines.map((line) => pktLine(line)), FLUSH]);
  let responseBody: Buffer;
  if (sideband) {
    // The report-status stream is itself pkt-lined inside band 1.
    const banded: Buffer[] = [];
    for (let off = 0; off < report.length; off += 65515) {
      const chunk = report.subarray(off, Math.min(off + 65515, report.length));
      banded.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    banded.push(FLUSH);
    responseBody = Buffer.concat(banded);
  } else {
    responseBody = report;
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}

