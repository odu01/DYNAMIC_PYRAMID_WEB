// model.js — Cohort-component demographic model + labor force allocation
// P(t+1) = L(θ)·P(t) + M  |  Units: thousands

const AGES = 101;

// ─── Baseline mortality (SK 2024 calibrated) ─────────────────────────────────

const baselineMortality = (() => {
  const male = new Float64Array(AGES);
  const female = new Float64Array(AGES);

  for (let a = 0; a < AGES; a++) {
    let qm, qf;
    if (a === 0) {
      qm = 0.005; qf = 0.004;
    } else if (a < 5) {
      qm = 0.0004 + 0.0001 * (5 - a);
      qf = 0.0003 + 0.0001 * (5 - a);
    } else if (a < 15) {
      qm = 0.0002 + 0.00001 * a;
      qf = 0.0001 + 0.00001 * a;
    } else if (a < 40) {
      qm = 0.0005 + 0.00004 * (a - 15);
      qf = 0.0002 + 0.00002 * (a - 15);
    } else {
      qm = 0.0020 * Math.exp(0.095 * (a - 40));
      qf = 0.0012 * Math.exp(0.092 * (a - 40));
    }
    male[a] = Math.min(qm, 1.0);
    female[a] = Math.min(qf, 1.0);
  }
  male[100] = 1.0;
  female[100] = 1.0;
  return { male, female };
})();

// ─── Fertility profile (Beta(3,4), peak ~28) ────────────────────────────────

export function buildFertilityProfile(tfr) {
  const asfr = new Float64Array(AGES);
  let sum = 0;
  for (let a = 15; a <= 49; a++) {
    const x = (a - 15) / 34;
    asfr[a] = Math.pow(x, 2) * Math.pow(1 - x, 3);
    sum += asfr[a];
  }
  if (sum > 0) {
    const scale = tfr / sum;
    for (let a = 15; a <= 49; a++) asfr[a] *= scale;
  }
  return asfr;
}

// ─── Migration profile (Gaussian, peak 27) ──────────────────────────────────

export function buildMigrationProfile(netMigration) {
  const male = new Float64Array(AGES);
  const female = new Float64Array(AGES);
  const weights = new Float64Array(AGES);

  let sum = 0;
  for (let a = 0; a <= 60; a++) {
    weights[a] = Math.exp(-Math.pow((a - 27) / 12, 2) / 2);
    sum += weights[a];
  }

  if (sum > 0) {
    const half = netMigration / 2;
    for (let a = 0; a <= 60; a++) {
      const w = half * weights[a] / sum;
      male[a] = w;
      female[a] = w;
    }
  }
  return { male, female };
}

// ─── Step population one year ────────────────────────────────────────────────

export function stepPopulation(pop, params, asfr, mig) {
  const { sexRatio, mortMale, mortFemale } = params;
  if (!asfr) asfr = buildFertilityProfile(params.tfr);
  if (!mig) mig = buildMigrationProfile(params.migration);

  const nextMale = new Float64Array(AGES);
  const nextFemale = new Float64Array(AGES);

  let births = 0;
  for (let a = 15; a <= 49; a++) births += asfr[a] * pop.female[a];

  nextMale[0] = births * sexRatio + mig.male[0];
  nextFemale[0] = births * (1 - sexRatio) + mig.female[0];

  for (let a = 0; a < AGES - 1; a++) {
    const survM = 1 - Math.min(baselineMortality.male[a] * mortMale, 1.0);
    const survF = 1 - Math.min(baselineMortality.female[a] * mortFemale, 1.0);
    nextMale[a + 1] = Math.max(0, pop.male[a] * survM + mig.male[a + 1]);
    nextFemale[a + 1] = Math.max(0, pop.female[a] * survF + mig.female[a + 1]);
  }

  return { male: nextMale, female: nextFemale };
}

// ─── Full simulation ─────────────────────────────────────────────────────────

export function runSimulation(startPop, params, startYear, endYear) {
  const snapshots = {};
  const asfr = buildFertilityProfile(params.tfr);
  const mig = buildMigrationProfile(params.migration);

  let current = {
    male: new Float64Array(startPop.male),
    female: new Float64Array(startPop.female)
  };

  snapshots[startYear] = {
    male: new Float64Array(current.male),
    female: new Float64Array(current.female)
  };

  for (let y = startYear + 1; y <= endYear; y++) {
    current = stepPopulation(current, params, asfr, mig);
    snapshots[y] = {
      male: new Float64Array(current.male),
      female: new Float64Array(current.female)
    };
  }

  return snapshots;
}

