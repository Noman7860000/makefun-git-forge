// app.ts — the forge's HTTP server: one Node http server, one Forge, four surfaces.
// Routing: /healthz (no auth), /api/graphql, /mcp, /api/v3/* (REST) and
// /{owner}/{repo}.git/* (git smart HTTP). Every other path is a 404 {message}.
// Authentication: every surface except /healthz requires
// `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the token in this process's env);
// a missing or wrong token is 401. Every reply carries a non-empty
// X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';

const MAX_BODY_BYTES = 128 * 1024 * 1024;

export function createApp(): Server {
  const forge = new Forge();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[forge] unhandled request error: ${message}\n`);
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json', 'x-github-request-id': `req-${++requestCounter}` });
      }
      response.end(JSON.stringify({ message: 'Internal Server Error' }));
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = `req-${++requestCounter}`;
    const method = (request.method ?? 'GET').toUpperCase();
    const rawUrl = request.url ?? '/';
    const url = new URL(rawUrl, 'http://127.0.0.1');
    const path = url.pathname;
    const host = request.headers.host ?? '127.0.0.1';
    const baseUrl = `http://${host}`;

    const send = (status: number, headers: Record<string, string>, body: string | Buffer): void => {
      response.writeHead(status, { 'x-github-request-id': requestId, ...headers });
      response.end(body);
    };
    const sendJson = (status: number, value: unknown, extraHeaders: Record<string, string> = {}): void => {
      send(status, { 'content-type': 'application/json', ...extraHeaders }, JSON.stringify(value));
    };

    // /healthz takes no token.
    if (path === '/healthz' && method === 'GET') {
      sendJson(200, { ok: true });
      return;
    }

    // Everything else needs the trial's bearer token.
    const authorization = request.headers.authorization ?? '';
    if (authorization !== `Bearer ${expectedToken}`) {
      sendJson(401, { message: 'Bad credentials' });
      return;
    }

    const body = await readBody(request, response, requestId);
    if (body === null) return; // readBody already answered (too large)

    // GraphQL.
    if (path === '/api/graphql' && method === 'POST') {
      const result = handleGraphQL(forge, body.toString('utf8'), baseUrl);
      send(result.status, { 'content-type': 'application/json' }, result.body);
      return;
    }

    // MCP.
    if (path === '/mcp' && method === 'POST') {
      const result = handleMcp(forge, body.toString('utf8'), baseUrl);
      send(result.status, { 'content-type': 'application/json', ...(result.headers ?? {}) }, result.body);
      return;
    }

    // REST v3.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      const result = handleRest(forge, {
        method,
        path,
        query: url.searchParams,
        headers: headersRecord(request),
        body: method === 'GET' || method === 'HEAD' ? null : body,
        baseUrl,
      });
      send(result.status, result.headers, result.body);
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/info/refs, /git-upload-pack, /git-receive-pack.
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (gitMatch !== null) {
      const owner = decodeURIComponent(gitMatch[1]);
      const repoName = decodeURIComponent(gitMatch[2]);
      const service = gitMatch[3];
      if (service === 'info/refs' && method === 'GET') {
        const result = handleInfoRefs(forge, owner, repoName, url.searchParams.get('service') ?? '', request.headers['git-protocol'] ?? null);
        send(result.status, { 'content-type': result.contentType }, result.body);
        return;
      }
      if (service === 'git-upload-pack' && method === 'POST') {
        const result = handleUploadPack(forge, owner, repoName, body);
        send(result.status, { 'content-type': result.contentType }, result.body);
        return;
      }
      if (service === 'git-receive-pack' && method === 'POST') {
        const result = handleReceivePack(forge, owner, repoName, body);
        send(result.status, { 'content-type': result.contentType }, result.body);
        return;
      }
      sendJson(405, { message: 'Method Not Allowed' });
      return;
    }

    sendJson(404, { message: 'Not Found' });
  }

  return server;
}

function headersRecord(request: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') out[name.toLowerCase()] = value;
  }
  return out;
}

/** Read a request body fully (null when the body is over the cap — the 413 is already sent). */
async function readBody(request: IncomingMessage, response: ServerResponse, requestId: string): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      response.writeHead(413, { 'content-type': 'application/json', 'x-github-request-id': requestId });
      response.end(JSON.stringify({ message: 'Request body too large' }));
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
