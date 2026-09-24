import { fetchJson, UpstreamError } from './http.js';

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING = 'https://geocoding-api.open-meteo.com/v1/search';

/** WMO weather interpretation codes, as used by Open-Meteo's `weather_code`. */
const WMO_CODES = {
  0: 'clear sky',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'depositing rime fog',
  51: 'light drizzle',
  53: 'moderate drizzle',
  55: 'dense drizzle',
  56: 'light freezing drizzle',
  57: 'dense freezing drizzle',
  61: 'slight rain',
  63: 'moderate rain',
  65: 'heavy rain',
  66: 'light freezing rain',
  67: 'heavy freezing rain',
  71: 'slight snowfall',
  73: 'moderate snowfall',
  75: 'heavy snowfall',
  77: 'snow grains',
  80: 'slight rain showers',
  81: 'moderate rain showers',
  82: 'violent rain showers',
  85: 'slight snow showers',
  86: 'heavy snow showers',
  95: 'thunderstorm',
  96: 'thunderstorm with slight hail',
  99: 'thunderstorm with heavy hail',
};

const THUNDERSTORM_CODES = new Set([95, 96, 99]);

const describe = (code) => WMO_CODES[code] ?? (code == null ? null : `unknown code ${code}`);

/**
 * Resolve a place name or a coordinate pair to one point.
 *
 * Exactly one form must be supplied. Guessing a location from nothing — or
 * quietly preferring one form when both disagree — would answer a question
 * about somewhere the caller didn't ask about.
 */
export async function resolveLocation({ location, latitude, longitude }) {
  const hasCoords = latitude !== undefined || longitude !== undefined;
  if (location && hasCoords) {
    throw new UpstreamError('supply either location or latitude/longitude, not both');
  }
  if (hasCoords) {
    if (latitude === undefined || longitude === undefined) {
      throw new UpstreamError('latitude and longitude must be supplied together');
    }
    return { name: null, latitude, longitude };
  }
  if (!location) {
    throw new UpstreamError('supply a location name or latitude/longitude');
  }

  const params = new URLSearchParams({ name: location, count: '1', format: 'json' });
  const result = await fetchJson(`${GEOCODING}?${params}`, { ttlMs: 86_400_000 });
  const hit = result.results?.[0];
  if (!hit) throw new UpstreamError(`no place found matching "${location}"`);
  return {
    name: [hit.name, hit.admin1, hit.country].filter(Boolean).join(', '),
    latitude: hit.latitude,
    longitude: hit.longitude,
  };
}

/** Zip Open-Meteo's column-oriented arrays into one record per timestamp. */
function rows(block, rename = {}) {
  if (!block?.time) return [];
  return block.time.map((time, i) => {
    const row = { time };
    for (const [key, values] of Object.entries(block)) {
      if (key !== 'time') row[rename[key] ?? key] = values[i];
    }
    return row;
  });
}

/**
 * Current conditions plus a daily forecast (and optionally recent past days)
 * for one point.
 */
export async function getWeather({ location, latitude, longitude, forecast_days = 3, past_days = 0 }) {
  const place = await resolveLocation({ location, latitude, longitude });

  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    timezone: 'auto',
    forecast_days: String(forecast_days),
    past_days: String(past_days),
    current: [
      'temperature_2m',
      'apparent_temperature',
      'relative_humidity_2m',
      'precipitation',
      'weather_code',
      'cloud_cover',
      'pressure_msl',
      'wind_speed_10m',
      'wind_direction_10m',
      'wind_gusts_10m',
    ].join(','),
    daily: [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_sum',
      'precipitation_probability_max',
      'wind_speed_10m_max',
      'wind_gusts_10m_max',
      'uv_index_max',
      'sunrise',
      'sunset',
    ].join(','),
  });

  const data = await fetchJson(`${FORECAST}?${params}`, { ttlMs: 600_000 });
  const current = data.current ?? {};
  return {
    query: Object.fromEntries(params),
    location: { name: place.name, latitude: data.latitude, longitude: data.longitude, elevation_m: data.elevation },
    timezone: data.timezone,
    // Units travel with the numbers; km/h vs m/s is exactly the kind of thing
    // an agent will otherwise guess.
    units: { ...data.current_units, ...data.daily_units },
    current: { ...current, conditions: describe(current.weather_code) },
    daily: rows(data.daily).map((day) => ({ ...day, conditions: describe(day.weather_code) })),
  };
}

