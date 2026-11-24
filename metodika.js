// metodika.js -- Methodology page: renders the LaTeX formulas (KaTeX) and the calibration status table

const STATUS_TEXT = { official: 'oficiálne dáta', provisional: 'predbežné', missing: 'chýba', partial: 'čiastočne' };
const COMPONENT_LABELS = {
  population: 'Obyvateľstvo k 1. 1.',
  mortality: 'Úmrtnosť (q_x)',
  mortalityImprovement: 'Zlepšovanie úmrtnosti (b_x)',
  fertility: 'Plodnosť',
  migration: 'Migrácia',
  retirementAge: 'Dôchodkový vek',
  pensions: 'Starobní a invalidní dôchodcovia',
  students: 'Študenti',
  sickLeave: 'PN',
  activity: 'Ekonomická aktivita',
  unemployment: 'Nezamestnanosť',
  partTime: 'Čiastočné úväzky',
  targets: 'Cieľové e0 (základný scenár)',
  benchmark: 'Porovnanie EUROPOP2023'
};
const ASSUMPTION_LABELS = {
  studentActivityShare: 'Podiel ekonomicky aktívnych študentov (odčítaný pri prepočte VZPS)',
  disabledActivityShare: 'Podiel ekonomicky aktívnych invalidných dôchodcov (odčítaný pri prepočte VZPS)',
  leeCarterWindowYears: 'Dĺžka histórie na odhad b_x (roky)',
  leeCarterExcludedYears: 'Roky vynechané z odhadu b_x',
  sensitivityTaper: 'Zoslabenie b_x pri chýbajúcej histórii',
  maternityLeaveWeeks: 'Dĺžka materskej (týždne)',
  sexRatioMaleShare: 'Podiel chlapcov medzi živonarodenými'
};

/**
 * Render all LaTeX in the page with KaTeX auto-render (\( \) inline, $$ $$ display).
 * Inputs:  none (uses window.renderMathInElement from vendor/katex)
 * Output:  none (DOM)
 * Example: renderFormulas()
 */
function renderFormulas() {
  if (typeof window.renderMathInElement !== 'function') return;
  window.renderMathInElement(document.getElementById('main'), {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '\\(', right: '\\)', display: false }
    ],
    throwOnError: false
  });
}

/**
 * Text of an assumption value for the list (arrays and objects in a compact form).
 * Inputs:  value (number | number[] | object)
 * Output:  string
 * Example: formatAssumption([2020, 2021])  // -> '2020, 2021'
 */
function formatAssumption(value) {
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') {
    return `od ${value.startAge} rokov lineárne na ${Math.round(value.endFactor * 100)} % v ${value.endAge} rokoch`;
  }
  return typeof value === 'number' ? value.toLocaleString('sk-SK') : String(value);
}

/**
 * Load data/calibration.json and fill the status table, the summary and the assumptions list.
 * Inputs:  none
 * Output:  Promise<void>
 * Example: await renderCalibration()
 */
async function renderCalibration() {
  const summary = document.getElementById('calibrationSummary');
  try {
    const response = await fetch('data/calibration.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const calibration = await response.json();
    const meta = calibration.meta;
    const statusWord = { official: 'Kalibrácia je založená na oficiálnych dátach.', partial: 'Kalibrácia je čiastočná: niektoré zložky sú stále predbežné.', provisional: 'Kalibrácia je predbežná: vstupy sú dočasné parametrické odhady, nie oficiálne štatistiky.' };
    summary.textContent = `${statusWord[meta.status] || meta.status} Základný rok ${calibration.baseYear}, súbor vytvorený ${meta.generatedAt} skriptom ${meta.generator}.`;
    summary.dataset.status = meta.status;
    const body = document.querySelector('#calibrationTable tbody');
    body.replaceChildren(...Object.entries(meta.components).map(([key, component]) => {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = COMPONENT_LABELS[key] || key;
      const status = document.createElement('td');
      const pill = document.createElement('span');
      pill.className = `status-pill status-${component.status}`;
      pill.textContent = STATUS_TEXT[component.status] || component.status;
      status.append(pill);
      const source = document.createElement('td');
      source.textContent = component.source;
      const year = document.createElement('td');
      year.textContent = component.year ?? '—';
      row.append(name, status, source, year);
      return row;
    }));
    const list = document.getElementById('assumptionsList');
    list.replaceChildren(...Object.entries(meta.assumptions || {}).map(([key, value]) => {
      const item = document.createElement('li');
      item.textContent = `${ASSUMPTION_LABELS[key] || key}: ${formatAssumption(value)}`;
      return item;
    }));
  } catch (error) {
    summary.textContent = `Stav kalibrácie sa nepodarilo načítať (${error.message}).`;
  }
}

renderFormulas();
renderCalibration();
