import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { getEarthquake, searchEarthquakes, significantWeek } from './usgs.js';
import { weeklyVolcanicActivity } from './gvp.js';
import { UpstreamError } from './http.js';

/**
 * Build a fully-configured server instance.
 *
 * A factory rather than a module-level singleton: the stateless HTTP transport
 * builds one per request, so two clients can never share instance state.
 */
export function createServer() {
  const server = new McpServer({ name: 'earth-data', version: '1.0.0' });


  const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

  /**
   * Wrap a handler so upstream failures come back as tool errors the model can
   * read and react to, rather than as a transport-level crash. An agent that
   * sees "USGS is down" can say so; one that sees a dead server cannot.
   */
  function handler(fn) {
    return async (args) => {
      try {
        return json(await fn(args));
      } catch (error) {
        const message =
          error instanceof UpstreamError ? error.message : `unexpected failure: ${error.message}`;
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    };
  }

  //----------------------------------------------------------------------------
  // Tools — parameterised queries the model composes per question.
  //----------------------------------------------------------------------------

  server.registerTool(
    'search_earthquakes',
    {
      title: 'Search earthquakes',
      description:
        'Search the USGS earthquake catalog by magnitude, time window and location. ' +
        'Call this whenever the question involves seismic activity — recent quakes, ' +
        'quakes near a place, the largest quake in a period. ' +
        'Times are ISO 8601 (UTC). If start_time is omitted the window is the last 24 hours. ' +
        'For a location search, supply latitude, longitude and radius_km together.',
      inputSchema: {
        min_magnitude: z
          .number()
          .min(0)
          .max(10)
          .optional()
          .describe('Minimum magnitude, default 4.5. Use 2.5 for local/regional detail.'),
        start_time: z.string().optional().describe('ISO 8601 start of window, e.g. 2026-07-13T00:00:00Z'),
        end_time: z.string().optional().describe('ISO 8601 end of window. Defaults to now.'),
        latitude: z.number().min(-90).max(90).optional().describe('Centre latitude for a radius search'),
        longitude: z.number().min(-180).max(180).optional().describe('Centre longitude for a radius search'),
        radius_km: z.number().positive().max(20000).optional().describe('Search radius in kilometres'),
        limit: z.number().int().positive().max(100).optional().describe('Max events to return, default 20'),
        order_by: z
          .enum(['time', 'time-asc', 'magnitude', 'magnitude-asc'])
          .optional()
          .describe('Sort order. Use "magnitude" to find the largest event in a window.'),
      },
    },
    handler(searchEarthquakes),
  );

  server.registerTool(
    'get_earthquake',
    {
      title: 'Get earthquake detail',
      description:
        'Fetch full detail for one earthquake by its USGS event id (e.g. us7000abcd). ' +
        'Call this after search_earthquakes when the user asks to drill into a specific event.',
      inputSchema: {
        event_id: z.string().min(1).describe('USGS event id, as returned by search_earthquakes'),
      },
    },
    handler(({ event_id }) => getEarthquake(event_id)),
  );

  server.registerTool(
    'search_volcanic_activity',
    {
      title: 'Search volcanic activity',
      description:
        'Current Smithsonian/USGS Weekly Volcanic Activity Report, optionally filtered ' +
        'by volcano name or country. Call this for any question about erupting or ' +
        'restless volcanoes. The report covers the past week only — it cannot answer ' +
        'historical questions.',
      inputSchema: {
        region: z
          .string()
          .optional()
          .describe('Case-insensitive volcano-name or country filter, e.g. "Iceland"'),
        limit: z.number().int().positive().max(50).optional().describe('Max entries, default 20'),
      },
    },
    handler(weeklyVolcanicActivity),
  );

  //----------------------------------------------------------------------------
  // Resources — whole documents the client can read directly. These take no
  // arguments, so they belong here rather than in the tool surface: the model
  // does not need to decide anything to fetch them.
  //----------------------------------------------------------------------------

  server.registerResource(
    'significant-earthquakes-week',
    'hazard://earthquakes/significant-week',
    {
      title: 'Significant earthquakes, past 7 days',
      description: "USGS curated feed of globally significant events from the last week.",
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await significantWeek(), null, 2) },
      ],
    }),
  );

  server.registerResource(
    'weekly-volcanic-activity',
    'hazard://volcanoes/weekly-report',
    {
      title: 'Weekly Volcanic Activity Report',
      description: 'The full current Smithsonian GVP / USGS weekly report, unfiltered.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await weeklyVolcanicActivity({ limit: 50 }), null, 2),
        },
      ],
    }),
  );

  return server;
}
