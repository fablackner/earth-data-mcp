#!/usr/bin/env bun
/**
 * Entry point. Two transports, one server definition.
 *
 *   bun src/index.js              stdio  — local clients (Claude Code, the eval)
 *   bun src/index.js --http       HTTP   — remote/serverless clients (otterbot on Vercel)
 *
 * stdio requires the client to spawn the process, which a serverless function
 * cannot reasonably do per invocation. HTTP is the transport for anything that
 * is not on the same machine.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { handleMcpRequest } from './mcp-http.js';
import { createServer } from './server.js';

const useHttp = process.argv.includes('--http') || process.env.MCP_TRANSPORT === 'http';
const PORT = Number(process.env.PORT ?? 3000);
const MCP_PATH = process.env.MCP_PATH ?? '/mcp';

function startHttp() {
  Bun.serve({
    port: PORT,
    async fetch(request) {
      const url = new URL(request.url);

      // Cheap liveness probe — useful on any platform that health-checks.
      if (url.pathname === '/health') return Response.json({ status: 'ok' });

      if (url.pathname !== MCP_PATH) {
        return Response.json({ error: 'not found' }, { status: 404 });
      }

      return handleMcpRequest(request);
    },
  });

  console.error(`earth-data MCP listening on http://localhost:${PORT}${MCP_PATH}`);
}

if (useHttp) {
  await startHttp();
} else {
  // serveStdio owns the era decision: the opening exchange picks the protocol
  // revision and pins one instance from the factory for the connection. A server
  // wired straight to a StdioServerTransport would serve only the 2025 revision.
  serveStdio(() => createServer());
}
