import { fetchJson } from './http.js';

const SEARCH = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH';

/** The upstream returns at most this many events per query, with no cursor. */
const PAGE_SIZE = 100;

export const GDACS_TYPES = {
  EQ: 'earthquake',
  TC: 'tropical cyclone',
  FL: 'flood',
  VO: 'volcano',
  DR: 'drought',
  WF: 'wildfire',
};

const LEVELS = ['Green', 'Orange', 'Red'];

/**
 * GDACS (UN / European Commission) global disaster alerts.
 *
 * What sets it apart from the raw hazard feeds is the alert level: Green,
 * Orange or Red is an estimate of humanitarian *impact* — exposed population
 * and vulnerability — not of physical size. A M6 in an empty ocean is Green; a
 * M6 under a city may be Red.
 */
export async function searchDisasters({ types, min_alert_level = 'Orange', days = 14, country, limit = 20 }) {
  const levels = LEVELS.slice(LEVELS.indexOf(min_alert_level));
  const params = new URLSearchParams({
    fromDate: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10),
    toDate: new Date().toISOString().slice(0, 10),
    alertlevel: levels.join(';'),
  });
  if (types?.length) params.set('eventlist', types.join(';'));

  const feed = await fetchJson(`${SEARCH}?${params}`, { ttlMs: 900_000 });
  const features = feed.features ?? [];

  const needle = country?.toLowerCase();
  const events = features
    .map(({ properties: p, geometry }) => ({
      id: `${p.eventtype}${p.eventid}`,
      type: GDACS_TYPES[p.eventtype] ?? p.eventtype,
      name: p.name,
      alert_level: p.alertlevel,
      severity: p.severitydata?.severitytext?.trim() || null,
      countries: (p.affectedcountries ?? []).map((c) => c.countryname),
      from: p.fromdate,
      to: p.todate,
      is_current: p.iscurrent === 'true',
      latitude: geometry?.coordinates?.[1] ?? null,
      longitude: geometry?.coordinates?.[0] ?? null,
      report: p.url?.report ?? null,
    }))
    .filter((e) => !needle || e.countries.some((c) => c.toLowerCase().includes(needle)));
  events.sort((a, b) => LEVELS.indexOf(b.alert_level) - LEVELS.indexOf(a.alert_level));

  return {
    query: Object.fromEntries(params),
    // A full page means the upstream cut the list off; say so instead of
    // letting the agent report the count as a total.
    truncated_upstream: features.length >= PAGE_SIZE,
    total_matching: events.length,
    count: Math.min(events.length, limit),
    events: events.slice(0, limit),
  };
}
