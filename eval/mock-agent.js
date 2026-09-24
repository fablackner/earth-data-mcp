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

  // Right tool and place, but a one-day forecast cannot answer "tomorrow".
  'weather-vienna': {
    calls: [{ name: 'get_weather', input: { location: 'Vienna', forecast_days: 1 } }],
    text: 'It is currently mild in Vienna.',
  },

  // Correct on every dimension.
  'lightning-risk': {
    calls: [{ name: 'get_lightning_risk', input: { location: 'Munich', hours: 48 } }],
    text: 'No thunderstorms are forecast for Munich in the next 48 hours.',
  },

  // Correct on every dimension.
  'alerts-texas': {
    calls: [{ name: 'search_weather_alerts', input: { country: 'United States', area: 'TX' } }],
    text: 'The National Weather Service has active warnings in Texas.',
  },

  // Right tool, but without a location the aurora outlook is generic.
  'aurora-tromso': {
    calls: [{ name: 'get_space_weather', input: {} }],
    text: 'A minor geomagnetic storm is forecast.',
  },

  // Correct on every dimension.
  'air-quality-delhi': {
    calls: [{ name: 'get_air_quality', input: { location: 'Delhi' } }],
    text: 'Air quality in Delhi is currently rated unhealthy on the US AQI.',
  },

  // Correct on every dimension.
  'major-disasters': {
    calls: [{ name: 'search_disasters', input: { min_alert_level: 'Orange' } }],
    text: 'GDACS lists several Orange-level events.',
  },

  // Wrong tool: GDACS instead of NASA's tracker.
  'wildfires-now': {
    calls: [{ name: 'search_disasters', input: { types: ['WF'] } }],
    text: 'There are a few wildfires.',
  },

  // Right tool, but a town name geocodes onto land, where there is no sea.
  'marine-nazare': {
    calls: [{ name: 'get_marine_conditions', input: { location: 'Nazaré' } }],
    text: 'Waves off Nazaré are around 2 metres.',
  },

  // Right tool, but the answer quotes a stale figure instead of the tool result.
  'co2-now': {
    calls: [{ name: 'get_co2_record', input: {} }],
    text: 'CO2 is at about 415 ppm, rising by roughly 2 ppm per year.',
  },
};