/** Rough convective-instability bands for CAPE (J/kg); a rule of thumb, not a forecast. */
function capeBand(cape) {
  if (cape == null) return null;
  if (cape < 300) return 'weak';
  if (cape < 1000) return 'marginal';
  if (cape < 2500) return 'moderate';
  return 'strong';
}

/**
 * Thunderstorm and lightning risk for one point, hour by hour.
 *
 * This is a model forecast, not observed strikes. Three signals are combined:
 * the model's own thunderstorm weather codes (global), CAPE as a measure of
 * how much energy is available for convection (global), and the lightning
 * potential index (DWD ICON models, so Europe only — null elsewhere, and the
 * response says so rather than letting nulls read as "no lightning").
 */
export async function getLightningRisk({ location, latitude, longitude, hours = 48 }) {
  const place = await resolveLocation({ location, latitude, longitude });

  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    timezone: 'auto',
    forecast_hours: String(hours),
    hourly: ['weather_code', 'cape', 'lightning_potential', 'precipitation_probability'].join(','),
  });

  const data = await fetchJson(`${FORECAST}?${params}`, { ttlMs: 600_000 });
  const all = rows(data.hourly, { lightning_potential: 'lightning_potential_index' });
  const lpiAvailable = all.some((h) => h.lightning_potential_index != null);

  const hourly = all.map((h) => ({
    ...h,
    conditions: describe(h.weather_code),
    thunderstorm_forecast: THUNDERSTORM_CODES.has(h.weather_code),
    cape_band: capeBand(h.cape),
  }));

  // Only hours carrying some signal are listed; 48 rows of zeros is context
  // spent on nothing. The summary still covers the whole window.
  const flagged = hourly.filter(
    (h) => h.thunderstorm_forecast || h.cape >= 300 || h.lightning_potential_index > 0,
  );
  const storms = hourly.filter((h) => h.thunderstorm_forecast);
  const peak = hourly.reduce((best, h) => (h.cape > (best?.cape ?? -1) ? h : best), null);

  return {
    query: Object.fromEntries(params),
    location: { name: place.name, latitude: data.latitude, longitude: data.longitude },
    timezone: data.timezone,
    units: data.hourly_units,
    note:
      'Forecast risk, not observed lightning strikes. lightning_potential_index is only ' +
      'available over Europe (DWD ICON models).',
    summary: {
      window_hours: hourly.length,
      thunderstorm_hours: storms.length,
      first_thunderstorm: storms[0]?.time ?? null,
      peak_cape: peak ? { time: peak.time, cape: peak.cape, band: peak.cape_band } : null,
      max_lightning_potential_index: lpiAvailable
        ? Math.max(...all.map((h) => h.lightning_potential_index ?? 0))
        : null,
      lightning_potential_available: lpiAvailable,
    },
    flagged_hours: flagged,
  };
}

const AIR_QUALITY = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const MARINE = 'https://marine-api.open-meteo.com/v1/marine';

/** Named bands for the European (EEA) and US (EPA) air-quality indices. */
function euAqiBand(v) {
  if (v == null) return null;
  return v <= 20 ? 'good' : v <= 40 ? 'fair' : v <= 60 ? 'moderate' : v <= 80 ? 'poor' : v <= 100 ? 'very poor' : 'extremely poor';
}
function usAqiBand(v) {
  if (v == null) return null;
  return v <= 50
    ? 'good'
    : v <= 100
      ? 'moderate'
      : v <= 150
        ? 'unhealthy for sensitive groups'
        : v <= 200
          ? 'unhealthy'
          : v <= 300
            ? 'very unhealthy'
            : 'hazardous';
}

const POLLEN = ['alder_pollen', 'birch_pollen', 'grass_pollen', 'mugwort_pollen', 'olive_pollen', 'ragweed_pollen'];

/**
 * Air quality for one point (CAMS model data via Open-Meteo): the European and
 * US indices with their named bands, the pollutants behind them, and — over
 * Europe only — pollen. A daily peak of each index over the forecast window
 * answers "will it be bad tomorrow" without shipping every hour.
 */
