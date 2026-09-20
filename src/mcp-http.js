import { createMcpHandler } from '@modelcontextprotocol/server';

import { createServer } from './server.js';

/**
 * The HTTP entry point, built once and reused.
 *
 * `createMcpHandler` calls the factory per request, so nothing is shared
 * between clients — the property the stateless transport gave us before, now
 * owned by the entry itself. One factory serves both protocol revisions: the
 * 2026-07-28 path and, by default, a stateless fallback for 2025-era clients,
 * so the two can never drift apart.
 */
const handler = createMcpHandler(() => createServer());

/** Handle one stateless MCP request using Web Standard Request/Response APIs. */
export async function handleMcpRequest(request) {
  try {
    return await handler.fetch(request);
  } catch (error) {
    console.error('MCP request failed:', error);
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}
