import { searchEarthquakes } from '../src/usgs.js';
import { weeklyVolcanicActivity } from '../src/gvp.js';
import { co2MaunaLoa } from '../src/gml.js';

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);

/**
 * Assertion helpers.
 *
 * Argument scoring is predicate-based, never exact-match. There is no single
 * correct radius for "near Tokyo" and no single correct start_time for "last
 * week" — a grader that demands one measures obedience to an arbitrary
 * convention, not competence. What is genuinely checkable is whether each
 * argument falls in the band that answers the question.
 */
const ok = (label) => ({ label, pass: true });
const fail = (label, detail) => ({ label, pass: false, detail });

function check(label, condition, detail) {
  return condition ? ok(label) : fail(label, detail);
}

function nearlyEqual(actual, expected, tolerance) {
  return typeof actual === 'number' && Math.abs(actual - expected) <= tolerance;
}

function withinDays(isoString, expectedDate, toleranceDays) {
  const t = Date.parse(isoString);
  if (Number.isNaN(t)) return false;
  return Math.abs(t - expectedDate.getTime()) <= toleranceDays * DAY;
}

/**
 * The question set.
 *
 * Each case declares which tools must (and must not) be called, predicates over
 * the arguments, and — where the answer is objectively checkable — a ground
 * truth pulled from the raw upstream API at run time. Ground truth is never
 * hardcoded: seismic data changes hourly, so a fixed expected answer would rot
 * within a day and the eval would start reporting failures that aren't real.
 */
