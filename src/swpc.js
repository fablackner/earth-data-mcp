import { fetchJson, UpstreamError } from './http.js';

const BASE = 'https://services.swpc.noaa.gov';
const SCALES = `${BASE}/products/noaa-scales.json`;
const KP = `${BASE}/products/noaa-planetary-k-index-forecast.json`;
const FLARES = `${BASE}/json/goes/primary/xray-flares-7-day.json`;

/**
 * Rough equatorward edge of aurora visibility (geomagnetic latitude) by Kp.
 * The standard rule of thumb from NOAA's Kp maps — good enough to answer "could
 * I see it from here", not a replacement for the OVATION model.
 */
const AURORA_LATITUDE = [66, 64, 62, 60, 58, 56, 54, 52, 50, 48];

/** Geomagnetic north pole (IGRF-14 dipole, epoch 2025). */
const POLE_LAT = 80.8;
const POLE_LON = -72.6;

/**
 * Dipole geomagnetic latitude of a geographic point. Aurora visibility follows
 * geomagnetic latitude: Denver (39.7°N) sits near 47° magnetic, Rome (41.9°N)
 * near 42°, so the same Kp means different things for each. A centred dipole
 * can be off by a few degrees against AACGM coordinates — fine for an outlook.
 */
function geomagneticLatitude(latitude, longitude) {
  const rad = Math.PI / 180;
  const sin =
    Math.sin(latitude * rad) * Math.sin(POLE_LAT * rad) +
    Math.cos(latitude * rad) * Math.cos(POLE_LAT * rad) * Math.cos((longitude - POLE_LON) * rad);
  return Math.asin(sin) / rad;
}

const scale = (s) => (s?.Scale == null ? null : { level: Number(s.Scale), text: s.Text });

/** NOAA reports a flare class like "M1.3"; X > M > C > B > A. */
const flareRank = (cls) => ('ABCMX'.indexOf(cls?.[0]) * 100 + Number(cls?.slice(1) ?? 0));

/**
 * Space weather from NOAA's Space Weather Prediction Center: the R/S/G storm
 * scales (radio blackouts, solar radiation storms, geomagnetic storms) now and
 * for the next three days, the planetary Kp index, and recent solar flares.
 */
export async function spaceWeather({ latitude, longitude } = {}) {
  if ((latitude === undefined) !== (longitude === undefined)) {
    throw new UpstreamError('latitude and longitude must be supplied together');
  }

  const [scales, kp, flares] = await Promise.all([
    fetchJson(SCALES, { ttlMs: 300_000 }),
    fetchJson(KP, { ttlMs: 300_000 }),
    fetchJson(FLARES, { ttlMs: 300_000 }),
  ]);

  // Key "0" is now, "-1" the past 24 h, "1".."3" the forecast days.
  const forecast = ['1', '2', '3']
    .map((k) => scales[k])
    .filter(Boolean)
    .map((d) => ({
      date: d.DateStamp,
      geomagnetic_storm: scale(d.G),
      radio_blackout_probability_pct: { minor: Number(d.R?.MinorProb ?? 0), major: Number(d.R?.MajorProb ?? 0) },
      radiation_storm_probability_pct: Number(d.S?.Prob ?? 0),
    }));

  const observed = kp.filter((k) => k.observed !== 'predicted');
  const predicted = kp.filter((k) => k.observed === 'predicted');
  const latestKp = observed.at(-1);
  const peakPredicted = predicted.reduce((max, k) => (k.kp > (max?.kp ?? -1) ? k : max), null);

  // B and C flares happen daily and say nothing; M and X are the ones that
  // cause radio blackouts on the sunlit side of the Earth.
  const significant = flares
    .filter((f) => /^[MX]/.test(f.max_class ?? ''))
    .map((f) => ({ class: f.max_class, peak: f.max_time, begin: f.begin_time, end: f.end_time }));
  const strongest = flares.reduce(
    (best, f) => (flareRank(f.max_class) > flareRank(best?.max_class) ? f : best),
    null,
  );

  let aurora = null;
  if (latitude !== undefined && peakPredicted) {
    const magLat = Math.abs(geomagneticLatitude(latitude, longitude));
    const boundary = AURORA_LATITUDE[Math.min(9, Math.round(peakPredicted.kp))];
    aurora = {
      observer_geomagnetic_latitude_deg: Number(magLat.toFixed(1)),
      visibility_boundary_deg: boundary,
      // Visible overhead poleward of the boundary; a few degrees equatorward it
      // can still show low on the poleward horizon.
      outlook:
        magLat >= boundary ? 'likely visible (dark, clear skies)' : magLat >= boundary - 4 ? 'possible, low on the horizon' : 'unlikely',
    };
  }

  return {
    source: 'NOAA Space Weather Prediction Center',
    now: {
      time: `${scales['0']?.DateStamp}T${scales['0']?.TimeStamp}Z`,
      radio_blackout: scale(scales['0']?.R),
      solar_radiation_storm: scale(scales['0']?.S),
      geomagnetic_storm: scale(scales['0']?.G),
    },
    past_24h_max: {
      radio_blackout: scale(scales['-1']?.R),
      solar_radiation_storm: scale(scales['-1']?.S),
      geomagnetic_storm: scale(scales['-1']?.G),
    },
    forecast,
    kp: {
      latest: latestKp ? { time: `${latestKp.time_tag}Z`, kp: latestKp.kp, kind: latestKp.observed } : null,
      peak_predicted: peakPredicted
        ? { time: `${peakPredicted.time_tag}Z`, kp: peakPredicted.kp, noaa_scale: peakPredicted.noaa_scale }
        : null,
      aurora_visible_to_geomagnetic_latitude_deg: peakPredicted
        ? AURORA_LATITUDE[Math.min(9, Math.round(peakPredicted.kp))]
        : null,
      note: 'Aurora latitude is geomagnetic, not geographic, and a rule of thumb for the predicted peak.',
    },
    aurora_for_observer: aurora,
    flares_7d: {
      strongest: strongest ? { class: strongest.max_class, peak: strongest.max_time } : null,
      m_and_x_class: significant,
    },
  };
}
