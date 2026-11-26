// app.js -- Page controller: loads the data, builds the controls, runs the worker, renders charts and statistics
//
// Data:   data/calibration.json (required), data/anchors.json (required), data/benchmark.json (optional)
// State:  slider values are kept in slider units (see config.js); the URL hash stores every value that
//         differs from the default, so a link reproduces the scenario exactly.

import { END_YEAR, SECTIONS, SLIDERS, SCENARIOS, SERIES_METRICS, STATE_META, LEGACY_STATE_ORDER } from './config.js';
import { renderPyramid, renderTimeSeries, maxBinTotal, composeExportSvg } from './plot.js';
import { formatNumber, formatPopulation, formatSigned, formatPercent } from './format.js';
import { runSimulation, computeAgeIndicators, AGE_COUNT, STATE_COUNT, STATE_KEYS } from './model.js';

const SIMULATION_DEBOUNCE_MS = 90;
const CALIBRATION_SCHEMA_VERSION = 2;
const RELOAD_MESSAGE = 'Stránka bola aktualizovaná – obnovte ju (Ctrl+F5).';
const PLAY_INTERVAL_MS = 150;
const STATUS_LABELS = {
  provisional: 'Predbežná kalibrácia',
  partial: 'Čiastočná kalibrácia',
  official: 'Kalibrované na oficiálne dáta'
};

const app = {
  calibration: null,
  startPopulation: null,
  benchmark: null,
  benchmarkSeries: null,
  benchmarkMax: 0,
  startYear: 2024,
  sliders: SLIDERS,
  defaults: {},
  values: {},
  year: 2024,
  hiddenStates: new Set(),
  showBenchmark: false,
  metricId: SERIES_METRICS[0].id,
  result: null,
  xMax: 0,
  referenceRatio: NaN,
  references: {},
  requestCounter: 0,
  renderedRequestId: 0,
  pendingTimer: null,
  pendingTimerActive: false,
  playTimer: null,
  worker: null,
  sliderElements: new Map(),
  frameRequested: false
};

/**
 * Shorthand for document.getElementById.
 * Inputs:  id (string)
 * Output:  HTMLElement | null
 * Example: elementById('yearSlider').value
 */
function elementById(id) {
  return document.getElementById(id);
}

// ─── Data loading ───────────────────────────────────────────────────────────

/**
 * Fetch and parse a JSON file.
 * Inputs:  url (string), optional (boolean; when true a missing file returns null)
 * Output:  Promise<object|null>
 * Example: await loadJson('data/benchmark.json', true)
 */
