// plot.js -- Charts drawn with Observable Plot 0.6 (global `Plot`, loaded from vendor/plot)
//
// renderPyramid:    stacked population pyramid by labour state, 5-year age groups, optional benchmark ticks
// renderTimeSeries: line chart of one metric over the projection horizon with a marker at the current year
// composeExportSvg: standalone SVG (title, chart, legend, source) for PNG/SVG export

import { STATE_META } from './config.js';
import { formatNumber, formatThousandsDetail } from './format.js';

const AGE_BIN_WIDTH = 5;
const OPEN_AGE = 100;
const STATE_COUNT = STATE_META.length;
const BIN_COUNT = Math.floor(OPEN_AGE / AGE_BIN_WIDTH) + 1;   // 0-4, ..., 95-99, 100+
const TEXT_COLOR = '#3A4458';
const AXIS_COLOR = '#8A93A6';
const NAVY = '#203564';
const FONT_FAMILY = 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const CHART_STYLE = { background: 'transparent', color: TEXT_COLOR, fontFamily: FONT_FAMILY, fontSize: '12px' };
const SEX_LABELS = ['muži', 'ženy'];

/**
 * Label of a 5-year age group.
 * Inputs:  binStart (integer, first age of the group)
 * Output:  string
 * Example: binLabel(65)  // -> '65–69'
 */
function binLabel(binStart) {
  return binStart >= OPEN_AGE ? '100+' : `${binStart}–${binStart + AGE_BIN_WIDTH - 1}`;
}

const AGE_LABELS_TOP_DOWN = Array.from({ length: BIN_COUNT }, (_, index) => binLabel((BIN_COUNT - 1 - index) * AGE_BIN_WIDTH));

/**
 * Sum of one sex over the ages of an age group.
 * Inputs:  values (number[101] | Float64Array), binStart (integer)
 * Output:  number
 * Example: binSum(population.male, 20)
 */
function binSum(values, binStart) {
  let total = 0;
  for (let age = binStart; age < Math.min(binStart + AGE_BIN_WIDTH, OPEN_AGE + 1); age++) total += values[age] || 0;
  return total;
}

/**
 * Largest 5-year group (either sex) over several snapshots; used to keep the pyramid axis fixed in time.
 * Inputs:  snapshots (object[] of { male, female } number[101])
 * Output:  number (thousands)
 * Example: maxBinTotal(Object.values(result.snapshots))
 */
export function maxBinTotal(snapshots) {
  let maximum = 0;
  for (const snapshot of snapshots) {
    if (!snapshot) continue;
    for (let bin = 0; bin < BIN_COUNT; bin++) {
      maximum = Math.max(maximum, binSum(snapshot.male, bin * AGE_BIN_WIDTH), binSum(snapshot.female, bin * AGE_BIN_WIDTH));
    }
  }
  return maximum;
}

/**
 * Rows for the stacked pyramid: one row per age group x sex x visible labour state.
 * Inputs:  snapshot ({ male, female } number[101]), states (Float64Array(101*2*8)), hiddenStates (Set<string>)
 * Output:  object[] ({ ageGroup, population (negative for men), state, stateOrder, tip })
 * Example: buildPyramidRows(snapshot, states, new Set(['INACTIVE']))
 */
function buildPyramidRows(snapshot, states, hiddenStates) {
  const rows = [];
  for (let bin = 0; bin < BIN_COUNT; bin++) {
    const binStart = bin * AGE_BIN_WIDTH;
    const label = binLabel(binStart);
    for (let sex = 0; sex < 2; sex++) {
      const sexTotal = binSum(sex === 0 ? snapshot.male : snapshot.female, binStart);
      for (let stateIndex = 0; stateIndex < STATE_COUNT; stateIndex++) {
        const meta = STATE_META[stateIndex];
        if (hiddenStates.has(meta.key)) continue;
        let value = 0;
        for (let age = binStart; age < Math.min(binStart + AGE_BIN_WIDTH, OPEN_AGE + 1); age++) {
          value += states[(age * 2 + sex) * STATE_COUNT + stateIndex];
        }
        if (value <= 0) continue;
        const share = sexTotal > 0 ? 100 * value / sexTotal : 0;
        rows.push({
          ageGroup: label,
          population: sex === 0 ? -value : value,
          state: meta.key,
          stateOrder: stateIndex,
          tip: `${label} r., ${SEX_LABELS[sex]}\n${meta.label}: ${formatThousandsDetail(value)}\n${formatNumber(share, 1)} % vekovej skupiny`
        });
      }
    }
  }
  return rows;
}

/**
 * Draw the population pyramid into a container (replaces its content).
 * Inputs:  container (HTMLElement), options ({ snapshot, states, hiddenStates: Set, benchmarkSnapshot|null,
 *          xMax (number, thousands; fixed axis), width, height (pixels), year (number) })
 * Output:  SVGElement (the chart)
 * Example: renderPyramid(element, { snapshot, states, hiddenStates, benchmarkSnapshot: null, xMax: 450, width: 800, height: 520, year: 2050 })
 */
