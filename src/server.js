import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { getEarthquake, searchEarthquakes } from './usgs.js';
import { weeklyVolcanicActivity } from './gvp.js';
import { getAirQuality, getLightningRisk, getMarineConditions, getWeather } from './openmeteo.js';
import { searchWeatherAlerts, SEVERITIES } from './alerts.js';
import { EONET_CATEGORIES, searchNaturalEvents } from './eonet.js';
import { GDACS_TYPES, searchDisasters } from './gdacs.js';
import { spaceWeather } from './swpc.js';
import { co2MaunaLoa } from './gml.js';
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
      inputSchema: z.object({
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
      }),
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
      inputSchema: z.object({
        event_id: z.string().min(1).describe('USGS event id, as returned by search_earthquakes'),
      }),
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
      inputSchema: z.object({
        region: z
          .string()
          .optional()
          .describe('Case-insensitive volcano-name or country filter, e.g. "Iceland"'),
        limit: z.number().int().positive().max(50).optional().describe('Max entries, default 20'),
      }),
    },
    handler(weeklyVolcanicActivity),
  );

  // A place is either a name (geocoded) or a coordinate pair, never both —
  // shared by the point-forecast tools below.
  const place = {
    location: z
      .string()
      .min(1)
      .optional()
      .describe('Place name to geocode, e.g. "Vienna" or "Denver". Omit when giving coordinates.'),
    latitude: z.number().min(-90).max(90).optional().describe('Latitude, with longitude, instead of location'),
    longitude: z.number().min(-180).max(180).optional().describe('Longitude, with latitude, instead of location'),
  };

  server.registerTool(
    'get_weather',
    {
      title: 'Get weather',
      description:
        'Current conditions and daily forecast for one place (Open-Meteo, global): temperature, ' +
        'precipitation, wind and gusts, cloud cover, pressure, UV, sunrise/sunset. Call this for any ' +
        'question about the weather now, the coming days (up to 16), or the recent past (up to 92 days). ' +
        'Give either a place name or latitude+longitude. Times are local to the place.',
      inputSchema: z.object({
        ...place,
        forecast_days: z.number().int().min(1).max(16).optional().describe('Days of forecast including today, default 3'),
        past_days: z.number().int().min(0).max(92).optional().describe('Also include this many past days, default 0'),
      }),
    },
    handler(getWeather),
  );

  server.registerTool(
    'get_lightning_risk',
    {
      title: 'Get thunderstorm / lightning risk',
      description:
        'Hour-by-hour thunderstorm and lightning risk forecast for one place: model thunderstorm ' +
        'codes, CAPE (convective energy) and, over Europe only, the lightning potential index. ' +
        'Call this for questions about thunderstorms, lightning or storm risk at a place. ' +
        'This is a forecast, not a record of observed lightning strikes.',
      inputSchema: z.object({
        ...place,
        hours: z.number().int().min(1).max(168).optional().describe('Forecast window in hours, default 48'),
      }),
    },
    handler(getLightningRisk),
  );

  server.registerTool(
    'search_weather_alerts',
    {
      title: 'Search official weather warnings',
      description:
        'Active official weather warnings (storms, thunderstorms, wind, flood, heat, snow, fog, ...) ' +
        'from national weather services: the US National Weather Service, and MeteoAlarm for ' +
        'European countries. Call this for questions about current warnings or severe weather in a ' +
        'country or region. Not available for other countries.',
      inputSchema: z.object({
        country: z
          .string()
          .min(1)
          .describe('"United States", or a European country by English name, e.g. "Austria"'),
        area: z
          .string()
          .optional()
          .describe('Region filter: a US two-letter state code (e.g. "TX"), or a region-name substring'),
        latitude: z.number().min(-90).max(90).optional().describe('US only: warnings covering this point'),
        longitude: z.number().min(-180).max(180).optional().describe('US only: warnings covering this point'),
        min_severity: z.enum(SEVERITIES).optional().describe('Lowest CAP severity to include; default includes all'),
        event: z.string().optional().describe('Event-type substring, e.g. "thunderstorm", "flood"'),
        limit: z.number().int().positive().max(50).optional().describe('Max warnings, default 20'),
      }),
    },
    handler(searchWeatherAlerts),
  );

  server.registerTool(
    'get_air_quality',
    {
      title: 'Get air quality',
      description:
        'Air quality for one place (CAMS via Open-Meteo, global): European and US AQI with named ' +
        'bands, PM2.5, PM10, ozone, NO2, SO2, CO, dust, UV, and pollen (Europe only), plus the daily ' +
        'AQI peak for the coming days. Call this for questions about air pollution, smog, smoke, ' +
        'dust or pollen at a place.',
      inputSchema: z.object({
        ...place,
        forecast_days: z.number().int().min(1).max(5).optional().describe('Days of daily AQI peaks, default 2'),
      }),
    },
    handler(getAirQuality),
  );

  server.registerTool(
    'get_marine_conditions',
    {
      title: 'Get marine conditions',
      description:
        'Sea state at one point on the ocean (Open-Meteo marine models): wave height/period/direction, ' +
        'swell, sea-surface temperature, surface currents, sea level, plus daily wave maxima. Call this ' +
        'for questions about waves, surf, swell or sea temperature. Needs an offshore point — a coastal ' +
        'city name often geocodes inland, so prefer coordinates a few km out to sea.',
      inputSchema: z.object({
        ...place,
        forecast_days: z.number().int().min(1).max(8).optional().describe('Days of forecast, default 3'),
      }),
    },
    handler(getMarineConditions),
  );

  server.registerTool(
    'search_natural_events',
    {
      title: 'Search natural events (NASA EONET)',
      description:
        "NASA EONET's tracker of satellite-observed natural events: wildfires, severe storms " +
        '(tropical cyclones), icebergs and sea/lake ice, dust and haze, volcanoes, floods, and more. ' +
        'Call this to list what is happening now by category or region. Wildfire coverage is ' +
        'US-heavy. Returns the latest position and size (e.g. wind speed in kts, fire area in acres).',
      inputSchema: z.object({
        category: z.enum(EONET_CATEGORIES).optional().describe('Event category; omit for all'),
        status: z.enum(['open', 'closed', 'all']).optional().describe('Default "open" (ongoing)'),
        days: z.number().int().min(1).max(365).optional().describe('Only events active in the last N days, default 30'),
        bbox: z
          .object({
            min_lon: z.number().min(-180).max(180),
            max_lon: z.number().min(-180).max(180),
            min_lat: z.number().min(-90).max(90),
            max_lat: z.number().min(-90).max(90),
          })
          .optional()
          .describe('Bounding box to restrict the search to a region'),
        limit: z.number().int().positive().max(50).optional().describe('Max events, default 20'),
      }),
    },
    handler(searchNaturalEvents),
  );

  server.registerTool(
    'search_disasters',
    {
      title: 'Search disaster alerts (GDACS)',
      description:
        'GDACS (UN / European Commission) global disaster alerts for earthquakes, tropical cyclones, ' +
        'floods, volcanoes, droughts and wildfires. Each carries a Green/Orange/Red alert level that ' +
        'estimates humanitarian impact (people exposed), not physical size. Call this for questions ' +
        'about major or dangerous disasters worldwide, or which ones affect a country.',
      inputSchema: z.object({
        types: z
          .array(z.enum(Object.keys(GDACS_TYPES)))
          .optional()
          .describe('Event types: EQ earthquake, TC tropical cyclone, FL flood, VO volcano, DR drought, WF wildfire'),
        min_alert_level: z
          .enum(['Green', 'Orange', 'Red'])
          .optional()
          .describe('Lowest alert level, default Orange. Green includes many minor events.'),
        days: z.number().int().min(1).max(365).optional().describe('Look-back window in days, default 14'),
        country: z.string().optional().describe('Affected-country name substring, e.g. "Philippines"'),
        limit: z.number().int().positive().max(50).optional().describe('Max events, default 20'),
      }),
    },
    handler(searchDisasters),
  );

  server.registerTool(
    'get_space_weather',
    {
      title: 'Get space weather',
      description:
        'NOAA Space Weather Prediction Center: current and 3-day forecast of geomagnetic storms (G1–G5), ' +
        'radio blackouts (R) and solar radiation storms (S), the Kp index, and M/X-class solar flares in ' +
        'the past 7 days. Call this for questions about solar storms, flares, or the aurora / northern ' +
        'lights. Give the observer latitude+longitude to get an aurora-visibility outlook for that place.',
      inputSchema: z.object({
        latitude: z.number().min(-90).max(90).optional().describe('Observer latitude, for an aurora outlook'),
        longitude: z.number().min(-180).max(180).optional().describe('Observer longitude, for an aurora outlook'),
      }),
    },
    handler(spaceWeather),
  );

  server.registerTool(
    'get_co2_record',
    {
      title: 'Get atmospheric CO2 record',
      description:
        'NOAA GML Mauna Loa monthly mean atmospheric CO2 (the Keeling curve): latest month in ppm, ' +
        'year-over-year change, and the last 24 months. Call this for questions about current CO2 ' +
        'levels or how fast they are rising.',
      inputSchema: z.object({}),
    },
    handler(co2MaunaLoa),
  );

  return server;
}