async function loadJson(url, optional = false) {
  let response;
  try {
    response = await fetch(url, { cache: 'no-cache' });
  } catch (error) {
    if (optional) return null;
    throw error;
  }
  if (!response.ok) {
    if (optional) return null;
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Totals and old-age dependency of the EUROPOP2023 benchmark per year.
 * Inputs:  benchmark ({ years, male: {year: number[101]}, female: {...} })
 * Output:  { years: number[], total: number[], oldAgeDependency: number[] }
 * Example: buildBenchmarkSeries(app.benchmark).total[0]
 */
function buildBenchmarkSeries(benchmark) {
  const series = { years: [], total: [], oldAgeDependency: [] };
  for (const year of benchmark.years) {
    const indicators = computeAgeIndicators({ male: benchmark.male[year], female: benchmark.female[year] });
    series.years.push(year);
    series.total.push(indicators.total);
    series.oldAgeDependency.push(indicators.oldAgeDependency);
  }
  return series;
}

// ─── Slider helpers ─────────────────────────────────────────────────────────

/**
 * Number of decimals implied by a slider step.
 * Inputs:  step (number)
 * Output:  integer
 * Example: decimalsOf(0.05)  // -> 2
 */
function decimalsOf(step) {
  const text = String(step);
  return text.includes('.') ? text.split('.')[1].length : 0;
}

/**
 * Clamp a value to the slider range and round it to the slider step.
 * Inputs:  value (number, slider units), slider (SLIDERS item)
 * Output:  number
 * Example: snapToSlider(1.234, tfrSlider)  // -> 1.23
 */
function snapToSlider(value, slider) {
  const clamped = Math.min(slider.max, Math.max(slider.min, value));
  const steps = Math.round((clamped - slider.min) / slider.step);
  return Number((slider.min + steps * slider.step).toFixed(decimalsOf(slider.step)));
}

/**
 * Slider definition by scenario key.
 * Inputs:  key (string)
 * Output:  SLIDERS item | undefined
 * Example: sliderByKey('tfrTarget').min
 */
function sliderByKey(key) {
  return app.sliders.find(slider => slider.key === key);
}

/**
 * Default slider values from the calibration (converted to slider units, snapped to the step).
 * Inputs:  calibration (object)
 * Output:  { [key]: number }
 * Example: computeDefaults(calibration).tfrTarget
 */
function computeDefaults(calibration) {
  const defaults = {};
  const missing = [];
  for (const slider of app.sliders) {
    const modelValue = calibration.defaults[slider.key];
    if (!Number.isFinite(modelValue)) {
      missing.push(slider.key);
      continue;
    }
    defaults[slider.key] = snapToSlider(modelValue / slider.scale, slider);
  }
  if (missing.length) {
    const error = new Error(`Kalibrácia neobsahuje predvolené hodnoty: ${missing.join(', ')}`);
    error.userMessage = RELOAD_MESSAGE;
    throw error;
  }
  return defaults;
}

/**
 * Scenario object in model units from the current slider values.
 * Inputs:  values ({ [key]: number } in slider units; default app.values)
 * Output:  object (scenario for runSimulation)
 * Example: scenarioFromValues(app.values).retireAgeLinkShare
 */
function scenarioFromValues(values = app.values) {
  const scenario = {};
  for (const slider of app.sliders) scenario[slider.key] = values[slider.key] * slider.scale;
  return scenario;
}

/**
 * Slider values of a preset scenario.
 * Inputs:  scenarioId (string, SCENARIOS id)
 * Output:  { [key]: number } (slider units)
 * Example: presetValues('lowFertility').tfrTarget  // -> 1.2
 */
function presetValues(scenarioId) {
  const preset = SCENARIOS.find(scenario => scenario.id === scenarioId) || SCENARIOS[0];
  const values = { ...app.defaults };
  const overrides = preset.overrides(scenarioFromValues(app.defaults), app.calibration);
  for (const [key, modelValue] of Object.entries(overrides)) {
    const slider = sliderByKey(key);
    if (slider) values[key] = snapToSlider(modelValue / slider.scale, slider);
  }
  return values;
}

/**
 * Id of the preset that matches the slider values, or 'custom'.
 * Inputs:  values ({ [key]: number } slider units)
 * Output:  string
 * Example: matchingScenarioId(app.values)  // -> 'base'
 */
function matchingScenarioId(values) {
  for (const scenario of SCENARIOS) {
    const preset = presetValues(scenario.id);
    if (app.sliders.every(slider => Math.abs(preset[slider.key] - values[slider.key]) < 1e-9)) return scenario.id;
  }
  return 'custom';
}

/**
 * Human-readable name of the current scenario.
 * Inputs:  none
 * Output:  string
 * Example: scenarioName()  // -> 'Základný'
 */
function scenarioName() {
  const id = matchingScenarioId(app.values);
  return id === 'custom' ? 'vlastné nastavenie' : SCENARIOS.find(scenario => scenario.id === id).label;
}

// ─── Controls ───────────────────────────────────────────────────────────────

/**
 * Build the scenario selector, the slider sections and the metric selector.
 * Inputs:  none (uses app.calibration, app.values)
 * Output:  none (DOM)
 * Example: buildControls()
 */
function buildControls() {
  const scenarioSelect = elementById('scenarioSelect');
  scenarioSelect.replaceChildren(...SCENARIOS.map(scenario => new Option(scenario.label, scenario.id)));
  const customOption = new Option('Vlastné nastavenie', 'custom');
  customOption.disabled = true;
  scenarioSelect.append(customOption);

  const container = elementById('sliderSections');
  container.replaceChildren();
  for (const section of SECTIONS) {
    const sectionElement = document.createElement('section');
    sectionElement.className = 'control-section';
    const heading = document.createElement('h2');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'section-toggle';
    toggle.textContent = section.title;
    toggle.setAttribute('aria-expanded', 'true');
    const body = document.createElement('div');
    body.className = 'section-body';
    body.id = `section-${section.id}`;
    toggle.setAttribute('aria-controls', body.id);
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      body.hidden = expanded;
    });
    heading.append(toggle);
    sectionElement.append(heading, body);

    for (const slider of app.sliders.filter(item => item.section === section.id)) {
      const control = document.createElement('div');
      control.className = 'control';
      const labelRow = document.createElement('div');
      labelRow.className = 'control-label-row';
      const label = document.createElement('label');
      label.htmlFor = `slider-${slider.key}`;
      label.textContent = slider.label;
      const infoButton = document.createElement('button');
      infoButton.type = 'button';
      infoButton.className = 'info-button';
      infoButton.textContent = 'i';
      infoButton.setAttribute('aria-label', `Vysvetlenie: ${slider.label}`);
      infoButton.setAttribute('aria-describedby', `tip-${slider.key}`);
      const output = document.createElement('output');
      output.id = `value-${slider.key}`;
      output.htmlFor = `slider-${slider.key}`;
      output.className = 'control-value';
      labelRow.append(label, infoButton, output);
      const input = document.createElement('input');
      input.type = 'range';
      input.id = `slider-${slider.key}`;
      input.min = String(slider.min);
      input.max = String(slider.max);
      input.step = String(slider.step);
      input.value = String(app.values[slider.key]);
      input.setAttribute('aria-describedby', `tip-${slider.key}`);
      const tooltip = document.createElement('div');
      tooltip.id = `tip-${slider.key}`;
      tooltip.className = 'tooltip';
      tooltip.setAttribute('role', 'tooltip');
      tooltip.textContent = slider.tooltip(app.calibration);
      control.append(labelRow, input, tooltip);
      if (slider.key === 'womenActivityLevel') {
        const note = document.createElement('p');
        note.className = 'control-note';
        note.id = 'womenActivityNote';
        note.setAttribute('aria-live', 'polite');
        note.hidden = true;
        control.append(note);
      }
      body.append(control);
      attachTooltip(infoButton, tooltip);
      input.addEventListener('input', () => {
        app.values[slider.key] = snapToSlider(Number(input.value), slider);
        updateSliderDisplay(slider.key);
        syncScenarioSelect();
        scheduleSimulation();
      });
      app.sliderElements.set(slider.key, { input, output, slider });
      updateSliderDisplay(slider.key);
    }
    container.append(sectionElement);
  }

  const metricSelect = elementById('metricSelect');
  metricSelect.replaceChildren(...SERIES_METRICS.map(metric => new Option(metric.label, metric.id)));
  metricSelect.value = app.metricId;
  for (const name of ['ratio', 'dependency', 'economicOld', 'economic']) {
    attachTooltip(elementById(`${name}InfoButton`), elementById(`${name}Tooltip`));
  }
}

/**
 * Show a tooltip next to its button on hover, focus or tap (fixed position, kept inside the viewport).
 * Inputs:  button (HTMLButtonElement), tooltip (HTMLElement with role=tooltip)
 * Output:  none (event listeners)
 * Example: attachTooltip(infoButton, tooltipElement)
 */
