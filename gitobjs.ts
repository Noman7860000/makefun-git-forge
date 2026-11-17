// gitobjs.ts — the git object model: hashing, trees, commits, tags, packfiles and
// reachability. Written from the git object format (SHA-1 over "<type> <size>\0" + body)
// and the packfile format (PACK v2, zlib entries, OFS/REF deltas). No dependency beyond
// node:crypto and node:zlib.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

/** git's object id: SHA-1 over "<type> <size>\0" + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

export function makeObject(type: GitObjectType, data: Buffer): { oid: string; object: GitObject } {
  return { oid: hashObject(type, data), object: { type, data } };
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries, in stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerText = buffer.subarray(0, blank < 0 ? buffer.length : blank).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object. The message is stored verbatim (git keeps the trailing newline). */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerText = buffer.subarray(0, blank < 0 ? buffer.length : blank).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message,
  };
}

/** Build an annotated tag object. */
export function buildTag(fields: { object: string; type: GitObjectType; tag: string; tagger: string; message: string }): Buffer {
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger}\n\n${fields.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Apply a git delta to a base object, returning the reconstructed bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} does not match ${base.length}`);
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) copyOffset |= delta[offset++] << (i * 8);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) copySize |= delta[offset++] << (i * 8);
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy runs past the base');
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta has a zero opcode');
    }
  }
  if (produced !== resultSize) throw new Error(`delta produced ${produced} bytes, expected ${resultSize}`);
  return Buffer.concat(parts);
}

/** Read a whole packfile into objects keyed by id. Resolves OFS/REF deltas; verifies the trailer. */
export function readPack(pack: Buffer, baseLookup?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  // Verify the trailer checksum before trusting anything.
  const trailer = pack.subarray(pack.length - 20);
  const hash = createHash('sha1');
  hash.update(pack.subarray(0, pack.length - 20));
  if (!hash.digest().equals(trailer)) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    type: GitObjectType | 'ofs-delta' | 'ref-delta';
    data: Buffer;
    ofsBase?: number;
    refBase?: string;
    offset: number;
  }
  const entries: RawEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset++];
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset encoded as a variable-length integer.
      let b = pack[offset++];
      let baseOffset = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++];
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
      }
      const inflated = inflateEntry(pack, offset);
      offset += inflated.consumed;
      entries.push({ type: 'ofs-delta', data: inflated.data, ofsBase: entryOffset - baseOffset, offset: entryOffset });
    } else if (typeCode === 7) {
      const refBase = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateEntry(pack, offset);
      offset += inflated.consumed;
      entries.push({ type: 'ref-delta', data: inflated.data, refBase, offset: entryOffset });
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`pack entry has unknown type code ${typeCode}`);
      const inflated = inflateEntry(pack, offset);
      if (inflated.data.length !== size) throw new Error(`pack entry inflated to ${inflated.data.length} bytes, header said ${size}`);
      offset += inflated.consumed;
      entries.push({ type, data: inflated.data, offset: entryOffset });
    }
  }

  // Resolve in pack order (delta bases always precede their deltas in a well-formed pack).
  const byOffset = new Map<number, GitObject>();
  const objects = new Map<string, GitObject>();
  for (const entry of entries) {
    let object: GitObject;
    if (entry.type === 'ofs-delta') {
      const base = byOffset.get(entry.ofsBase ?? -1);
      if (base === undefined) throw new Error('OFS_DELTA base is missing');
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.type === 'ref-delta') {
      const base = objects.get(entry.refBase ?? '') ?? baseLookup?.(entry.refBase ?? '');
      if (base === undefined) throw new Error('REF_DELTA base is missing');
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: entry.type, data: entry.data };
    }
    byOffset.set(entry.offset, object);
    objects.set(hashObject(object.type, object.data), object);
  }
  return objects;
}

/** How many bytes of `pack` from `offset` the zlib stream starting there consumes. */
function inflatedConsumed(pack: Buffer, offset: number): number {
  // inflateSync ignores bytes past a stream's end and throws on a truncated stream, so
  // "inflation succeeds" is monotonic in the slice end: binary-search the smallest end
  // that inflates cleanly. That end is exactly the stream's end (deflate data + Adler-32).
  // The stream may end exactly at `limit` (the last entry runs up to the trailer), so
  // reaching the limit is a valid end, not a truncation: only a failure at the limit
  // means the stream is truncated.
  const limit = pack.length - 20; // never consume the trailer
  try {
    inflateSync(pack.subarray(offset, limit));
  } catch {
    throw new Error('pack entry has a truncated zlib stream');
  }
  let lo = offset;
  let hi = limit;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(pack.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo - offset;
}

/** Whether this Node's inflateSync reports the consumed input length (Node 22.2+). */
let inflateInfoSupported: boolean | null = null;

/** Inflate the zlib stream at `offset`, returning its bytes and how many input bytes it used. */
function inflateEntry(pack: Buffer, offset: number): { data: Buffer; consumed: number } {
  // One inflate: with { info: true } the engine reports exactly how many input bytes the
  // stream consumed (trailing bytes are ignored), so there is no need to hunt for the
  // stream's end by re-inflating slices. Older Nodes ignore the option; then the
  // binary search below finds the end instead.
  if (inflateInfoSupported !== false) {
    try {
      const result = inflateSync(pack.subarray(offset), { info: true }) as unknown as {
        buffer: Buffer;
        engine: { bytesWritten: number };
      };
      const consumed = result.engine.bytesWritten;
      if (typeof consumed === 'number' && consumed > 0) {
        inflateInfoSupported = true;
        return { data: result.buffer, consumed };
      }
      inflateInfoSupported = false;
    } catch {
      // Either the stream is truncated or this Node does not support { info: true }:
      // the binary search distinguishes the two (it throws only on a real truncation).
      if (inflateInfoSupported === true) throw new Error('pack entry has a truncated zlib stream');
    }
  }
  const consumed = inflatedConsumed(pack, offset);
  return { data: inflateSync(pack.subarray(offset, offset + consumed)), consumed };
}

/** Write a packfile (version 2, plain objects, no deltas) for the given objects. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const object of list) {
    const typeCode = TYPE_CODES[object.type];
    const size = object.data.length;
    // Varint header: low 4 bits of size in the first byte, then 7 bits per byte.
    const headerBytes: number[] = [];
    let remaining = size;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const hash = createHash('sha1');
  hash.update(body);
  return Buffer.concat([body, hash.digest()]);
}

// ---------------------------------------------------------------------------------------------
// graph walks over an object lookup
// ---------------------------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** Every object reachable from the tips (commits, their trees/blobs, tag targets). */
export function collectReachable(lookup: ObjectLookup, tips: Iterable<string>): Map<string, GitObject> {
  const found = new Map<string, GitObject>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (found.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    found.set(oid, object);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      stack.push(view.tree);
      for (const parent of view.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return found;
}

/** All commit ids reachable from a tip through parent edges. */
export function commitAncestors(lookup: ObjectLookup, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
export function isAncestor(lookup: ObjectLookup, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return commitAncestors(lookup, descendant).has(ancestor);
}

/** A nearest common ancestor of two commits (first found walking up from `b`). */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  const ancestorsOfA = commitAncestors(lookup, a);
  const queue = [b];
  const seen = new Set<string>([b]);
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (ancestorsOfA.has(oid)) return oid;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return null;
}

/** Flatten a tree (by oid) to path -> { oid, mode }, recursing into subtrees. */
export function flattenTree(lookup: ObjectLookup, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const object = lookup(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [subPath, sub] of flattenTree(lookup, entry.oid, path)) out.set(subPath, sub);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** The file-level difference between two trees: added / removed / modified paths. */
export function diffTrees(
  lookup: ObjectLookup,
  baseTreeOid: string | null,
  headTreeOid: string | null,
): Array<{ path: string; status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null }> {
  const base = baseTreeOid === null ? new Map() : flattenTree(lookup, baseTreeOid);
  const head = headTreeOid === null ? new Map() : flattenTree(lookup, headTreeOid);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: Array<{ path: string; status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null }> = [];
  for (const path of [...paths].sort()) {
    const oldEntry = base.get(path);
    const newEntry = head.get(path);
    if (oldEntry === undefined && newEntry !== undefined) out.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
    else if (oldEntry !== undefined && newEntry === undefined) out.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
    else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
      out.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
    }
  }
  return out;
}

/** Count added/removed lines between two texts (a small LCS diff; files here are small). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // Strip a single trailing empty line produced by a final newline on both sides.
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const m = oldLines.length;
  const n = newLines.length;
  // LCS lengths via one row at a time (files are small; O(m*n) is fine).
  const prev = new Array<number>(n + 1).fill(0);
  const curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    for (let j = 0; j <= n; j += 1) prev[j] = curr[j];
  }
  const lcs = prev[n];
  return { additions: n - lcs, deletions: m - lcs };
}
