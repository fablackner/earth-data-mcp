import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { createServer } from './server.js';

/** Handle one stateless MCP request using Web Standard Request/Response APIs. */
export async function handleMcpRequest(request) {
  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch (error) {
    console.error('MCP request failed:', error);
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}
