// worker.js -- Web Worker: runs the full simulation off the main thread
//
// Messages in:
//   { type: 'init', calibration }                                   -> { type: 'ready' }
//   { type: 'simulate', requestId, startPopulation, scenario, startYear, endYear }
//                                                                    -> { type: 'result', requestId, result }
// On failure:                                                        -> { type: 'error', requestId, message }
// `result` is the output of runSimulation() in model.js: { years, snapshots, states, series, womenActivityFit },
// where states[year] is a Float64Array of 202 cohorts x 10 labour states and womenActivityFit
// = { target, achieved, minimum, maximum (in %), shift, attainable } describes the women activity level solve.

import { runSimulation } from './model.js';

let calibration = null;

/**
 * Handle one message from the page (init or simulate) and post the answer back.
 * Inputs:  event (MessageEvent; event.data = message object described in the file header)
 * Output:  none (posts a message to the page)
 * Example: worker.postMessage({ type: 'simulate', requestId: 3, startPopulation, scenario, startYear: 2024, endYear: 2100 })
 */
function handleWorkerMessage(event) {
  const message = event.data || {};
  try {
    if (message.type === 'init') {
      calibration = message.calibration;
      self.postMessage({ type: 'ready' });
      return;
    }
    if (message.type === 'simulate') {
      if (!calibration) throw new Error('Worker nebol inicializovaný (chýba kalibrácia).');
      const result = runSimulation(message.startPopulation, message.scenario, calibration, message.startYear, message.endYear);
      self.postMessage({ type: 'result', requestId: message.requestId, result });
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      requestId: message.requestId,
      message: error && error.message ? error.message : String(error)
    });
  }
}

self.onmessage = handleWorkerMessage;
