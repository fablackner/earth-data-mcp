import { fetchJson, UpstreamError } from './http.js';

const FDSN_QUERY = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const SIGNIFICANT_WEEK =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson';

/** USGS caps a single query at 20 000 events; we stay far below that on purpose. */
const MAX_LIMIT = 100;

function toIso(value) {
  return new Date(value).toISOString();
}

/**
 * Flatten one GeoJSON feature into a compact record. The raw feature carries
 * ~30 fields, most of them internal USGS bookkeeping — sending all of them
 * would burn context for no gain.
 */
function summarizeFeature(feature) {
  const p = feature.properties;
  const [longitude, latitude, depthKm] = feature.geometry.coordinates;
  return {
    id: feature.id,
    magnitude: p.mag,
    magnitude_type: p.magType,
    place: p.place,
    time: toIso(p.time),
    latitude,
    longitude,
    depth_km: depthKm,
    felt_reports: p.felt ?? 0,
    alert_level: p.alert ?? null,
    tsunami_flag: Boolean(p.tsunami),
    url: p.url,
  };
}

/**
 * Query the USGS FDSN event service.
 *
 * Every argument maps onto a documented FDSN parameter, which is what makes
 * the tool's behaviour auditable: a given tool call can be replayed as a plain
 * URL and checked against the raw feed.
 */
export async function searchEarthquakes({
  min_magnitude = 4.5,
  start_time,
  end_time,
  latitude,
  longitude,
  radius_km,
  limit = 20,
  order_by = 'time',
}) {
  // Partial location triples are a common agent mistake; fail loudly rather
  // than silently returning worldwide results the caller didn't ask for.
  const located = [latitude, longitude, radius_km].filter((v) => v !== undefined);
  if (located.length > 0 && located.length < 3) {
    throw new UpstreamError(
      'latitude, longitude and radius_km must be supplied together for a radius search',
    );
  }

  const params = new URLSearchParams({
    format: 'geojson',
    minmagnitude: String(min_magnitude),
    limit: String(Math.min(limit, MAX_LIMIT)),
    orderby: order_by,
  });
  // Default window: the last 24 hours. Stated in the tool description so the
  // model can rely on it instead of guessing a start date.
  params.set(
    'starttime',
    start_time ? toIso(start_time) : toIso(Date.now() - 24 * 60 * 60 * 1000),
  );
  if (end_time) params.set('endtime', toIso(end_time));
  if (located.length === 3) {
    params.set('latitude', String(latitude));
    params.set('longitude', String(longitude));
    params.set('maxradiuskm', String(radius_km));
  }

  const feed = await fetchJson(`${FDSN_QUERY}?${params}`, { ttlMs: 300_000 });
  const events = (feed.features ?? []).map(summarizeFeature);
  return {
    query: Object.fromEntries(params),
    count: events.length,
    events,
  };
}

/** Full detail for a single event, by its USGS event id (e.g. `us7000abcd`). */
export async function getEarthquake(eventId) {
  const params = new URLSearchParams({ format: 'geojson', eventid: eventId });
  const feature = await fetchJson(`${FDSN_QUERY}?${params}`, { ttlMs: 3_600_000 });
  if (!feature?.properties) {
    throw new UpstreamError(`no earthquake found with id ${eventId}`);
  }
  const p = feature.properties;
  return {
    ...summarizeFeature(feature),
    status: p.status,
    significance: p.sig,
    network: p.net,
    magnitude_error: p.magError ?? null,
    station_count: p.nst ?? null,
    // The products block is large and mostly URLs to other USGS pages.
    available_products: Object.keys(p.products ?? {}),
  };
}

/** The curated "significant events, past 7 days" feed, as a browsable document. */
export async function significantWeek() {
  const feed = await fetchJson(SIGNIFICANT_WEEK, { ttlMs: 300_000 });
  return {
    title: feed.metadata?.title,
    generated: toIso(feed.metadata?.generated ?? Date.now()),
    count: feed.features?.length ?? 0,
    events: (feed.features ?? []).map(summarizeFeature),
  };
}
