import { fetchJson, UpstreamError } from './http.js';

const NWS_ALERTS = 'https://api.weather.gov/alerts/active';
const METEOALARM = 'https://feeds.meteoalarm.org/api/v1/warnings/feeds-';

/** CAP severity levels, weakest first. Both upstreams use the CAP vocabulary. */
const SEVERITIES = ['Minor', 'Moderate', 'Severe', 'Extreme'];

const US_NAMES = new Set(['us', 'usa', 'united states', 'united states of america']);

const rank = (severity) => SEVERITIES.indexOf(severity);

/**
 * Official weather warnings from national met services.
 *
 * Two upstreams behind one tool, selected by country: the US National Weather
 * Service, and MeteoAlarm, which aggregates the national services of ~38
 * European countries. The agent asks "any warnings in X?" either way; which
 * feed answers it is an implementation detail.
 */
export async function searchWeatherAlerts({
  country,
  area,
  latitude,
  longitude,
  min_severity,
  event,
  limit = 20,
}) {
  const isUs = US_NAMES.has(country.trim().toLowerCase());
  const hasPoint = latitude !== undefined || longitude !== undefined;
  if (hasPoint && (latitude === undefined || longitude === undefined)) {
    throw new UpstreamError('latitude and longitude must be supplied together');
  }
  if (hasPoint && !isUs) {
    // MeteoAlarm has no point query; filtering by region name is the only
    // honest option, so say so instead of silently ignoring the point.
    throw new UpstreamError('point search is only supported for the United States; use area for other countries');
  }

  const { source, alerts } = isUs
    ? await nwsAlerts({ area, latitude, longitude })
    : await meteoAlarmAlerts(country);

  const needleArea = area?.toLowerCase();
  const needleEvent = event?.toLowerCase();
  const now = Date.now();
  const filtered = alerts.filter(
    (a) =>
      // Unset means no floor: NWS issues some statements with severity "Unknown".
      (!min_severity || rank(a.severity) >= rank(min_severity)) &&
      // MeteoAlarm keeps expired warnings in the feed for a while.
      (!a.expires || Date.parse(a.expires) > now) &&
      // For the US a two-letter state code has already been applied upstream.
      (!needleArea || (isUs && /^[a-z]{2}$/.test(needleArea)) || a.area.toLowerCase().includes(needleArea)) &&
      (!needleEvent || a.event.toLowerCase().includes(needleEvent)),
  );
  filtered.sort((a, b) => rank(b.severity) - rank(a.severity));

  return {
    source,
    filters: { country, area: area ?? null, min_severity: min_severity ?? null, event: event ?? null },
    total_active: filtered.length,
    count: Math.min(filtered.length, limit),
    alerts: filtered.slice(0, limit),
  };
}

async function nwsAlerts({ area, latitude, longitude }) {
  const params = new URLSearchParams({ status: 'actual' });
  if (latitude !== undefined) params.set('point', `${latitude},${longitude}`);
  else if (area && /^[a-z]{2}$/i.test(area)) params.set('area', area.toUpperCase());

  const feed = await fetchJson(`${NWS_ALERTS}?${params}`, { ttlMs: 300_000 });
  return {
    source: 'US National Weather Service (api.weather.gov)',
    alerts: (feed.features ?? []).map(({ properties: p }) => ({
      event: p.event,
      severity: p.severity,
      urgency: p.urgency,
      certainty: p.certainty,
      headline: p.headline,
      area: p.areaDesc ?? '',
      onset: p.onset ?? p.effective,
      expires: p.ends ?? p.expires,
      sender: p.senderName,
      description: p.description?.slice(0, 600) ?? null,
      instruction: p.instruction?.slice(0, 300) ?? null,
    })),
  };
}

async function meteoAlarmAlerts(country) {
  const slug = country.trim().toLowerCase().replace(/\s+/g, '-');
  let feed;
  try {
    feed = await fetchJson(`${METEOALARM}${slug}`, { ttlMs: 300_000 });
  } catch (error) {
    if (error.status === 404) {
      throw new UpstreamError(
        `no warning feed for "${country}". Covered: the United States (NWS) and MeteoAlarm ` +
          'member countries in Europe, by English name, e.g. "Austria", "United Kingdom".',
      );
    }
    throw error;
  }

  return {
    source: 'MeteoAlarm (EUMETNET, European national weather services)',
    alerts: (feed.warnings ?? []).map(({ alert }) => {
      // Each warning carries one info block per language; prefer English.
      const infos = alert.info ?? [];
      const info = infos.find((i) => i.language?.startsWith('en')) ?? infos[0] ?? {};
      const level = info.parameter?.find((p) => p.valueName === 'awareness_level')?.value;
      return {
        event: info.event ?? '',
        severity: info.severity,
        // "2; yellow; Moderate" → "yellow": the colour is what the public sees.
        awareness_level: level?.split(';')[1]?.trim() ?? null,
        urgency: info.urgency,
        certainty: info.certainty,
        headline: info.headline ?? null,
        area: (info.area ?? []).map((a) => a.areaDesc).join('; '),
        onset: info.onset ?? info.effective ?? null,
        expires: info.expires ?? null,
        sender: info.senderName ?? null,
        language: info.language ?? null,
        description: info.description?.slice(0, 600) ?? null,
      };
    }),
  };
}

export { SEVERITIES };
