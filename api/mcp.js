import { handleMcpRequest } from '../src/mcp-http.js';

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
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.searchParams.has('health')) {
      return Response.json({ status: 'ok' });
    }

    return handleMcpRequest(request);
  },
};
