import { fetchText } from './http.js';

const WEEKLY_RSS = 'https://volcano.si.edu/news/WeeklyVolcanoRSS.xml';

/** Strip CDATA wrappers, tags and entities out of an RSS field. */
function clean(value) {
  return value
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function field(item, tag) {
  return clean(item.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? '');
}

/**
 * The Smithsonian GVP / USGS Weekly Volcanic Activity Report.
 *
 * The feed is RSS with no query interface, so filtering happens here rather
 * than upstream. Titles are formatted "Volcano (Country)" — parsing that out
 * gives the agent a structured field to match on instead of a prose blob.
 */
export async function weeklyVolcanicActivity({ region, limit = 20 } = {}) {
  const xml = await fetchText(WEEKLY_RSS, { ttlMs: 3_600_000 });

  const entries = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    const title = field(item, 'title');
    // Titles look like "Etna (Italy) - Report for 2 July-8 July 2026 - New Eruptive
    // Activity". The country parenthesis is followed by more text, so the match
    // must not be end-anchored; whatever trails it is the report headline.
    const match = title.match(/^(.*?)\s*\(([^)]+)\)\s*(?:[-–]\s*)?(.*)$/);
    return {
      volcano: match ? match[1] : title,
      country: match ? match[2] : null,
      headline: match && match[3] ? match[3] : null,
      summary: field(item, 'description').slice(0, 800),
      url: field(item, 'link') || null,
    };
  });

  const needle = region?.toLowerCase();
  const filtered = needle
    ? entries.filter(
        (e) =>
          e.volcano.toLowerCase().includes(needle) ||
          (e.country ?? '').toLowerCase().includes(needle),
      )
    : entries;

  return {
    source: 'Smithsonian Global Volcanism Program / USGS Weekly Volcanic Activity Report',
    region_filter: region ?? null,
    total_reported: entries.length,
    count: Math.min(filtered.length, limit),
    volcanoes: filtered.slice(0, limit),
  };
}