function attachTooltip(button, tooltip) {
  const show = () => {
    tooltip.classList.add('visible');
    const buttonBox = button.getBoundingClientRect();
    const tooltipBox = tooltip.getBoundingClientRect();
    const margin = 8;
    let left = buttonBox.right + margin;
    if (left + tooltipBox.width > window.innerWidth - margin) left = Math.max(margin, buttonBox.left - tooltipBox.width - margin);
    let top = buttonBox.top + buttonBox.height / 2 - tooltipBox.height / 2;
    top = Math.max(margin, Math.min(top, window.innerHeight - tooltipBox.height - margin));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };
  const hide = () => tooltip.classList.remove('visible');
  button.addEventListener('mouseenter', show);
  button.addEventListener('mouseleave', hide);
  button.addEventListener('focus', show);
  button.addEventListener('blur', hide);
  button.addEventListener('click', () => (tooltip.classList.contains('visible') ? hide() : show()));
  button.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
}

/**
 * Write a slider's value into its input, its output element and aria-valuetext.
 * Inputs:  key (string, slider key)
 * Output:  none (DOM)
 * Example: updateSliderDisplay('tfrTarget')
 */
function updateSliderDisplay(key) {
  const { input, output, slider } = app.sliderElements.get(key);
  const text = slider.format(app.values[key]);
  input.value = String(app.values[key]);
  input.setAttribute('aria-valuetext', text);
  output.textContent = text;
  output.classList.toggle('changed', Math.abs(app.values[key] - app.defaults[key]) > 1e-9);
}

/**
 * Set the scenario selector to the matching preset (or "custom").
 * Inputs:  none
 * Output:  none (DOM)
 * Example: syncScenarioSelect()
 */
function syncScenarioSelect() {
  elementById('scenarioSelect').value = matchingScenarioId(app.values);
}

/**
 * Replace all slider values and refresh the controls.
 * Inputs:  values ({ [key]: number } slider units)
 * Output:  none
 * Example: applyValues(presetValues('highMigration'))
 */
function applyValues(values) {
  app.values = { ...values };
  for (const key of app.sliderElements.keys()) updateSliderDisplay(key);
  syncScenarioSelect();
}

// ─── Simulation ─────────────────────────────────────────────────────────────

/**
 * Ask the worker for a new simulation (debounced so dragging a slider does not flood it).
 * Inputs:  delay (number, milliseconds; default SIMULATION_DEBOUNCE_MS)
 * Output:  none
 * Example: scheduleSimulation(0)
 */
function scheduleSimulation(delay = SIMULATION_DEBOUNCE_MS) {
  clearTimeout(app.pendingTimer);
  setBusy(true);
  app.pendingTimerActive = true;
  app.pendingTimer = setTimeout(() => {
    app.pendingTimerActive = false;
    app.requestCounter += 1;
    app.worker.postMessage({
      type: 'simulate',
      requestId: app.requestCounter,
      startPopulation: app.startPopulation,
      scenario: scenarioFromValues(),
      startYear: app.startYear,
      endYear: END_YEAR
    });
  }, delay);
  updateHash();
}

/**
 * Receive worker results; stale answers (an older request) are ignored.
 * Inputs:  event (MessageEvent with { type, requestId, result | message })
 * Output:  none
 * Example: worker.onmessage = handleWorkerMessage
 */
function handleWorkerMessage(event) {
  const message = event.data;
  if (message.type === 'result') {
    if (message.requestId !== app.requestCounter) return;
    app.result = message.result;
    app.renderedRequestId = message.requestId;
    app.xMax = Math.max(maxBinTotal(Object.values(message.result.snapshots)), app.showBenchmark ? app.benchmarkMax : 0);
    renderAll();
  } else if (message.type === 'error') {
    setBusy(false);
    showError(`Simulácia zlyhala: ${message.message}`);
  }
}

/**
 * Toggle the "computing" indicator; the root element's data-state ('busy' | 'ready') lets tests wait for it.
 * Inputs:  busy (boolean)
 * Output:  none (DOM)
 * Example: setBusy(true)
 */
function setBusy(busy) {
  elementById('busyIndicator').hidden = !busy;
  document.documentElement.dataset.state = busy ? 'busy' : 'ready';
}

/**
 * Show an error message in place of the pyramid.
 * Inputs:  text (string)
 * Output:  none (DOM)
 * Example: showError('Chyba pri načítaní dát')
 */
function showError(text) {
  const message = document.createElement('p');
  message.className = 'error-message';
  message.setAttribute('role', 'alert');
  message.textContent = text;
  elementById('pyramidContainer').replaceChildren(message);
}

// ─── Rendering ──────────────────────────────────────────────────────────────

/**
 * Render everything that depends on the result and the selected year (coalesced to one frame).
 * Inputs:  none
 * Output:  none
 * Example: renderAll()
 */
function renderAll() {
  if (app.frameRequested) return;
  app.frameRequested = true;
  requestAnimationFrame(() => {
    app.frameRequested = false;
    renderYearView();
    renderSeriesView();
    const simulationPending = app.renderedRequestId !== app.requestCounter || app.pendingTimerActive;
    if (app.result && !simulationPending) setBusy(false);
  });
}

/**
 * Inner size of an element without padding.
 * Inputs:  element (HTMLElement)
 * Output:  { width: number, height: number } (pixels, floored)
 * Example: contentSize(elementById('pyramidContainer'))
 */
function contentSize(element) {
  const style = getComputedStyle(element);
  const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  return { width: Math.max(0, Math.floor(width)), height: Math.max(0, Math.floor(height)) };
}

/**
 * Benchmark population of a year as { male, female }, or null.
 * Inputs:  year (number)
 * Output:  object | null
 * Example: benchmarkSnapshot(2050)
 */
