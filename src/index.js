#!/usr/bin/env node
/**
 * Entry point. Two transports, one server definition.
 *
 *   node src/index.js              stdio  — local clients (Claude Code, the eval)
 *   node src/index.js --http       HTTP   — remote/serverless clients (otterbot on Vercel)
 *
 * stdio requires the client to spawn the process, which a serverless function
 * cannot reasonably do per invocation. HTTP is the transport for anything that
 * is not on the same machine.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createHttpServer } from 'node:http';

import { createServer } from './server.js';

const useHttp = process.argv.includes('--http') || process.env.MCP_TRANSPORT === 'http';
const PORT = Number(process.env.PORT ?? 3000);
const MCP_PATH = process.env.MCP_PATH ?? '/mcp';

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString());
}

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function startHttp() {
  const http = createHttpServer(async (req, res) => {
    // Cheap liveness probe — useful on any platform that health-checks.
    if (req.url === '/health') return send(res, 200, { status: 'ok' });

    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== MCP_PATH) return send(res, 404, { error: 'not found' });

    // Stateless: a fresh server and transport per request, so concurrent
    // clients cannot observe each other and nothing has to be cleaned up if a
    // connection drops mid-request.
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, await readBody(req));
    } catch (error) {
      console.error('request failed:', error);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    }
  });

  http.listen(PORT, () => {
    console.error(`earth-data MCP listening on http://localhost:${PORT}${MCP_PATH}`);
  });
}

if (useHttp) {
  await startHttp();
} else {
  await createServer().connect(new StdioServerTransport());
}