export const cases = [
  {
    id: 'largest-quake-week',
    question:
      'What was the largest earthquake anywhere in the world over the past 7 days? Give the magnitude and location.',
    expect: {
      required: ['search_earthquakes'],
      forbidden: ['search_volcanic_activity'],
      args: (input) => [
        check(
          'order_by targets magnitude',
          input.order_by === 'magnitude',
          `got order_by=${input.order_by ?? 'unset'} — sorting by time cannot answer "largest"`,
        ),
        check(
          'start_time ~7 days back',
          input.start_time !== undefined && withinDays(input.start_time, daysAgo(7), 2),
          `got start_time=${input.start_time ?? 'unset'}`,
        ),
      ],
    },
    // Ground truth: the same query, issued directly against USGS.
    groundTruth: async () => {
      const res = await searchEarthquakes({
        min_magnitude: 4.5,
        start_time: daysAgo(7).toISOString(),
        order_by: 'magnitude',
        limit: 1,
      });
      return res.events[0] ?? null;
    },
    answerCheck: (text, truth) =>
      truth
        ? {
            label: 'reports the correct magnitude',
            pass: text.includes(String(truth.magnitude)),
            detail: `expected magnitude ${truth.magnitude} (${truth.place})`,
          }
        : null,
  },

  {
    id: 'quakes-near-tokyo',
    question: 'Have there been any earthquakes near Tokyo in the last week?',
    expect: {
      required: ['search_earthquakes'],
      args: (input) => [
        check(
          'latitude near Tokyo',
          nearlyEqual(input.latitude, 35.68, 3),
          `got latitude=${input.latitude ?? 'unset'} (Tokyo is 35.68)`,
        ),
        check(
          'longitude near Tokyo',
          nearlyEqual(input.longitude, 139.69, 3),
          `got longitude=${input.longitude ?? 'unset'} (Tokyo is 139.69)`,
        ),
        check(
          'radius is city/region scale',
          typeof input.radius_km === 'number' && input.radius_km >= 50 && input.radius_km <= 2000,
          `got radius_km=${input.radius_km ?? 'unset'} — expected 50–2000 for "near Tokyo"`,
        ),
        check(
          'start_time ~7 days back',
          input.start_time !== undefined && withinDays(input.start_time, daysAgo(7), 2),
          `got start_time=${input.start_time ?? 'unset'}`,
        ),
      ],
    },
  },

  {
    id: 'volcano-iceland',
    question: 'Is any volcano in Iceland currently showing activity?',
    expect: {
      required: ['search_volcanic_activity'],
      forbidden: ['search_earthquakes'],
      args: (input) => [
        check(
          'filters on Iceland',
          typeof input.region === 'string' && input.region.toLowerCase().includes('iceland'),
          `got region=${input.region ?? 'unset'}`,
        ),
      ],
    },
    groundTruth: () => weeklyVolcanicActivity({ region: 'Iceland' }),
    // Only assert the direction of the answer — whether Iceland appears in this
    // week's report genuinely varies, so both "yes" and "no" can be correct.
    answerCheck: (text, truth) => ({
      label: truth.count > 0 ? 'confirms activity' : 'reports no activity',
      pass:
        truth.count > 0
          ? truth.volcanoes.some((v) => text.toLowerCase().includes(v.volcano.toLowerCase()))
          : /\bno\b|not|none|isn't|no current/i.test(text),
      detail:
        truth.count > 0
          ? `expected mention of ${truth.volcanoes.map((v) => v.volcano).join('/')}`
          : 'expected the answer to state there is no current Icelandic activity',
    }),
  },

  {
    id: 'multi-hazard-indonesia',
    question:
      'Give me a combined hazard picture for Indonesia right now: both seismic and volcanic activity.',
    expect: {
      // The question names two hazard types; answering it with one tool means
      // half the question went unanswered.
      required: ['search_earthquakes', 'search_volcanic_activity'],
      args: () => [],
    },
  },

  {
    id: 'historical-out-of-range',
    question: 'Which volcanoes erupted during 1980?',
    expect: {
      // Either the model knows the tool cannot reach 1980 and skips it, or it
      // checks and reports the limitation. Both are acceptable; inventing an
      // answer from the current weekly report is not.
      required: [],
      args: () => [],
    },
    answerCheck: (text) => ({
      label: 'discloses the coverage limit or answers from own knowledge without citing the feed',
      // St. Helens is the canonical 1980 eruption; the failure mode is claiming
      // the weekly report as the source for a 46-year-old event.
      pass:
        /past week|this week|weekly|current|only covers|cannot|can't|does not cover|no historical/i.test(
          text,
        ) || /helens/i.test(text),
      detail: 'answer should not present the current weekly report as covering 1980',
    }),
  },

  {
    id: 'no-tool-needed',
    question: 'In one sentence, what does the moment magnitude scale actually measure?',
    expect: {
      // Definitional question, no live data involved. Calling a tool here is an
      // over-triggering failure — the cost is latency and tokens on every
      // conversational aside.
      required: [],
      forbidden: [
        'search_earthquakes',
        'search_volcanic_activity',
        'get_earthquake',
        'get_weather',
        'get_lightning_risk',
        'search_weather_alerts',
        'get_air_quality',
        'get_marine_conditions',
        'search_natural_events',
        'search_disasters',
        'get_space_weather',
        'get_co2_record',
      ],
      args: () => [],
    },
  },

  {
    id: 'drill-into-event',
    question:
      'Find the strongest earthquake of the past 7 days, then look up its full detail record and tell me its significance score.',
    expect: {
      // Two-step chain: the second tool can only be called with an id produced
      // by the first, so this tests whether output flows into the next call.
      required: ['search_earthquakes', 'get_earthquake'],
      args: () => [],
    },
  },

  {
    id: 'weather-vienna',
    question: 'What is the weather like in Vienna right now, and will it rain there tomorrow?',
    expect: {
      required: ['get_weather'],
      forbidden: ['search_earthquakes', 'search_volcanic_activity'],
      args: (input) => [
        check(
          'targets Vienna',
          (typeof input.location === 'string' && /vienna|wien/i.test(input.location)) ||
            (nearlyEqual(input.latitude, 48.21, 1) && nearlyEqual(input.longitude, 16.37, 1)),
          `got location=${input.location ?? 'unset'}, lat/lon=${input.latitude ?? '-'}/${input.longitude ?? '-'}`,
        ),
        check(
          'forecast reaches tomorrow',
          input.forecast_days === undefined || input.forecast_days >= 2,
          `got forecast_days=${input.forecast_days} — 1 day cannot answer "tomorrow"`,
        ),
      ],
    },
  },

  {
    id: 'lightning-risk',
    question: 'Is there a risk of thunderstorms or lightning in Munich over the next two days?',
    expect: {
      required: ['get_lightning_risk'],
      forbidden: ['search_earthquakes', 'search_volcanic_activity'],
      args: (input) => [
        check(
          'targets Munich',
          (typeof input.location === 'string' && /munich|münchen|muenchen/i.test(input.location)) ||
            (nearlyEqual(input.latitude, 48.14, 1) && nearlyEqual(input.longitude, 11.58, 1)),
          `got location=${input.location ?? 'unset'}, lat/lon=${input.latitude ?? '-'}/${input.longitude ?? '-'}`,
        ),
        check(
          'window covers ~2 days',
          input.hours === undefined || (input.hours >= 36 && input.hours <= 72),
          `got hours=${input.hours} — expected 36–72 for "next two days"`,
        ),
      ],
    },
  },

  {
    id: 'alerts-texas',
    question: 'Are there any active weather warnings in Texas at the moment?',
    expect: {
      required: ['search_weather_alerts'],
      args: (input) => [
        check(
          'queries the US feed',
          /^(us|usa|united states( of america)?)$/i.test(input.country?.trim() ?? ''),
          `got country=${input.country ?? 'unset'}`,
        ),
        check(
          'narrows to Texas',
          /^(tx|texas)$/i.test(input.area?.trim() ?? '') ||
            (nearlyEqual(input.latitude, 31, 6) && nearlyEqual(input.longitude, -99, 8)),
          `got area=${input.area ?? 'unset'}`,
        ),
      ],
    },
  },

  {
    id: 'aurora-tromso',
    question: 'Could I see the northern lights from Tromsø in the next few days?',
    expect: {
      required: ['get_space_weather'],
      args: (input) => [
        check(
          'gives the observer location',
          nearlyEqual(input.latitude, 69.65, 1.5) && nearlyEqual(input.longitude, 18.96, 3),
          `got lat/lon=${input.latitude ?? '-'}/${input.longitude ?? '-'} (Tromsø is 69.65/18.96) — without it there is no local outlook`,
        ),
      ],
    },
  },

  {
    id: 'air-quality-delhi',
    question: 'How bad is the air pollution in Delhi today?',
    expect: {
      required: ['get_air_quality'],
      forbidden: ['get_weather'],
      args: (input) => [
        check(
          'targets Delhi',
          (typeof input.location === 'string' && /delhi/i.test(input.location)) ||
            (nearlyEqual(input.latitude, 28.65, 1) && nearlyEqual(input.longitude, 77.23, 1)),
          `got location=${input.location ?? 'unset'}`,
        ),
      ],
    },
  },

  {
    id: 'major-disasters',
    question: 'Which major disasters with a serious humanitarian impact are ongoing worldwide right now?',
    expect: {
      required: ['search_disasters'],
      args: (input) => [
        check(
          'does not widen to Green alerts',
          input.min_alert_level === undefined || input.min_alert_level !== 'Green',
          `got min_alert_level=${input.min_alert_level} — Green floods the answer with minor events`,
        ),
      ],
    },
  },

  {
    id: 'wildfires-now',
    question: 'What active wildfires is NASA tracking at the moment?',
    expect: {
      required: ['search_natural_events'],
      args: (input) => [
        check('filters on wildfires', input.category === 'wildfires', `got category=${input.category ?? 'unset'}`),
        check(
          'asks for ongoing events',
          input.status === undefined || input.status === 'open',
          `got status=${input.status} — closed fires are not "active"`,
        ),
      ],
    },
  },

  {
    id: 'marine-nazare',
    question: 'How big are the waves off Nazaré, Portugal right now?',
    expect: {
      required: ['get_marine_conditions'],
      forbidden: ['get_weather'],
      args: (input) => [
        // A coastal town name geocodes onto land, where there is no sea state,
        // so the question is only answerable with a point out at sea.
        check(
          'uses coordinates off Nazaré',
          nearlyEqual(input.latitude, 39.6, 0.5) && input.longitude >= -10.5 && input.longitude < -9.08,
          `got location=${input.location ?? 'unset'}, lat/lon=${input.latitude ?? '-'}/${input.longitude ?? '-'} — expected an offshore point west of Nazaré (39.6/-9.07)`,
        ),
      ],
    },
  },

  {
    id: 'co2-now',
    question: 'How high is the CO2 concentration in the atmosphere right now, and how fast is it rising?',
    expect: {
      required: ['get_co2_record'],
      args: () => [],
    },
    groundTruth: () => co2MaunaLoa(),
    // Accept any rounding of the latest monthly mean, e.g. 427.55 as "427.6" or "428".
    answerCheck: (text, truth) => ({
      label: 'reports the latest monthly ppm',
      pass: (text.match(/\d{3}(?:\.\d+)?/g) ?? []).some((n) => Math.abs(Number(n) - truth.latest.ppm) <= 0.5),
      detail: `expected ~${truth.latest.ppm} ppm (${truth.latest.year}-${truth.latest.month})`,
    }),
  },
];
