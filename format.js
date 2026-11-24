// format.js -- Slovak (sk-SK) number formatting shared by the page modules

const formatterCache = new Map();

/**
 * Format a number with a fixed number of decimals in Slovak notation (decimal comma, space grouping).
 * Inputs:  value (number, scalar), fractionDigits (integer >= 0, default 0)
 * Output:  string ('—' for non-finite values)
 * Example: formatNumber(1234.56, 1)  // -> '1 234,6'
 */
export function formatNumber(value, fractionDigits = 0) {
  if (!Number.isFinite(value)) return '—';
  let formatter = formatterCache.get(fractionDigits);
  if (!formatter) {
    formatter = new Intl.NumberFormat('sk-SK', {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits
    });
    formatterCache.set(fractionDigits, formatter);
  }
  const text = formatter.format(value);
  return text === '-0' || /^-0[,.]?0*$/.test(text) ? text.slice(1) : text;
}

/**
 * Format a population given in thousands as "X tis." or "X,XX mil.".
 * Inputs:  thousands (number, scalar)
 * Output:  string
 * Example: formatPopulation(5424.7)  // -> '5,42 mil.'
 */
export function formatPopulation(thousands) {
  if (!Number.isFinite(thousands)) return '—';
  return Math.abs(thousands) >= 1000
    ? formatNumber(thousands / 1000, 2) + ' mil.'
    : formatNumber(thousands, 0) + ' tis.';
}

/**
 * Format a count given in thousands for tooltips: persons below one thousand, thousands otherwise.
 * Inputs:  thousands (number, scalar)
 * Output:  string
 * Example: formatThousandsDetail(0.412)  // -> '412 osôb'
 */
export function formatThousandsDetail(thousands) {
  if (!Number.isFinite(thousands)) return '—';
  return Math.abs(thousands) < 1
    ? formatNumber(thousands * 1000, 0) + ' osôb'
    : formatNumber(thousands, 1) + ' tis.';
}

/**
 * Format a number with an explicit sign (typographic minus).
 * Inputs:  value (number, scalar), fractionDigits (integer, default 0)
 * Output:  string
 * Example: formatSigned(-2.5, 1)  // -> '−2,5'
 */
export function formatSigned(value, fractionDigits = 0) {
  if (!Number.isFinite(value)) return '—';
  const magnitude = formatNumber(Math.abs(value), fractionDigits);
  if (Number(Math.abs(value).toFixed(fractionDigits)) === 0) return magnitude;
  return (value > 0 ? '+' : '−') + magnitude;
}

/**
 * Format a percentage with Slovak spacing ("5,3 %").
 * Inputs:  value (number, percent), fractionDigits (integer, default 1)
 * Output:  string
 * Example: formatPercent(5.3)  // -> '5,3 %'
 */
export function formatPercent(value, fractionDigits = 1) {
  return Number.isFinite(value) ? formatNumber(value, fractionDigits) + ' %' : '—';
}
