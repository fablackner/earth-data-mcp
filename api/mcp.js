import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createServer } from '../src/server.js';

/**
 * Serverless entry point (Vercel).
 *
 * One server and transport per request, in stateless mode. That is not a
 * compromise for serverless — it is the only shape that works there: instances
 * are created and destroyed per request, so nothing may be held between them,
 * and no sticky routing is required to send a client back to "its" instance.
 *
 * `src/index.js` remains the long-running entry point for stdio and for
 * self-hosted HTTP.
 */
export default async function handler(req, res) {
  if (req.method === 'GET' && req.query?.health !== undefined) {
    return res.status(200).json({ status: 'ok' });
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    // Vercel parses JSON bodies onto req.body; the transport wants it passed in.
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request failed:', error);
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  }
}
