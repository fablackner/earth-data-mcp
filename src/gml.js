import { fetchText, UpstreamError } from './http.js';

const MAUNA_LOA_MONTHLY = 'https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_mlo.csv';

/**
 * Monthly mean atmospheric CO2 at Mauna Loa (the Keeling curve), from NOAA's
 * Global Monitoring Laboratory. Returns the last two years of months plus the
 * year-over-year change, which is the number people actually ask about —
 * the raw series has a strong seasonal cycle that makes month-to-month
 * differences misleading.
 */
export async function co2MaunaLoa() {
  const csv = await fetchText(MAUNA_LOA_MONTHLY, { ttlMs: 86_400_000 });
  // Columns: year, month, decimal date, average, deseasonalized, ndays, sdev, unc.
  const months = csv
    .split('\n')
    .filter((line) => /^\d{4},/.test(line))
    .map((line) => {
      const [year, month, , average, deseasonalized] = line.split(',');
      return { year: Number(year), month: Number(month), ppm: Number(average), deseasonalized_ppm: Number(deseasonalized) };
    });
  if (months.length < 13) throw new UpstreamError(`${MAUNA_LOA_MONTHLY} returned an unexpected format`);

  const latest = months.at(-1);
  const yearAgo = months.find((m) => m.year === latest.year - 1 && m.month === latest.month);
  const first = months[0];

  return {
    source: 'NOAA Global Monitoring Laboratory, Mauna Loa Observatory',
    unit: 'ppm (mole fraction in dry air)',
    latest,
    change_vs_same_month_last_year_ppm: yearAgo ? Number((latest.ppm - yearAgo.ppm).toFixed(2)) : null,
    record_start: first,
    change_since_record_start_ppm: Number((latest.ppm - first.ppm).toFixed(2)),
    last_24_months: months.slice(-24),
  };
}
