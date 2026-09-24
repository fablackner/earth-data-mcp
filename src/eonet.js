import { fetchJson } from './http.js';

const EVENTS = 'https://eonet.gsfc.nasa.gov/api/v3/events';

/** EONET category ids, as accepted by its `category` parameter. */
export const EONET_CATEGORIES = [
  'drought',
  'dustHaze',
  'earthquakes',
  'floods',
  'landslides',
  'manmade',
  'seaLakeIce',
  'severeStorms',
  'snow',
  'tempExtremes',
  'volcanoes',
  'waterColor',
  'wildfires',
];

/**
 * Flatten one EONET event. An event carries one geometry per observation — a
 * tracked cyclone can have dozens — so only the latest position is kept, plus
 * the count so the agent knows a track exists.
 */
function summarizeEvent(event) {
  const latest = event.geometry.at(-1) ?? {};
  const [longitude, latitude] = latest.type === 'Point' ? latest.coordinates : [null, null];
  return {
    id: event.id,
    title: event.title,
    description: event.description ?? null,
    categories: event.categories.map((c) => c.id),
    status: event.closed ? 'closed' : 'open',
    closed: event.closed ?? null,
    first_observed: event.geometry[0]?.date ?? null,
    last_observed: latest.date ?? null,
    latitude,
    longitude,
    // e.g. 35 kts for a storm, 740 acres for a fire, km² for an iceberg.
    magnitude: latest.magnitudeValue != null ? { value: latest.magnitudeValue, unit: latest.magnitudeUnit } : null,
    observations: event.geometry.length,
    sources: event.sources.map((s) => s.url),
  };
}

/**
 * NASA's Earth Observatory Natural Event Tracker: satellite-observed natural
 * events — wildfires, severe storms, icebergs, dust, volcanoes — curated from
 * operational sources (JTWC, IRWIN, the US National Ice Center, ...).
 */
export async function searchNaturalEvents({
  category,
  status = 'open',
  days = 30,
  bbox,
  limit = 20,
}) {
  const params = new URLSearchParams({ status, days: String(days) });
  if (category) params.set('category', category);
  if (bbox) {
    // EONET wants min_lon,max_lat,max_lon,min_lat (upper-left, lower-right).
    params.set('bbox', [bbox.min_lon, bbox.max_lat, bbox.max_lon, bbox.min_lat].join(','));
  }

  const feed = await fetchJson(`${EVENTS}?${params}`, { ttlMs: 900_000 });
  const events = (feed.events ?? []).map(summarizeEvent);
  // Most recently observed first: the agent is almost always asking "what's
  // happening now", and EONET's own order is not by recency.
  events.sort((a, b) => Date.parse(b.last_observed ?? 0) - Date.parse(a.last_observed ?? 0));

  const byCategory = {};
  for (const e of events) for (const c of e.categories) byCategory[c] = (byCategory[c] ?? 0) + 1;

  return {
    query: Object.fromEntries(params),
    total_matching: events.length,
    by_category: byCategory,
    count: Math.min(events.length, limit),
    events: events.slice(0, limit),
  };
}