export function renderPyramid(container, options) {
  const { snapshot, states, hiddenStates, benchmarkSnapshot, xMax, width, height, year } = options;
  const narrow = width < 520;
  const rows = buildPyramidRows(snapshot, states, hiddenStates);
  const marks = [
    Plot.gridX({ stroke: '#E3E8EF', strokeOpacity: 1 }),
    Plot.barX(rows, Plot.stackX({
      y: 'ageGroup', x: 'population', fill: 'state', order: 'stateOrder',
      stroke: '#FFFFFF', strokeWidth: 0.5,
      title: 'tip', tip: { fill: '#FFFFFF', stroke: '#D9DFE8', fontSize: 12 }
    })),
    Plot.ruleX([0], { stroke: AXIS_COLOR, strokeWidth: 1 }),
    Plot.text(['Muži'], { frameAnchor: 'top-left', dx: 6, dy: -14, fill: NAVY, fontWeight: 700, fontSize: 12 }),
    Plot.text(['Ženy'], { frameAnchor: 'top-right', dx: -6, dy: -14, fill: NAVY, fontWeight: 700, fontSize: 12 })
  ];
  if (benchmarkSnapshot) {
    const benchmarkRows = [];
    for (let bin = 0; bin < BIN_COUNT; bin++) {
      const binStart = bin * AGE_BIN_WIDTH;
      benchmarkRows.push({ ageGroup: binLabel(binStart), population: -binSum(benchmarkSnapshot.male, binStart) });
      benchmarkRows.push({ ageGroup: binLabel(binStart), population: binSum(benchmarkSnapshot.female, binStart) });
    }
    marks.push(Plot.tickX(benchmarkRows, { x: 'population', y: 'ageGroup', stroke: '#1C2541', strokeWidth: 2, strokeDasharray: '3,2' }));
  }
  const axisLimit = Math.max(1, xMax) * 1.04;
  const chart = Plot.plot({
    width, height,
    marginLeft: narrow ? 46 : 56, marginRight: 14, marginTop: 24, marginBottom: 38,
    style: CHART_STYLE,
    x: {
      domain: [-axisLimit, axisLimit], label: 'tis. osôb', labelAnchor: 'center', labelArrow: 'none',
      tickFormat: value => formatNumber(Math.abs(value), 0), ticks: narrow ? 4 : 8
    },
    y: { domain: AGE_LABELS_TOP_DOWN, label: null, tickSize: 0, padding: 0.12 },
    color: { domain: STATE_META.map(meta => meta.key), range: STATE_META.map(meta => meta.color) },
    marks
  });
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', `Populačná pyramída Slovenska v roku ${year} podľa vekových skupín, pohlavia a stavu na trhu práce`);
  container.replaceChildren(chart);
  return chart;
}

/**
 * Draw a time-series chart of one metric (replaces the container content). When the colour legend wraps to
 * several lines, the plot is drawn again with a smaller height so that the whole figure fits the container.
 * Inputs:  container (HTMLElement), options ({ metric (SERIES_METRICS item), years (number[]), series (object of
 *          number[]), benchmarkSeries ({ years, [key]: number[] } | null), currentYear, referenceValue
 *          (number | null, horizontal reference line), width, height (pixels) })
 * Output:  HTMLElement | SVGElement (the chart)
 * Example: renderTimeSeries(element, { metric, years, series, benchmarkSeries: null, currentYear: 2050, referenceValue: null, width: 800, height: 180 })
 */