export async function getAirQuality({ location, latitude, longitude, forecast_days = 2 }) {
  const place = await resolveLocation({ location, latitude, longitude });

  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    timezone: 'auto',
    forecast_days: String(forecast_days),
    current: [
      'european_aqi',
      'us_aqi',
      'pm2_5',
      'pm10',
      'ozone',
      'nitrogen_dioxide',
      'sulphur_dioxide',
      'carbon_monoxide',
      'dust',
      'aerosol_optical_depth',
      'uv_index',
      ...POLLEN,
    ].join(','),
    hourly: 'european_aqi,us_aqi',
  });

  const data = await fetchJson(`${AIR_QUALITY}?${params}`, { ttlMs: 1_800_000 });
  const current = data.current ?? {};

  const daily = {};
  for (const h of rows(data.hourly)) {
    const day = (daily[h.time.slice(0, 10)] ??= { date: h.time.slice(0, 10), european_aqi_max: null, us_aqi_max: null });
    if (h.european_aqi != null) day.european_aqi_max = Math.max(day.european_aqi_max ?? 0, h.european_aqi);
    if (h.us_aqi != null) day.us_aqi_max = Math.max(day.us_aqi_max ?? 0, h.us_aqi);
  }

  const pollen = Object.fromEntries(POLLEN.map((k) => [k, current[k]]));
  const pollenAvailable = Object.values(pollen).some((v) => v != null);

  return {
    query: Object.fromEntries(params),
    location: { name: place.name, latitude: data.latitude, longitude: data.longitude },
    timezone: data.timezone,
    units: data.current_units,
    current: {
      time: current.time,
      european_aqi: current.european_aqi,
      european_aqi_band: euAqiBand(current.european_aqi),
      us_aqi: current.us_aqi,
      us_aqi_band: usAqiBand(current.us_aqi),
      pm2_5: current.pm2_5,
      pm10: current.pm10,
      ozone: current.ozone,
      nitrogen_dioxide: current.nitrogen_dioxide,
      sulphur_dioxide: current.sulphur_dioxide,
      carbon_monoxide: current.carbon_monoxide,
      dust: current.dust,
      aerosol_optical_depth: current.aerosol_optical_depth,
      uv_index: current.uv_index,
    },
    // Null outside Europe; flagged so it can't be read as "no pollen".
    pollen: pollenAvailable ? pollen : null,
    pollen_available: pollenAvailable,
    daily_peak: Object.values(daily).map((d) => ({
      ...d,
      european_aqi_band: euAqiBand(d.european_aqi_max),
      us_aqi_band: usAqiBand(d.us_aqi_max),
    })),
  };
}

/**
 * Sea state for one point on the ocean: waves, swell, sea-surface temperature
 * and surface currents now, plus a daily wave/swell maximum. A point on land
 * has no marine data; that is reported as an error rather than as a calm sea.
 */
export async function getMarineConditions({ location, latitude, longitude, forecast_days = 3 }) {
  const place = await resolveLocation({ location, latitude, longitude });

  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    timezone: 'auto',
    forecast_days: String(forecast_days),
    current: [
      'wave_height',
      'wave_direction',
      'wave_period',
      'wind_wave_height',
      'swell_wave_height',
      'swell_wave_direction',
      'swell_wave_period',
      'sea_surface_temperature',
      'ocean_current_velocity',
      'ocean_current_direction',
      'sea_level_height_msl',
    ].join(','),
    daily: 'wave_height_max,wave_period_max,swell_wave_height_max,wind_wave_height_max',
  });

  const data = await fetchJson(`${MARINE}?${params}`, { ttlMs: 1_800_000 });
  const current = data.current ?? {};
  if (current.wave_height == null && current.sea_surface_temperature == null) {
    throw new UpstreamError(
      `no marine data at ${data.latitude}, ${data.longitude} — the point is probably on land. ` +
        'Use coordinates offshore; a coastal city name geocodes to its centre, which is often inland.',
    );
  }

  return {
    query: Object.fromEntries(params),
    location: { name: place.name, latitude: data.latitude, longitude: data.longitude },
    timezone: data.timezone,
    units: { ...data.current_units, ...data.daily_units },
    current,
    daily: rows(data.daily),
  };
}
