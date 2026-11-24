// plot.js — Population pyramid visualization (Observable Plot 0.6.x)

const AGE_BIN = 5;
const MAX_AGE = 100;
const NUM_BINS = Math.ceil((MAX_AGE + 1) / AGE_BIN);

const STATE_NAMES = [
  'EMP_FULL', 'EMP_PART', 'STUDENT', 'INACTIVE',
  'UNEMP', 'SICK_MAT', 'DISAB', 'RETIRED'
];

const STATE_COLORS = {
  EMP_FULL: '#13B5EA',
  EMP_PART: '#3657A7',
  STUDENT:  '#DCB47B',
  INACTIVE: '#58595B',
  UNEMP:    '#9C479B',
  SICK_MAT: '#37B268',
  DISAB:    '#997468',
  RETIRED:  '#D82727'
};

const STATE_LABELS = {
  EMP_FULL: 'Zamestnaný (plný)',
  EMP_PART: 'Čiastočný úväzok',
  STUDENT:  'Nezaopatrené deti',
  INACTIVE: 'Neaktívny',
  UNEMP:    'Nezamestnaný',
  SICK_MAT: 'PN / Materská',
  DISAB:    'Invalidný',
  RETIRED:  'Dôchodca'
};

const PLOT_STYLE = {
  background: 'transparent',
  color: '#94a3b8',
  fontFamily: 'Inter, sans-serif',
  fontSize: '13px',
  fontWeight: '600'
};

const STACK_ORDER = [7, 6, 5, 4, 3, 2, 1, 0];

const AGE_LABELS = (() => {
  const labels = [];
  for (let b = NUM_BINS - 1; b >= 0; b--) {
    const s = b * AGE_BIN;
    labels.push(s >= 100 ? '100+' : `${s}–${s + AGE_BIN - 1}`);
  }
  return labels;
})();

function binLabel(binStart) {
  return binStart >= 100 ? '100+' : `${binStart}–${binStart + AGE_BIN - 1}`;
}

// ─── Format population (thousands → display string) ──────────────────────────

export function formatPopulation(thousands) {
  return thousands >= 1e3
    ? (thousands / 1e3).toFixed(2) + ' mil.'
    : thousands.toFixed(0) + ' tis.';
}

function tickFormat(d) {
  const abs = Math.abs(d);
  if (abs >= 1e3) return `${(abs / 1e3).toFixed(1)}m`;
  if (abs >= 1) return `${abs.toFixed(0)}`;
  return '0';
}

// ─── Build stacked pyramid data ──────────────────────────────────────────────

function buildPyramidData(snapshot, stateData, hiddenStates) {
  const data = [];
  let grandTotal = 0;
  for (let a = 0; a <= MAX_AGE; a++) {
    grandTotal += (snapshot.male[a] || 0) + (snapshot.female[a] || 0);
  }

  for (let b = 0; b < NUM_BINS; b++) {
    const binStart = b * AGE_BIN;
    const label = binLabel(binStart);

    let binTotal = 0;
    for (let a = binStart; a < binStart + AGE_BIN && a <= MAX_AGE; a++) {
      binTotal += (snapshot.male[a] || 0) + (snapshot.female[a] || 0);
    }
    const pct = grandTotal > 0 ? (binTotal / grandTotal * 100).toFixed(1) : '0.0';

    for (const stIdx of STACK_ORDER) {
      const stateName = STATE_NAMES[stIdx];
      if (hiddenStates && hiddenStates.has(stateName)) continue;

      let maleSum = 0, femaleSum = 0;
      for (let a = binStart; a < binStart + AGE_BIN && a <= MAX_AGE; a++) {
        maleSum += stateData[(a * 2) * 8 + stIdx] || 0;
        femaleSum += stateData[(a * 2 + 1) * 8 + stIdx] || 0;
      }

      const tip = `${label} · ${STATE_LABELS[stateName]}\n${formatPopulation(maleSum + femaleSum)} (${pct} % kohorta)`;

      data.push(
        { ageGroup: label, ageBin: binStart, sex: 'male', population: -maleSum, state: stateName, stateOrder: stIdx, tip },
        { ageGroup: label, ageBin: binStart, sex: 'female', population: femaleSum, state: stateName, stateOrder: stIdx, tip }
      );
    }
  }
  return data;
}

// ─── Render pyramid ──────────────────────────────────────────────────────────

export function renderPyramid(container, snapshot, options = {}) {
  const { stateData = null, hiddenStates = null, width, height } = options;
  if (!stateData) return;

  const w = Math.max(280, width || 600);
  const h = Math.max(300, height || 500);
  const narrow = w < 500;

  const data = buildPyramidData(snapshot, stateData, hiddenStates);
  const visibleStates = STATE_NAMES.filter(s => !hiddenStates || !hiddenStates.has(s));

  const plot = Plot.plot({
    width: w, height: h,
    marginLeft: narrow ? 40 : 54,
    marginRight: narrow ? 10 : 18,
    marginTop: 8,
    marginBottom: narrow ? 32 : 40,
    style: PLOT_STYLE,
    x: { label: 'tis. osôb', labelArrow: 'none', tickFormat: tickFormat, ticks: 5 },
    y: { domain: AGE_LABELS, label: null, tickSize: 0, padding: 0.08 },
    color: {
      domain: visibleStates,
      range: visibleStates.map(s => STATE_COLORS[s]),
      legend: false
    },
    marks: [
      Plot.barX(data, Plot.stackX({
        y: 'ageGroup', x: 'population', fill: 'state', order: 'stateOrder'
      })),
      Plot.ruleX([0], { stroke: '#334155', strokeWidth: 1 }),
      Plot.text([{ label: '♂ Muži' }], {
        frameAnchor: 'top-left', dx: 8, dy: 4,
        fill: '#94a3b8', fontWeight: 'bold', fontSize: 11, text: 'label'
      }),
      Plot.text([{ label: '♀ Ženy' }], {
        frameAnchor: 'top-right', dx: -8, dy: 4,
        fill: '#94a3b8', fontWeight: 'bold', fontSize: 11, text: 'label'
      }),
      Plot.tip(data.filter(d => d.sex === 'female'), Plot.pointerY({
        y: 'ageGroup', x: 'population', title: 'tip', frameAnchor: 'right'
      }))
    ]
  });

  container.replaceChildren(plot);
}

// ─── Legend HTML ──────────────────────────────────────────────────────────────

export function buildLegendHTML(hiddenStates) {
  return STATE_NAMES.map(name => {
    const hidden = hiddenStates && hiddenStates.has(name);
    return `<span class="legend-item ${hidden ? 'legend-hidden' : ''}" data-state="${name}">
      <span class="legend-swatch" style="background:${STATE_COLORS[name]}"></span>
      ${STATE_LABELS[name]}
    </span>`;
  }).join('');
}
