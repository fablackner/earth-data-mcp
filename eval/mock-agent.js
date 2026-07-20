/**
 * A scripted, deliberately imperfect agent used by `MOCK=1 bun eval/run.js`.
 *
 * Each entry reproduces a failure mode worth being able to detect:
 * a right tool with an out-of-band argument, a half-answered multi-part
 * question, an over-triggered tool on a definitional question. If the harness
 * reports everything green against this script, the scorer is broken.
 */
const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

export const script = {
  // Right tool, right arguments, wrong number in the answer.
  'largest-quake-week': {
    calls: [
      {
        name: 'search_earthquakes',
        input: { min_magnitude: 4.5, start_time: sevenDaysAgo, order_by: 'magnitude', limit: 1 },
      },
    ],
    text: 'The largest earthquake was magnitude 9.9 somewhere in the Pacific.',
  },

  // Right tool, right centre, but a radius that quietly turns "near Tokyo"
  // into a hemisphere-wide search.
  'quakes-near-tokyo': {
    calls: [
      {
        name: 'search_earthquakes',
        input: {
          latitude: 35.68,
          longitude: 139.69,
          radius_km: 5000,
          start_time: sevenDaysAgo,
        },
      },
    ],
    text: 'There were several earthquakes in the region.',
  },

  // Correct on every dimension — the control case.
  'volcano-iceland': {
    calls: [{ name: 'search_volcanic_activity', input: { region: 'Iceland' } }],
    text: 'No Icelandic volcano appears in the current weekly report.',
  },

  // Half the question answered: seismic covered, volcanic silently dropped.
  'multi-hazard-indonesia': {
    calls: [
      { name: 'search_earthquakes', input: { latitude: -2.5, longitude: 118, radius_km: 2000 } },
    ],
    text: 'Indonesia has had recent seismic activity.',
  },

  // Correctly answered from own knowledge without touching the weekly feed.
  'historical-out-of-range': {
    calls: [],
    text: 'Mount St. Helens erupted catastrophically in May 1980; my tools only cover the current week.',
  },

  // Over-triggering: a definitional question that cost a live API round trip.
  'no-tool-needed': {
    calls: [{ name: 'search_earthquakes', input: { min_magnitude: 4.5 } }],
    text: 'Moment magnitude measures the energy released by an earthquake.',
  },

  // Both steps of the chain executed.
  'drill-into-event': {
    calls: [
      { name: 'search_earthquakes', input: { order_by: 'magnitude', start_time: sevenDaysAgo } },
      { name: 'get_earthquake', input: { event_id: 'us7000abcd' } },
    ],
    text: 'Its significance score is 890.',
  },
};