export function renderTimeSeries(container, options) {
  const { metric, years, series, benchmarkSeries, currentYear, referenceValue, width, height } = options;
  const rows = [];
  for (const line of metric.lines) {
    const factor = line.factor ?? 1;
    years.forEach((year, index) => rows.push({ year, value: series[line.key][index] * factor, line: line.label }));
  }
  const colorDomain = metric.lines.map(line => line.label);
  const colorRange = metric.lines.map(line => line.color);
  const benchmarkRows = [];
  if (benchmarkSeries && metric.benchmarkKey) {
    const factor = metric.benchmarkFactor ?? 1;
    const label = metric.benchmarkLabel || 'EUROPOP2023';
    benchmarkSeries.years.forEach((year, index) => benchmarkRows.push({ year, value: benchmarkSeries[metric.benchmarkKey][index] * factor, line: label }));
    colorDomain.push(label);
    colorRange.push('#1C2541');
  }
  const currentRows = rows.filter(row => row.year === currentYear);
  const valueText = row => `${row.year} · ${row.line}: ${formatNumber(row.value, metric.digits)}`;
  const marks = [
    Plot.ruleX([currentYear], { stroke: NAVY, strokeOpacity: 0.35, strokeWidth: 1.5 }),
    Plot.line(rows, { x: 'year', y: 'value', stroke: 'line', strokeWidth: 2.2 }),
    Plot.dot(currentRows, { x: 'year', y: 'value', fill: 'line', r: 4, stroke: '#FFFFFF', strokeWidth: 1.5 }),
    Plot.tip(rows.concat(benchmarkRows), Plot.pointerX({ x: 'year', y: 'value', title: valueText, fill: '#FFFFFF', stroke: '#D9DFE8' }))
  ];
  if (benchmarkRows.length) {
    marks.splice(1, 0, Plot.line(benchmarkRows, { x: 'year', y: 'value', stroke: 'line', strokeWidth: 1.6, strokeDasharray: '5,3' }));
  }
  if (Number.isFinite(referenceValue)) {
    marks.unshift(Plot.ruleY([referenceValue], { stroke: '#3657A7', strokeOpacity: 0.6, strokeDasharray: '2,3' }));
  }
  if (metric.zero) marks.unshift(Plot.ruleY([0], { stroke: AXIS_COLOR }));
  const showLegend = colorDomain.length > 1;
  const draw = plotHeight => Plot.plot({
    width,
    height: Math.max(80, plotHeight),
    marginLeft: 48, marginRight: 16, marginTop: 14, marginBottom: 28,
    style: CHART_STYLE,
    x: { label: null, tickFormat: value => String(value), ticks: width < 520 ? 4 : 8 },
    y: {
      label: null, grid: true, zero: Boolean(metric.zero), domain: metric.yDomain,
      tickFormat: value => formatNumber(value, metric.digits >= 2 ? 1 : 0), ticks: 4
    },
    color: { domain: colorDomain, range: colorRange, legend: showLegend },
    marks
  });
  let chart = draw(showLegend ? height - 30 : height);
  container.replaceChildren(chart);
  if (showLegend) {
    const overflow = chart.getBoundingClientRect().height - height;
    if (overflow > 1) {
      chart = draw(height - 30 - overflow);
      container.replaceChildren(chart);
    }
  }
  chart.setAttribute('aria-label', `Časový vývoj: ${metric.label}`);
  return chart;
}

/**
 * Escape text for inclusion in SVG/XML.
 * Inputs:  text (string)
 * Output:  string
 * Example: escapeXml('a < b')  // -> 'a &lt; b'
 */
function escapeXml(text) {
  return String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
}

/**
 * Standalone SVG document with a title, the chart, a legend and a source line (for PNG/SVG export).
 * Inputs:  chartSvg (SVGElement rendered by Plot), options ({ title, subtitle, source (strings),
 *          legendItems ({ label, color }[]) })
 * Output:  { markup: string (SVG document), width: number, height: number } (pixels)
 * Example: composeExportSvg(svgElement, { title: 'Populačná pyramída 2050', subtitle: 'Scenár: Základný', source: 'Zdroj: RRZ', legendItems })
 */
export function composeExportSvg(chartSvg, options) {
  const { title, subtitle, source, legendItems } = options;
  const chartWidth = Number(chartSvg.getAttribute('width')) || chartSvg.getBoundingClientRect().width;
  const chartHeight = Number(chartSvg.getAttribute('height')) || chartSvg.getBoundingClientRect().height;
  const width = Math.max(chartWidth, 560);
  const clone = chartSvg.cloneNode(true);
  clone.querySelectorAll('[aria-label="tip"]').forEach(element => element.remove());
  clone.setAttribute('x', String((width - chartWidth) / 2));
  clone.setAttribute('y', '64');
  clone.removeAttribute('role');

  const legendTop = 64 + chartHeight + 14;
  let cursorX = 16;
  let cursorY = legendTop;
  const legendMarkup = [];
  for (const item of legendItems) {
    const itemWidth = 18 + item.label.length * 6.6 + 18;
    if (cursorX + itemWidth > width - 16) { cursorX = 16; cursorY += 20; }
    legendMarkup.push(`<rect x="${cursorX}" y="${cursorY}" width="11" height="11" rx="2" fill="${item.color}" stroke="rgba(28,37,65,0.25)" stroke-width="1"/>` +
      `<text x="${cursorX + 16}" y="${cursorY + 10}" font-size="12" fill="${TEXT_COLOR}">${escapeXml(item.label)}</text>`);
    cursorX += itemWidth;
  }
  const height = cursorY + 46;
  const serializer = new XMLSerializer();
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family='${FONT_FAMILY}'>` +
    `<rect width="100%" height="100%" fill="#FFFFFF"/>` +
    `<text x="16" y="30" font-size="19" font-weight="700" fill="${NAVY}">${escapeXml(title)}</text>` +
    `<text x="16" y="50" font-size="12.5" fill="#5B6475">${escapeXml(subtitle)}</text>` +
    serializer.serializeToString(clone) +
    legendMarkup.join('') +
    `<text x="16" y="${height - 14}" font-size="11" fill="#5B6475">${escapeXml(source)}</text>` +
    '</svg>';
  return { markup, width, height };
}
