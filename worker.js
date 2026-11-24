// worker.js — Web Worker: off-thread demographic simulation + labor state computation
//
// Input message:  { type: 'simulate', params, laborParams, startPop, startYear, endYear }
//   params      — { tfr, sexRatio, mortMale, mortFemale, migration }
//   laborParams — { retireAgeMale, retireAgeFemale, unemploymentRate, womenActivity25_45,
//                   partTimeRate, disabMult, studyShift }
//   startPop    — { male: Float64Array(101), female: Float64Array(101) } (thousands)
// Output message: { type: 'result', snapshots, stateSnapshots, ratioSeries }
//   snapshots[year]      — { male, female }
//   stateSnapshots[year] — Float64Array(101 * 2 * 8), layout [(age*2 + sex)*8 + state]
//   ratioSeries[year]    — { payers, recipients, ratio }
// Error message:  { type: 'error', message }

import { runSimulation, computeAllStates } from './model.js';

self.onmessage = e => {
  const msg = e.data;
  if (!msg || msg.type !== 'simulate') return;

  try {
    const { params, laborParams, startPop, startYear, endYear } = msg;
    const snapshots = runSimulation(startPop, params, startYear, endYear);

    // allocateCohort needs TFR for the maternity-leave share
    const laborWithTfr = { ...laborParams, tfr: params.tfr };

    const stateSnapshots = {};
    const ratioSeries = {};
    for (let year = startYear; year <= endYear; year++) {
      const result = computeAllStates(snapshots[year], laborWithTfr);
      stateSnapshots[year] = result.states;
      ratioSeries[year] = { payers: result.payers, recipients: result.recipients, ratio: result.ratio };
    }

    self.postMessage({ type: 'result', snapshots, stateSnapshots, ratioSeries });
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