function benchmarkSnapshot(year) {
  if (!app.benchmark || !app.benchmark.male[year]) return null;
  return { male: app.benchmark.male[year], female: app.benchmark.female[year] };
}

/**
 * Render the pyramid, the legend, the KPIs and the statistics panel for the selected year.
 * Inputs:  none (uses app.result, app.year)
 * Output:  none (DOM)
 * Example: renderYearView()
 */
function renderYearView() {
  const result = app.result;
  if (!result) return;
  const index = result.years.indexOf(app.year);
  if (index < 0) return;
  const series = result.series;
  const container = elementById('pyramidContainer');
  const size = contentSize(container);
  if (size.width > 0 && size.height > 0) {
    renderPyramid(container, {
      snapshot: result.snapshots[app.year],
      states: result.states[app.year],
      hiddenStates: app.hiddenStates,
      benchmarkSnapshot: app.showBenchmark ? benchmarkSnapshot(app.year) : null,
      xMax: app.xMax,
      width: size.width,
      height: size.height,
      year: app.year
    });
  }
  elementById('yearDisplay').textContent = String(app.year);
  elementById('yearSlider').value = String(app.year);
  elementById('yearSlider').setAttribute('aria-valuetext', `Rok ${app.year}`);
  updateLegend();
  renderPyramidCaption(series, index);
  renderKpis(series, index);
  renderStatistics(series, index);
  updateWomenActivityNote();
}

/**
 * Population of the selected year above the pyramid (with the change against the base year).
 * Inputs:  series (object of number[]), index (integer, position of the year)
 * Output:  none (DOM)
 * Example: renderPyramidCaption(app.result.series, 26)
 */
function renderPyramidCaption(series, index) {
  const total = series.total[index];
  const change = 100 * (total / series.total[0] - 1);
  elementById('pyramidCaption').textContent = `Obyvateľstvo k 1. 1. ${app.year}: ${formatPopulation(total)}`
    + (index === 0 ? '' : ` (${formatSigned(change, 1)} % oproti ${app.startYear})`);
}

/**
 * Note under the women-activity slider when the actual base-year rate differs from the slider level
 * (the level holds at the default values of the other sliders; e.g. fewer mothers at home raise it).
 * Inputs:  none (uses app.result and app.values)
 * Output:  none (DOM)
 * Example: updateWomenActivityNote()
 */
function updateWomenActivityNote() {
  const note = elementById('womenActivityNote');
  if (!note || !app.result) return;
  const actual = app.result.series.womenActivity25to45[0];
  const differs = Number.isFinite(actual) && Math.abs(actual - app.values.womenActivityLevel) >= 0.05;
  note.hidden = !differs;
  note.textContent = differs ? `Pri aktuálnych predpokladoch v r. ${app.startYear}: ${formatPercent(actual, 1)}` : '';
}

/**
 * Build the legend once: one toggle button (aria-pressed) per labour state and the benchmark marker.
 * Inputs:  none
 * Output:  none (DOM; buttons stored in app.legendButtons)
 * Example: buildLegend()
 */
function buildLegend() {
  app.legendButtons = STATE_META.map(meta => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = meta.color;
    button.append(swatch, document.createTextNode(meta.label));
    button.addEventListener('click', () => {
      if (app.hiddenStates.has(meta.key)) app.hiddenStates.delete(meta.key);
      else app.hiddenStates.add(meta.key);
      updateHash();
      renderYearView();
    });
    return button;
  });
  app.legendBenchmarkMarker = document.createElement('span');
  app.legendBenchmarkMarker.className = 'legend-benchmark';
  app.legendBenchmarkMarker.textContent = 'EUROPOP2023 (súčet vekovej skupiny)';
  elementById('legend').replaceChildren(...app.legendButtons, app.legendBenchmarkMarker);
  updateLegend();
}

/**
 * Reflect the hidden states and the benchmark toggle in the legend.
 * Inputs:  none
 * Output:  none (DOM)
 * Example: updateLegend()
 */
function updateLegend() {
  STATE_META.forEach((meta, index) => {
    const visible = !app.hiddenStates.has(meta.key);
    app.legendButtons[index].setAttribute('aria-pressed', String(visible));
    app.legendButtons[index].title = visible ? 'Skryť kategóriu' : 'Zobraziť kategóriu';
  });
  app.legendBenchmarkMarker.hidden = !(app.showBenchmark && app.benchmark);
}

/**
 * Key indicators for the selected year with the base-year value of the default scenario: recipients per 100
 * payers (coloured against the base year), demographic old-age dependency (65+/20-64), economic old-age
 * dependency (old-age pensioners per 100 payers) and economic dependency (non-payers per 100 payers).
 * Inputs:  series (object of number[]), index (integer, position of the year)
 * Output:  none (DOM)
 * Example: renderKpis(app.result.series, 26)
 */
function renderKpis(series, index) {
  const ratio = series.recipientsPer100Payers[index];
  elementById('kpiRatioValue').textContent = formatNumber(ratio, 0);
  const pill = elementById('kpiRatioPill');
  const change = 100 * (ratio / app.referenceRatio - 1);
  let tone = 'neutral';
  let text = `ako v roku ${app.startYear}`;
  if (Number.isFinite(change) && Math.abs(change) >= 0.5) {
    tone = change < 0 ? 'good' : change <= 20 ? 'warn' : 'bad';
    text = `o ${formatNumber(Math.abs(change), 0)} % ${change < 0 ? 'menej' : 'viac'} ako ${app.startYear}`;
  }
  pill.className = `kpi-pill tone-${tone}`;
  pill.textContent = text;
  const references = app.references;
  elementById('kpiRatioReference').textContent = `Rok ${app.startYear}: ${formatNumber(references.recipientsPer100Payers, 0)}`;
  elementById('kpiDependencyValue').textContent = formatNumber(series.oldAgeDependency[index], 1);
  elementById('kpiDependencyReference').textContent = `65+ na 100 osôb 20–64 · ${app.startYear}: ${formatNumber(references.oldAgeDependency, 1)}`;
  elementById('kpiEconomicOldValue').textContent = formatNumber(series.economicOldAgeDependency[index], 0);
  elementById('kpiEconomicOldReference').textContent = `dôchodcovia na 100 platiteľov · ${app.startYear}: ${formatNumber(references.economicOldAgeDependency, 0)}`;
  elementById('kpiEconomicValue').textContent = formatNumber(series.economicDependency[index], 0);
  elementById('kpiEconomicReference').textContent = `neplatitelia na 100 platiteľov · ${app.startYear}: ${formatNumber(references.economicDependency, 0)}`;
}