// ─── Labor Force States ──────────────────────────────────────────────────────

const S = { EMP_FULL: 0, EMP_PART: 1, STUDENT: 2, INACTIVE: 3, UNEMP: 4, SICK_MAT: 5, DISAB: 6, RETIRED: 7 };

function logistic(x, mid, k) {
  return 1 / (1 + Math.exp(-k * (x - mid)));
}

function studentRate(age, shift) {
  if (age < 15 || age > 26 + shift) return 0;
  if (age <= 18) return 0.95;
  if (age <= 22 + shift) return 0.80;
  const end = 26 + shift;
  const start = 22 + shift;
  return age <= end ? 0.80 * (1 - (age - start) / (end - start + 1)) + 0.05 : 0;
}

function activityRate(age, sex, womenPeak) {
  if (sex === 0) {
    return 0.94 * logistic(age, 20, 0.5) * (1 - logistic(age, 58, 0.15));
  }
  return womenPeak * logistic(age, 22, 0.4) * (1 - logistic(age, 55, 0.15));
}

function disabilityRate(age, mult) {
  if (age < 30) return 0.002 * mult;
  if (age < 40) return 0.005 * mult;
  return Math.min(0.005 * Math.exp(0.08 * (age - 40)) * mult, 0.30);
}

function maternityRate(age, sex, tfr) {
  if (sex === 0 || age < 20 || age > 45) return 0;
  return Math.exp(-Math.pow((age - 30) / 6, 2) / 2) * 0.04 * (tfr / 2.1);
}

// ─── Allocate one cohort to labor states ─────────────────────────────────────

export function allocateCohort(pop, age, sex, lp, out) {
  out[0] = out[1] = out[2] = out[3] = out[4] = out[5] = out[6] = out[7] = 0;
  if (pop <= 0) return out;

  let rem = pop;

  if (age < 15) { out[S.STUDENT] = rem; return out; }

  const retireAge = sex === 0 ? lp.retireAgeMale : lp.retireAgeFemale;
  if (age >= retireAge) { out[S.RETIRED] = rem; return out; }

  const students = rem * studentRate(age, lp.studyShift);
  out[S.STUDENT] = students;
  rem -= students;
  if (rem <= 0) return out;

  const disabled = rem * disabilityRate(age, lp.disabMult);
  out[S.DISAB] = disabled;
  rem -= disabled;
  if (rem <= 0) return out;

  const active = rem * activityRate(age, sex, lp.womenActivity25_45);
  out[S.INACTIVE] += rem - active;
  rem = active;
  if (rem <= 0) return out;

  const unemp = rem * lp.unemploymentRate;
  out[S.UNEMP] = unemp;
  rem -= unemp;
  if (rem <= 0) return out;

  const sickMat = rem * Math.min(0.03 + maternityRate(age, sex, lp.tfr), 0.25);
  out[S.SICK_MAT] = sickMat;
  rem -= sickMat;
  if (rem <= 0) return out;

  out[S.EMP_PART] = rem * lp.partTimeRate;
  out[S.EMP_FULL] = rem * (1 - lp.partTimeRate);
  return out;
}

// ─── Compute all states for a snapshot ───────────────────────────────────────

export function computeAllStates(snapshot, laborParams) {
  const states = new Float64Array(AGES * 2 * 8);
  const buf = new Float64Array(8);
  let payers = 0, recipients = 0;

  for (let a = 0; a < AGES; a++) {
    for (let sex = 0; sex < 2; sex++) {
      const pop = sex === 0 ? snapshot.male[a] : snapshot.female[a];
      allocateCohort(pop, a, sex, laborParams, buf);
      const base = (a * 2 + sex) * 8;
      for (let i = 0; i < 8; i++) states[base + i] = buf[i];
      payers += buf[0] + 0.5 * buf[1];
      recipients += buf[4] + buf[5] + buf[6] + buf[7];
    }
  }

  return {
    states,
    payers,
    recipients,
    ratio: recipients > 0 ? payers / recipients : Infinity
  };
}