/**
 * Fill the statistics panel for the selected year.
 * Inputs:  series (object of number[]), index (integer)
 * Output:  none (DOM)
 * Example: renderStatistics(app.result.series, 0)
 */
function renderStatistics(series, index) {
  const total = series.total[index];
  const set = (id, text) => { const element = elementById(id); if (element) element.textContent = text; };
  set('statYear', String(app.year));
  set('statMovementYear', String(app.year));
  set('statTotal', formatPopulation(total));
  set('statMale', formatPopulation(series.male[index]));
  set('statFemale', formatPopulation(series.female[index]));
  set('statChildren', `${formatPopulation(series.children[index])} · ${formatPercent(100 * series.children[index] / total)}`);
  set('statWorking', `${formatPopulation(series.working[index])} · ${formatPercent(100 * series.working[index] / total)}`);
  set('statSeniors', `${formatPopulation(series.seniors[index])} · ${formatPercent(100 * series.seniors[index] / total)}`);
  set('statMeanAge', formatNumber(series.meanAge[index], 1) + ' r.');
  set('statMedianAge', formatNumber(series.medianAge[index], 1) + ' r.');
  set('statPayers', `${formatPopulation(series.payers[index])} · ${formatPercent(100 * series.payers[index] / total)}`);
  set('statRecipients', `${formatPopulation(series.recipients[index])} · ${formatPercent(100 * series.recipients[index] / total)}`);
  set('statMaternity', formatPopulation(series.maternity[index]));
  set('statParental', formatPopulation(series.parental[index]));
  set('statWomenActivity', formatPercent(series.womenActivity25to45[index]));
  set('statBirths', formatNumber(series.births[index], 1) + ' tis.');
  set('statDeaths', formatNumber(series.deaths[index], 1) + ' tis.');
  set('statMigration', formatSigned(series.netMigration[index], 1) + ' tis.');
  set('statTfr', formatNumber(series.tfr[index], 2));
  set('statE0', `${formatNumber(series.e0Male[index], 1)} / ${formatNumber(series.e0Female[index], 1)} r.`);
  set('statRetireAge', `${formatNumber(series.retireAgeMale[index], 1)} / ${formatNumber(series.retireAgeFemale[index], 1)} r.`);
}

/**
 * Render the time-series chart of the selected metric.
 * Inputs:  none
 * Output:  none (DOM)
 * Example: renderSeriesView()
 */
function renderSeriesView() {
  const result = app.result;
  if (!result) return;
  const container = elementById('seriesContainer');
  const size = contentSize(container);
  if (size.width <= 0 || size.height <= 0) return;
  const metric = SERIES_METRICS.find(item => item.id === app.metricId) || SERIES_METRICS[0];
  renderTimeSeries(container, {
    metric,
    years: result.years,
    series: result.series,
    benchmarkSeries: app.showBenchmark ? app.benchmarkSeries : null,
    currentYear: app.year,
    referenceValue: metric.referenceSliderKey ? app.values[metric.referenceSliderKey] : null,
    width: size.width,
    height: size.height
  });
}

// ─── URL hash (shareable state) ─────────────────────────────────────────────

/**
 * Encode the state that differs from the defaults as URL hash parameters.
 * Inputs:  none
 * Output:  string (without '#')
 * Example: buildHash()  // -> 'tfr=1.2&y=2060'
 */
function buildHash() {
  const parameters = new URLSearchParams();
  for (const slider of app.sliders) {
    if (Math.abs(app.values[slider.key] - app.defaults[slider.key]) > 1e-9) parameters.set(slider.hashKey, String(app.values[slider.key]));
  }
  if (app.year !== app.startYear) parameters.set('y', String(app.year));
  if (app.metricId !== SERIES_METRICS[0].id) parameters.set('m', app.metricId);
  if (app.showBenchmark) parameters.set('b', '1');
  if (app.hiddenStates.size) parameters.set('h', STATE_META.filter(meta => app.hiddenStates.has(meta.key)).map(meta => meta.code).join('.'));
  return parameters.toString();
}

/**
 * Replace the URL hash with the current state (no history entry).
 * Inputs:  none
 * Output:  none
 * Example: updateHash()
 */
function updateHash() {
  const hash = buildHash();
  const target = hash ? `#${hash}` : '';
  if (target === location.hash || (!hash && !location.hash)) return;
  history.replaceState(null, '', target || location.pathname + location.search);
}

/**
 * Read the state from the URL hash (invalid values are clamped or ignored).
 * Inputs:  none (reads location.hash)
 * Output:  none (updates app.values, app.year, app.metricId, app.showBenchmark, app.hiddenStates)
 * Example: applyHash()
 */
function applyHash() {
  const parameters = new URLSearchParams(location.hash.replace(/^#/, ''));
  const values = { ...app.defaults };
  for (const slider of app.sliders) {
    const raw = parameters.get(slider.hashKey);
    if (raw !== null && Number.isFinite(Number(raw))) values[slider.key] = snapToSlider(Number(raw), slider);
  }
  applyValues(values);
  const year = Number(parameters.get('y'));
  app.year = Number.isInteger(year) && year >= app.startYear && year <= END_YEAR ? year : app.startYear;
  const metricId = parameters.get('m');
  app.metricId = SERIES_METRICS.some(metric => metric.id === metricId) ? metricId : SERIES_METRICS[0].id;
  elementById('metricSelect').value = app.metricId;
  app.showBenchmark = parameters.get('b') === '1' && Boolean(app.benchmark);
  elementById('benchmarkToggle').checked = app.showBenchmark;
  // hidden states: short codes (h=inv.star); numeric tokens come from links made before the 10-state layout
  const hidden = new Set();
  for (const token of (parameters.get('h') || '').split('.').map(part => part.trim().toLowerCase()).filter(Boolean)) {
    if (/^\d+$/.test(token)) {
      (LEGACY_STATE_ORDER[Number(token)] || []).forEach(key => hidden.add(key));
    } else {
      const meta = STATE_META.find(item => item.code === token || item.key.toLowerCase() === token);
      if (meta) hidden.add(meta.key);
    }
  }
  app.hiddenStates = hidden;
  if (parameters.has('wa')) showToast('Odkaz pochádza zo staršej verzie: posun aktivity žien (wa) sa už nepoužíva, použila sa predvolená úroveň.');
}

// ─── Export ─────────────────────────────────────────────────────────────────

/**
 * Offer a Blob to the user as a file download.
 * Inputs:  blob (Blob), fileName (string)
 * Output:  none
 * Example: downloadBlob(new Blob(['a,b']), 'data.csv')
 */
function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Short calibration status for export footers.
 * Inputs:  none
 * Output:  string
 * Example: calibrationStatusText()  // -> 'predbežná kalibrácia'
 */
function calibrationStatusText() {
  return (STATUS_LABELS[app.calibration.meta.status] || app.calibration.meta.status).toLowerCase();
}

/**
 * Export the pyramid of the selected year as SVG or PNG (2x) with title, legend and source.
 * Inputs:  format ('svg' | 'png')
 * Output:  Promise<void> (starts a download)
 * Example: await exportFigure('png')
 */
async function exportFigure(format) {
  const chartSvg = elementById('pyramidContainer').querySelector('svg');
  if (!chartSvg) return;
  const legendItems = STATE_META.filter(meta => !app.hiddenStates.has(meta.key)).map(meta => ({ label: meta.label, color: meta.color }));
  if (app.showBenchmark && app.benchmark) legendItems.push({ label: 'EUROPOP2023 (čiarkovane)', color: '#1C2541' });
  const composed = composeExportSvg(chartSvg, {
    title: `Populačná pyramída Slovenska, ${app.year}`,
    subtitle: `Scenár: ${scenarioName()} · obyvateľstvo k 1. 1. podľa veku, pohlavia a stavu na trhu práce (tis. osôb)`,
    source: `Zdroj: RRZ – Interaktívny populačný edukátor (${calibrationStatusText()}). Projekcia, nie prognóza.`,
    legendItems
  });
  const fileBase = `rrz-pyramida-${app.year}`;
  const svgBlob = new Blob([composed.markup], { type: 'image/svg+xml;charset=utf-8' });
  if (format === 'svg') {
    downloadBlob(svgBlob, `${fileBase}.svg`);
    return;
  }
  const scale = 2;
  const image = new Image();
  const url = URL.createObjectURL(svgBlob);
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('SVG sa nepodarilo vykresliť.'));
    image.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = composed.width * scale;
  canvas.height = composed.height * scale;
  const context = canvas.getContext('2d');
  context.scale(scale, scale);
  context.drawImage(image, 0, 0, composed.width, composed.height);
  URL.revokeObjectURL(url);
  const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  downloadBlob(pngBlob, `${fileBase}.png`);
}

/**
 * CSV text from a header and rows (comma separated, decimal point, quoted when needed).
 * Inputs:  header (string[]), rows ((string|number)[][])
 * Output:  string
 * Example: toCsv(['a', 'b'], [[1, 2.5]])  // -> 'a,b\n1,2.5\n'
 */
function toCsv(header, rows) {
  const cell = value => {
    if (typeof value === 'number') return Number.isFinite(value) ? String(Number(value.toPrecision(10))) : '';
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [header, ...rows].map(row => row.map(cell).join(',')).join('\n') + '\n';
}

/**
 * Export the yearly indicators of the current scenario (with the scenario parameters as columns).
 * Inputs:  none
 * Output:  none (download)
 * Example: exportSeriesCsv()
 */
function exportSeriesCsv() {
  const { years, series } = app.result;
  const stateColumns = STATE_META.map(meta => meta.csvKey);
  const columns = [
    ['rok', null], ['obyvatelstvo_tis', 'total'], ['muzi_tis', 'male'], ['zeny_tis', 'female'],
    ['vek_0_19_tis', 'children'], ['vek_20_64_tis', 'working'], ['vek_65plus_tis', 'seniors'],
    ['starobna_zavislost', 'oldAgeDependency'], ['ekonomicka_zavislost_starsich', 'economicOldAgeDependency'],
    ['celkova_ekonomicka_zavislost', 'economicDependency'], ['priemerny_vek', 'meanAge'], ['median_veku', 'medianAge'],
    ['zivonarodeni_tis', 'births'], ['zomreti_tis', 'deaths'], ['cista_migracia_tis', 'netMigration'],
    ['tfr', 'tfr'], ['e0_muzi', 'e0Male'], ['e0_zeny', 'e0Female'], ['e65_muzi', 'e65Male'], ['e65_zeny', 'e65Female'],
    ['dochodkovy_vek_muzi', 'retireAgeMale'], ['dochodkovy_vek_zeny', 'retireAgeFemale'],
    ['platitelia_tis', 'payers'], ['poberatelia_tis', 'recipients'], ['poberatelia_na_100_platitelov', 'recipientsPer100Payers'],
    ['aktivita_zien_25_45', 'womenActivity25to45']
  ];
  const scenario = scenarioFromValues();
  const parameterColumns = app.sliders.map(slider => [`param_${slider.hashKey}`, scenario[slider.key]]);
  const header = [...columns.map(([name]) => name), ...stateColumns, ...parameterColumns.map(([name]) => name)];
  const rows = years.map((year, index) => [
    year,
    ...columns.slice(1).map(([, key]) => series[key][index]),
    ...series.stateTotals[index],
    ...parameterColumns.map(([, value]) => value)
  ]);
  downloadBlob(new Blob(['﻿' + toCsv(header, rows)], { type: 'text/csv;charset=utf-8' }), 'rrz-simulacia-casove-rady.csv');
}

/**
 * Export the population of the selected year by single age, sex and labour state.
 * Inputs:  none
 * Output:  none (download)
 * Example: exportPyramidCsv()
 */
function exportPyramidCsv() {
  const snapshot = app.result.snapshots[app.year];
  const states = app.result.states[app.year];
  const header = ['rok', 'vek', 'pohlavie', 'populacia_tis', ...STATE_META.map(meta => meta.csvKey)];
  const rows = [];
  for (let age = 0; age < AGE_COUNT; age++) {
    for (let sex = 0; sex < 2; sex++) {
      const offset = (age * 2 + sex) * STATE_COUNT;
      rows.push([app.year, age === AGE_COUNT - 1 ? '100+' : age, sex === 0 ? 'M' : 'Z', sex === 0 ? snapshot.male[age] : snapshot.female[age], ...Array.from(states.subarray(offset, offset + STATE_COUNT))]);
    }
  }
  downloadBlob(new Blob(['﻿' + toCsv(header, rows)], { type: 'text/csv;charset=utf-8' }), `rrz-pyramida-${app.year}.csv`);
}

// ─── Misc UI ────────────────────────────────────────────────────────────────

/**
 * Show a short status message (aria-live).
 * Inputs:  text (string)
 * Output:  none (DOM)
 * Example: showToast('Odkaz skopírovaný')
 */
function showToast(text) {
  const toast = elementById('toast');
  toast.textContent = text;
  toast.classList.add('visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('visible'), 2600);
}

/**
 * Copy the shareable link of the current state to the clipboard.
 * Inputs:  none
 * Output:  Promise<void>
 * Example: await copyShareLink()
 */
async function copyShareLink() {
  updateHash();
  try {
    await navigator.clipboard.writeText(location.href);
    showToast('Odkaz na tento scenár je skopírovaný.');
  } catch {
    window.prompt('Skopírujte odkaz:', location.href);
  }
}

/**
 * Change the selected year and re-render (no new simulation is needed).
 * Inputs:  year (number)
 * Output:  none
 * Example: setYear(2050)
 */
function setYear(year) {
  app.year = Math.min(END_YEAR, Math.max(app.startYear, Math.round(year)));
  updateHash();
  renderAll();
}

/**
 * Start or stop the animation over the years.
 * Inputs:  none
 * Output:  none
 * Example: togglePlay()
 */
function togglePlay() {
  const button = elementById('playButton');
  if (app.playTimer) {
    clearInterval(app.playTimer);
    app.playTimer = null;
    button.setAttribute('aria-label', 'Prehrať vývoj');
    button.classList.remove('playing');
    return;
  }
  if (app.year >= END_YEAR) setYear(app.startYear);
  button.setAttribute('aria-label', 'Zastaviť prehrávanie');
  button.classList.add('playing');
  app.playTimer = setInterval(() => {
    if (app.year >= END_YEAR) { togglePlay(); return; }
    setYear(app.year + 1);
  }, PLAY_INTERVAL_MS);
}

/**
 * Show the provisional-calibration badge and notice when the calibration is not fully official.
 * Inputs:  none
 * Output:  none (DOM)
 * Example: renderCalibrationStatus()
 */
function renderCalibrationStatus() {
  const status = app.calibration.meta.status;
  const badge = elementById('calibrationBadge');
  badge.textContent = STATUS_LABELS[status] || status;
  badge.dataset.status = status;
  badge.hidden = false;
  const notice = elementById('provisionalNotice');
  let dismissed = false;
  try { dismissed = sessionStorage.getItem('rrzNoticeDismissed') === status; } catch { dismissed = false; }
  notice.hidden = status === 'official' || dismissed;
  elementById('noticeStatus').textContent = (STATUS_LABELS[status] || status).toLowerCase();
  elementById('dismissNotice').addEventListener('click', () => {
    notice.hidden = true;
    try { sessionStorage.setItem('rrzNoticeDismissed', status); } catch { /* storage unavailable */ }
    renderAll();
  });
  const benchmarkToggle = elementById('benchmarkToggle');
  benchmarkToggle.disabled = !app.benchmark;
  elementById('benchmarkLabel').title = app.benchmark ? 'Porovnať s projekciou Eurostatu EUROPOP2023 (základný variant)' : 'Dáta EUROPOP2023 zatiaľ nie sú nahrané (pozri metodiku).';
}

/**
 * Wire all static controls (year slider, buttons, selects, panels, resize).
 * Inputs:  none
 * Output:  none (event listeners)
 * Example: bindEvents()
 */
function bindEvents() {
  const yearSlider = elementById('yearSlider');
  yearSlider.min = String(app.startYear);
  yearSlider.max = String(END_YEAR);
  yearSlider.addEventListener('input', () => setYear(Number(yearSlider.value)));
  elementById('playButton').addEventListener('click', togglePlay);
  elementById('scenarioSelect').addEventListener('change', event => {
    applyValues(presetValues(event.target.value));
    scheduleSimulation(0);
  });
  elementById('resetButton').addEventListener('click', () => {
    applyValues({ ...app.defaults });
    app.hiddenStates.clear();
    setYear(app.startYear);
    scheduleSimulation(0);
  });
  elementById('metricSelect').addEventListener('change', event => {
    app.metricId = event.target.value;
    updateHash();
    renderSeriesView();
  });
  elementById('benchmarkToggle').addEventListener('change', event => {
    app.showBenchmark = event.target.checked && Boolean(app.benchmark);
    if (app.result) app.xMax = Math.max(maxBinTotal(Object.values(app.result.snapshots)), app.showBenchmark ? app.benchmarkMax : 0);
    updateHash();
    renderAll();
  });
  elementById('shareButton').addEventListener('click', copyShareLink);

  const exportButton = elementById('exportButton');
  const exportMenu = elementById('exportMenu');
  const closeMenu = () => { exportMenu.hidden = true; exportButton.setAttribute('aria-expanded', 'false'); };
  exportButton.addEventListener('click', event => {
    event.stopPropagation();
    const open = exportMenu.hidden;
    exportMenu.hidden = !open;
    exportButton.setAttribute('aria-expanded', String(open));
    if (open) exportMenu.querySelector('button').focus();
  });
  document.addEventListener('click', event => { if (!exportMenu.contains(event.target)) closeMenu(); });
  exportMenu.addEventListener('keydown', event => { if (event.key === 'Escape') { closeMenu(); exportButton.focus(); } });
  exportMenu.querySelectorAll('[data-export]').forEach(item => item.addEventListener('click', async () => {
    closeMenu();
    if (!app.result) return;
    try {
      const kind = item.dataset.export;
      if (kind === 'png' || kind === 'svg') await exportFigure(kind);
      else if (kind === 'series') exportSeriesCsv();
      else if (kind === 'pyramid') exportPyramidCsv();
    } catch (error) {
      showToast(`Export zlyhal: ${error.message}`);
    }
  }));

  for (const [buttonId, panelId] of [['toggleControls', 'controlsPanel'], ['toggleStats', 'statsPanel']]) {
    const button = elementById(buttonId);
    button.addEventListener('click', () => {
      const open = elementById(panelId).classList.toggle('open');
      button.setAttribute('aria-expanded', String(open));
    });
  }

  window.addEventListener('hashchange', () => {
    applyHash();
    scheduleSimulation(0);
  });
  const observer = new ResizeObserver(() => renderAll());
  observer.observe(elementById('pyramidContainer'));
  observer.observe(elementById('seriesContainer'));
}

// ─── Start ──────────────────────────────────────────────────────────────────

/**
 * Load data, build the page and start the first simulation.
 * Inputs:  none
 * Output:  Promise<void>
 * Example: init()
 */
async function init() {
  try {
    if (!window.Plot || !window.d3) throw new Error('Nepodarilo sa načítať knižnice grafov (vendor/).');
    const [calibration, anchors] = await Promise.all([loadJson('data/calibration.json'), loadJson('data/anchors.json')]);
    if (calibration.meta.schemaVersion !== CALIBRATION_SCHEMA_VERSION || STATE_META.map(meta => meta.key).join() !== STATE_KEYS.join()) {
      const error = new Error(`Nesúlad verzií (kalibrácia ${calibration.meta.schemaVersion}, stránka ${CALIBRATION_SCHEMA_VERSION})`);
      error.userMessage = RELOAD_MESSAGE;
      throw error;
    }
    app.sliders = SLIDERS.map(slider => (slider.maxFromCalibration ? { ...slider, max: slider.maxFromCalibration(calibration) } : slider));
    const benchmarkComponent = calibration.meta.components && calibration.meta.components.benchmark;
    const benchmark = benchmarkComponent && benchmarkComponent.status === 'official' ? await loadJson('data/benchmark.json', true) : null;
    app.calibration = calibration;
    app.startYear = calibration.baseYear;
    const start = anchors[String(app.startYear)];
    app.startPopulation = { male: Float64Array.from(start.male), female: Float64Array.from(start.female) };
    if (benchmark && benchmark.years && benchmark.years.length) {
      app.benchmark = benchmark;
      app.benchmarkSeries = buildBenchmarkSeries(benchmark);
      app.benchmarkMax = maxBinTotal(benchmark.years.map(year => ({ male: benchmark.male[year], female: benchmark.female[year] })));
    }
    app.defaults = computeDefaults(calibration);
    app.values = { ...app.defaults };
    app.year = app.startYear;
    const reference = runSimulation(app.startPopulation, scenarioFromValues(app.defaults), calibration, app.startYear, app.startYear).series;
    app.references = {
      recipientsPer100Payers: reference.recipientsPer100Payers[0],
      oldAgeDependency: reference.oldAgeDependency[0],
      economicOldAgeDependency: reference.economicOldAgeDependency[0],
      economicDependency: reference.economicDependency[0]
    };
    app.referenceRatio = app.references.recipientsPer100Payers;

    buildControls();
    buildLegend();
    renderCalibrationStatus();
    applyHash();
    bindEvents();

    app.worker = new Worker('worker.js', { type: 'module' });
    app.worker.onmessage = handleWorkerMessage;
    app.worker.onerror = event => showError(`Chyba výpočtového vlákna: ${event.message || 'neznáma chyba'}`);
    app.worker.postMessage({ type: 'init', calibration });
    scheduleSimulation(0);
  } catch (error) {
    console.error(error);
    showError(error.userMessage || `Chyba pri načítaní: ${error.message}. Stránku otvorte cez webový server (napr. GitHub Pages), nie ako súbor.`);
  }
}

init();
