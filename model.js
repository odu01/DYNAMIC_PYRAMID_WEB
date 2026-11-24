// model.js -- Cohort-component population projection + labour-market state allocation
//
// Units: thousands of persons. Ages 0..100 in single years; age 100 is the open interval 100+.
// Sex index: 0 = male, 1 = female. Population arrays are indexed by age (length 101).
// Pure functions only (no DOM): used by the Web Worker, the page and the Node tools.
//
// Demography (one year t -> t+1, Preston-Heuveline-Guillot cohort-component method):
//   P_{x+1}(t+1) = P_x(t) * L_{x+1}/L_x + M_{x+1}(t)                      x = 0..98
//   P_{100}(t+1) = (P_99(t) + P_100(t)) * T_100/T_99 + M_100(t)           open interval
//   B(t)         = sum_x f_x(t) * (F_x(t) + F_x(t+1)) / 2                  mid-year exposure
//   P_0(t+1)     = B(t) * s * L_0/l_0 + M_0(t)                            s = sex share at birth
// Mortality improvement: Lee-Carter  ln m_x(t) = a_x + b_x * k_t, k_t linear in t,
//   k_T solved so that e0(T) equals the scenario target.
// Labour market: conditional waterfall over 8 mutually exclusive states (see allocateLabourStates).

export const AGE_COUNT = 101;
export const OPEN_AGE = 100;
export const STATE_COUNT = 8;
export const STATE = Object.freeze({
  EMP_FULL: 0, EMP_PART: 1, STUDENT: 2, INACTIVE: 3,
  UNEMP: 4, SICK_MAT: 5, DISAB: 6, RETIRED: 7
});
export const STATE_KEYS = Object.freeze([
  'EMP_FULL', 'EMP_PART', 'STUDENT', 'INACTIVE', 'UNEMP', 'SICK_MAT', 'DISAB', 'RETIRED'
]);
export const CHILD_AGE_LIMIT = 15;

const INFANT_DEATH_TIMING = 0.1;   // a_0: mean fraction of the first year lived by infants who die
const MAX_PROBABILITY = 0.999999;
const MAX_UNEMPLOYMENT_SHARE = 0.95;
const MAX_ABSENCE_SHARE = 0.6;
const MAX_ACTIVITY_SHARE = 0.995;
const RETIREMENT_AGE_BOUNDS = [55, 75];

// ─── Small numeric helpers ───────────────────────────────────────────────────

/**
 * Clamp a number to a closed interval.
 * Inputs:  value (number, scalar), lower (number, scalar), upper (number, scalar)
 * Output:  number (scalar) in [lower, upper]
 * Example: clamp(1.4, 0, 1)  // -> 1
 */
export function clamp(value, lower, upper) {
  return Math.min(upper, Math.max(lower, value));
}

/**
 * Linear interpolation in an age profile at a (possibly fractional) age.
 * Ages outside [0, 100] take the boundary value.
 * Inputs:  profile (number[] | Float64Array, 101 values indexed by age), age (number, scalar)
 * Output:  number (scalar)
 * Example: interpolateProfile(retiredShareMale, 62.5)  // mean of ages 62 and 63
 */
export function interpolateProfile(profile, age) {
  if (age <= 0) return profile[0];
  if (age >= OPEN_AGE) return profile[OPEN_AGE];
  const lowerAge = Math.floor(age);
  const weight = age - lowerAge;
  return weight === 0 ? profile[lowerAge] : profile[lowerAge] * (1 - weight) + profile[lowerAge + 1] * weight;
}

/**
 * Value on a linear path from baseValue (baseYear) to targetValue (targetYear), constant afterwards.
 * Inputs:  baseValue, targetValue, baseYear, targetYear, year (number, scalars)
 * Output:  number (scalar)
 * Example: linearPath(1.5, 1.8, 2024, 2050, 2037)  // -> 1.65
 */
export function linearPath(baseValue, targetValue, baseYear, targetYear, year) {
  if (targetYear <= baseYear) return year <= baseYear ? baseValue : targetValue;
  const progress = clamp((year - baseYear) / (targetYear - baseYear), 0, 1);
  return baseValue + (targetValue - baseValue) * progress;
}

/**
 * Convert a one-year death probability q to a constant hazard (central death rate) m = -ln(1-q).
 * Inputs:  probability (number, scalar in [0, 1))
 * Output:  number (scalar, >= 0)
 * Example: hazardFromProbability(0.01)  // -> 0.01005
 */
export function hazardFromProbability(probability) {
  return -Math.log(1 - clamp(probability, 0, MAX_PROBABILITY));
}

/**
 * Convert a constant hazard m to a one-year death probability q = 1 - exp(-m).
 * Inputs:  hazard (number, scalar >= 0)
 * Output:  number (scalar in [0, 1))
 * Example: probabilityFromHazard(0.01005)  // -> 0.01
 */
export function probabilityFromHazard(hazard) {
  return clamp(1 - Math.exp(-Math.max(0, hazard)), 0, MAX_PROBABILITY);
}

// ─── Life table and survival ────────────────────────────────────────────────

/**
 * Period life table from one-year death probabilities (radix l_0 = 1).
 * a_x = 0.5 except a_0 = 0.1; open interval 100+: L_100 = l_100 / m_100, m_100 = -ln(1-q_100).
 * Inputs:  qx (number[] | Float64Array, 101 values; qx[100] = annual death probability in 100+)
 * Output:  { lx, dx, Lx, Tx, ex } (Float64Array, 101 values each)
 * Example: buildLifeTable(qxMale).ex[0]  // life expectancy at birth
 */
export function buildLifeTable(qx) {
  const lx = new Float64Array(AGE_COUNT);
  const dx = new Float64Array(AGE_COUNT);
  const Lx = new Float64Array(AGE_COUNT);
  const Tx = new Float64Array(AGE_COUNT);
  const ex = new Float64Array(AGE_COUNT);

  lx[0] = 1;
  for (let age = 0; age < OPEN_AGE; age++) {
    const deathProbability = clamp(qx[age], 0, MAX_PROBABILITY);
    dx[age] = lx[age] * deathProbability;
    lx[age + 1] = lx[age] - dx[age];
    const separationFactor = age === 0 ? INFANT_DEATH_TIMING : 0.5;
    Lx[age] = lx[age + 1] + separationFactor * dx[age];
  }
  const openHazard = hazardFromProbability(clamp(qx[OPEN_AGE], 1e-6, MAX_PROBABILITY));
  dx[OPEN_AGE] = lx[OPEN_AGE];
  Lx[OPEN_AGE] = lx[OPEN_AGE] / openHazard;

  Tx[OPEN_AGE] = Lx[OPEN_AGE];
  for (let age = OPEN_AGE - 1; age >= 0; age--) Tx[age] = Tx[age + 1] + Lx[age];
  for (let age = 0; age < AGE_COUNT; age++) ex[age] = lx[age] > 0 ? Tx[age] / lx[age] : 0;

  return { lx, dx, Lx, Tx, ex };
}

/**
 * Survival ratios of the cohort-component projection derived from a life table.
 * ageRatios[x] = L_{x+1}/L_x for x = 0..98; ageRatios[99] = T_100/T_99 (ages 99 and 100+ into 100+);
 * birthSurvival = L_0/l_0 (births during the year alive at its end).
 * Inputs:  lifeTable ({ Lx, Tx }: Float64Array, 101 values each)
 * Output:  { ageRatios: Float64Array(100), birthSurvival: number }
 * Example: survivalRatios(buildLifeTable(qxFemale)).ageRatios[64]  // 64 -> 65
 */
export function survivalRatios(lifeTable) {
  const { Lx, Tx } = lifeTable;
  const ageRatios = new Float64Array(OPEN_AGE);
  for (let age = 0; age < OPEN_AGE - 1; age++) {
    ageRatios[age] = Lx[age] > 0 ? Lx[age + 1] / Lx[age] : 0;
  }
  ageRatios[OPEN_AGE - 1] = Tx[OPEN_AGE - 1] > 0 ? Tx[OPEN_AGE] / Tx[OPEN_AGE - 1] : 0;
  return { ageRatios, birthSurvival: Lx[0] };
}

// ─── Lee-Carter mortality improvement ───────────────────────────────────────

/**
 * Lee-Carter parameters anchored on the base-year mortality: a_x = ln m_x(base), b_x >= 0 with sum 1.
 * Inputs:  baseQx (number[], 101 values), ageSensitivity (number[], 101 values, any positive scale)
 * Output:  { logBaseHazard: Float64Array(101), sensitivity: Float64Array(101) }
 * Example: prepareLeeCarter(calibration.mortality.male.qx, calibration.mortality.male.ageSensitivity)
 */
export function prepareLeeCarter(baseQx, ageSensitivity) {
  const logBaseHazard = new Float64Array(AGE_COUNT);
  const sensitivity = new Float64Array(AGE_COUNT);
  let sensitivitySum = 0;
  for (let age = 0; age < AGE_COUNT; age++) {
    const hazard = hazardFromProbability(clamp(baseQx[age], 1e-9, MAX_PROBABILITY));
    logBaseHazard[age] = Math.log(Math.max(hazard, 1e-12));
    sensitivity[age] = Math.max(0, ageSensitivity[age]);
    sensitivitySum += sensitivity[age];
  }
  if (!(sensitivitySum > 0)) throw new Error('Lee-Carter ageSensitivity must have a positive sum');
  for (let age = 0; age < AGE_COUNT; age++) sensitivity[age] /= sensitivitySum;
  return { logBaseHazard, sensitivity };
}

/**
 * Death probabilities implied by the Lee-Carter index k: q_x = 1 - exp(-exp(a_x + b_x k)).
 * Inputs:  leeCarter ({ logBaseHazard, sensitivity }: Float64Array(101)), kappa (number, scalar)
 * Output:  Float64Array(101)
 * Example: qxFromKappa(leeCarterMale, -50)  // lower mortality than the base year
 */
export function qxFromKappa(leeCarter, kappa) {
  const qx = new Float64Array(AGE_COUNT);
  for (let age = 0; age < AGE_COUNT; age++) {
    qx[age] = probabilityFromHazard(Math.exp(leeCarter.logBaseHazard[age] + leeCarter.sensitivity[age] * kappa));
  }
  return qx;
}

/**
 * Lee-Carter index k at which life expectancy at birth equals the target (bisection; e0 decreases in k).
 * Inputs:  leeCarter ({ logBaseHazard, sensitivity }), targetLifeExpectancy (number, years)
 * Output:  number (scalar k; 0 reproduces the base year)
 * Example: solveKappaForLifeExpectancy(leeCarterFemale, 88.5)
 */
export function solveKappaForLifeExpectancy(leeCarter, targetLifeExpectancy) {
  const lifeExpectancyAt = kappa => buildLifeTable(qxFromKappa(leeCarter, kappa)).ex[0];
  let lowerKappa = -3000;
  let upperKappa = 600;
  if (targetLifeExpectancy >= lifeExpectancyAt(lowerKappa)) return lowerKappa;
  if (targetLifeExpectancy <= lifeExpectancyAt(upperKappa)) return upperKappa;
  for (let iteration = 0; iteration < 80; iteration++) {
    const middleKappa = 0.5 * (lowerKappa + upperKappa);
    if (lifeExpectancyAt(middleKappa) > targetLifeExpectancy) lowerKappa = middleKappa;
    else upperKappa = middleKappa;
  }
  return 0.5 * (lowerKappa + upperKappa);
}

// ─── Fertility and migration ────────────────────────────────────────────────

/**
 * Age-specific fertility rates for a given TFR: f_x = TFR * shape_x / sum(shape).
 * Inputs:  fertilityShape (number[], 101 values >= 0), totalFertilityRate (number, children per woman)
 * Output:  Float64Array(101), births per woman per year by age
 * Example: buildAsfr(calibration.fertility.shape, 1.5)
 */
export function buildAsfr(fertilityShape, totalFertilityRate) {
  const asfr = new Float64Array(AGE_COUNT);
  let shapeSum = 0;
  for (let age = 0; age < AGE_COUNT; age++) shapeSum += Math.max(0, fertilityShape[age]);
  if (!(shapeSum > 0)) return asfr;
  for (let age = 0; age < AGE_COUNT; age++) {
    asfr[age] = totalFertilityRate * Math.max(0, fertilityShape[age]) / shapeSum;
  }
  return asfr;
}

/**
 * Net migrants by age and sex for a total net migration N. Emigration is held at its base level E
 * with its own age profile; immigration absorbs the change: net_x = (N + E) * imm_x - E * emi_x.
 * (Profiles sum to 1 over both sexes; with E = 0 this is simply N * imm_x.)
 * Inputs:  migrationCalibration ({ emigrationBase (thousands), immigrationProfile, emigrationProfile:
 *                                  { male, female } number[101] }), netMigration (number, thousands)
 * Output:  { male: Float64Array(101), female: Float64Array(101) }, thousands by age at the end of the year
 * Example: scaleMigration(calibration.migration, 5)
 */
export function scaleMigration(migrationCalibration, netMigration) {
  const { emigrationBase, immigrationProfile, emigrationProfile } = migrationCalibration;
  const immigrationTotal = netMigration + emigrationBase;
  const male = new Float64Array(AGE_COUNT);
  const female = new Float64Array(AGE_COUNT);
  for (let age = 0; age < AGE_COUNT; age++) {
    male[age] = immigrationTotal * immigrationProfile.male[age] - emigrationBase * emigrationProfile.male[age];
    female[age] = immigrationTotal * immigrationProfile.female[age] - emigrationBase * emigrationProfile.female[age];
  }
  return { male, female };
}

// ─── One projection step ────────────────────────────────────────────────────

/**
 * Project the population one year ahead (1 January t -> 1 January t+1).
 * Migrants are added by age at the end of the year; emigration cannot push a cohort below zero.
 * Inputs:  population ({ male, female }: Float64Array(101), thousands on 1 January t)
 *          survival ({ male, female }: output of survivalRatios)
 *          asfr (Float64Array(101), births per woman), migration ({ male, female }: Float64Array(101))
 *          maleBirthShare (number, share of boys among births, e.g. 0.512)
 * Output:  { next: { male, female } Float64Array(101), births, deaths, migrationApplied } (thousands)
 * Example: projectOneYear(pop2024, survival2024, asfr2024, migration2024, 0.512).next
 */
export function projectOneYear(population, survival, asfr, migration, maleBirthShare) {
  const next = { male: new Float64Array(AGE_COUNT), female: new Float64Array(AGE_COUNT) };
  let startTotal = 0;
  let survivorsTotal = 0;
  let migrationApplied = 0;

  for (const sexKey of ['male', 'female']) {
    const start = population[sexKey];
    const target = next[sexKey];
    const ratios = survival[sexKey].ageRatios;
    for (let age = 0; age < OPEN_AGE - 1; age++) target[age + 1] = start[age] * ratios[age];
    target[OPEN_AGE] = (start[OPEN_AGE - 1] + start[OPEN_AGE]) * ratios[OPEN_AGE - 1];
    for (let age = 0; age < AGE_COUNT; age++) {
      startTotal += start[age];
      survivorsTotal += target[age];
    }
    for (let age = 1; age < AGE_COUNT; age++) {
      const beforeMigration = target[age];
      target[age] = Math.max(0, beforeMigration + migration[sexKey][age]);
      migrationApplied += target[age] - beforeMigration;
    }
  }

  let births = 0;
  for (let age = 0; age < AGE_COUNT; age++) {
    if (asfr[age] > 0) births += asfr[age] * 0.5 * (population.female[age] + next.female[age]);
  }
  const maleBirths = births * maleBirthShare;
  const femaleBirths = births - maleBirths;
  const maleInfants = maleBirths * survival.male.birthSurvival;
  const femaleInfants = femaleBirths * survival.female.birthSurvival;
  next.male[0] = Math.max(0, maleInfants + migration.male[0]);
  next.female[0] = Math.max(0, femaleInfants + migration.female[0]);
  migrationApplied += (next.male[0] - maleInfants) + (next.female[0] - femaleInfants);

  const deaths = (startTotal - survivorsTotal) + (births - maleInfants - femaleInfants);
  return { next, births, deaths, migrationApplied };
}

// ─── Labour market ──────────────────────────────────────────────────────────

/**
 * Map an age to the base-year profile age when the retirement age differs from the reference.
 * Below pivotAge nothing changes. From (retireAge - window) upwards the profile is shifted by
 * (retireAge - retireAgeRef), so early retirement and the jump at the retirement age move intact;
 * [pivotAge, retireAge - window] is stretched linearly onto [pivotAge, retireAgeRef - window].
 * window = min(5, (retireAge - pivotAge) / 2) keeps the mapping continuous and increasing.
 * Inputs:  age, retireAge, retireAgeRef, pivotAge (number, scalars; retireAge > pivotAge)
 * Output:  number (scalar, profile age)
 * Example: effectiveLabourAge(64, 65, 63, 50)  // -> 62 (one year before retirement, as in the base year)
 */
export function effectiveLabourAge(age, retireAge, retireAgeRef, pivotAge) {
  const shift = retireAge - retireAgeRef;
  if (age <= pivotAge || Math.abs(shift) < 1e-9) return age;
  const window = Math.min(5, Math.max(0, (retireAge - pivotAge) / 2));
  const shiftStart = retireAge - window;
  if (age >= shiftStart) return age - shift;
  return pivotAge + (age - pivotAge) * (shiftStart - shift - pivotAge) / (shiftStart - pivotAge);
}

/**
 * Allocate every age-sex cohort to 8 mutually exclusive labour states (conditional waterfall):
 *   age < 15                     -> STUDENT (dependent children)
 *   RETIRED  = N * r(x')                      old-age + early pension (x' = effectiveLabourAge)
 *   DISAB    = N * d(x') * disabilityMultiplier
 *   STUDENT  = (N - R - D) * s(x - studyShift)
 *   active   = (N - R - D - S) * a(x') [+ shift for women 25-45];  INACTIVE = the rest
 *   UNEMP    = active * u(x) * scaleU    scaleU sets the aggregate unemployment rate to the target
 *   SICK_MAT = employed * (sick(x) + f_x * maternityLeaveYears)   (maternity for women only)
 *   EMP_PART = working * p(x) * scaleP   scaleP sets the aggregate part-time share to the target
 *   EMP_FULL = working - EMP_PART
 * Inputs:  population ({ male, female }: Float64Array(101), thousands)
 *          labourInputs ({ retireAge: [m, f], retireAgeRef: [m, f], pivotAge, unemploymentRate (0-1),
 *                          partTimeRate (0-1), womenActivityShift (share), disabilityMultiplier,
 *                          studyShift (years), maternityLeaveYears })
 *          profiles ({ retired, disabled, student, activity, unemployment, partTime, sick }:
 *                     each { male, female } number[101])
 *          asfr (Float64Array(101), fertility rates of the year, drives maternity leave)
 * Output:  { states: Float64Array(101*2*8) indexed [(age*2 + sex)*8 + state], totals: Float64Array(8),
 *            payers, recipients, womenActivity25to45 (share) }
 * Example: allocateLabourStates(pop2024, labourInputs, calibration.labour.profiles, asfr2024).totals
 */
export function allocateLabourStates(population, labourInputs, profiles, asfr) {
  const cohortCount = AGE_COUNT * 2;
  const states = new Float64Array(cohortCount * STATE_COUNT);
  const activePersons = new Float64Array(cohortCount);
  const unemploymentPropensity = new Float64Array(cohortCount);
  const workingPersons = new Float64Array(cohortCount);
  const partTimePropensity = new Float64Array(cohortCount);
  const sexKeys = ['male', 'female'];

  let activeTotal = 0;
  let unemploymentRawTotal = 0;
  let womenActive25to45 = 0;
  let womenPopulation25to45 = 0;

  // Pass 1: pensions, students, activity
  for (let age = 0; age < AGE_COUNT; age++) {
    for (let sex = 0; sex < 2; sex++) {
      const sexKey = sexKeys[sex];
      const cohort = age * 2 + sex;
      const stateOffset = cohort * STATE_COUNT;
      const persons = Math.max(0, population[sexKey][age]);
      if (sex === 1 && age >= 25 && age <= 45) womenPopulation25to45 += persons;
      if (persons <= 0) continue;
      if (age < CHILD_AGE_LIMIT) {
        states[stateOffset + STATE.STUDENT] = persons;
        continue;
      }
      const labourAge = effectiveLabourAge(age, labourInputs.retireAge[sex], labourInputs.retireAgeRef[sex], labourInputs.pivotAge);
      const retired = persons * clamp(interpolateProfile(profiles.retired[sexKey], labourAge), 0, 1);
      const disabledShare = clamp(interpolateProfile(profiles.disabled[sexKey], labourAge) * labourInputs.disabilityMultiplier, 0, 1);
      const disabled = Math.min(persons - retired, persons * disabledShare);
      const notPensioner = persons - retired - disabled;
      const students = notPensioner * clamp(interpolateProfile(profiles.student[sexKey], age - labourInputs.studyShift), 0, 1);
      const remaining = notPensioner - students;

      let activityShare = interpolateProfile(profiles.activity[sexKey], labourAge);
      if (sex === 1 && age >= 25 && age <= 45) activityShare += labourInputs.womenActivityShift;
      const active = remaining * clamp(activityShare, 0, MAX_ACTIVITY_SHARE);

      states[stateOffset + STATE.RETIRED] = retired;
      states[stateOffset + STATE.DISAB] = disabled;
      states[stateOffset + STATE.STUDENT] = students;
      states[stateOffset + STATE.INACTIVE] = remaining - active;
      activePersons[cohort] = active;
      unemploymentPropensity[cohort] = clamp(interpolateProfile(profiles.unemployment[sexKey], age), 0, 1);
      activeTotal += active;
      unemploymentRawTotal += active * unemploymentPropensity[cohort];
      if (sex === 1 && age >= 25 && age <= 45) womenActive25to45 += active;
    }
  }

  // Pass 2: unemployment (scaled to the aggregate target) and absences
  const unemploymentScale = unemploymentRawTotal > 0
    ? labourInputs.unemploymentRate * activeTotal / unemploymentRawTotal : 0;
  let workingTotal = 0;
  let partTimeRawTotal = 0;
  for (let age = CHILD_AGE_LIMIT; age < AGE_COUNT; age++) {
    for (let sex = 0; sex < 2; sex++) {
      const cohort = age * 2 + sex;
      const active = activePersons[cohort];
      if (active <= 0) continue;
      const sexKey = sexKeys[sex];
      const stateOffset = cohort * STATE_COUNT;
      const unemployed = active * Math.min(MAX_UNEMPLOYMENT_SHARE, unemploymentPropensity[cohort] * unemploymentScale);
      const employed = active - unemployed;
      const maternityShare = sex === 1 ? asfr[age] * labourInputs.maternityLeaveYears : 0;
      const absentShare = Math.min(MAX_ABSENCE_SHARE, Math.max(0, interpolateProfile(profiles.sick[sexKey], age)) + maternityShare);
      const absent = employed * absentShare;
      states[stateOffset + STATE.UNEMP] = unemployed;
      states[stateOffset + STATE.SICK_MAT] = absent;
      workingPersons[cohort] = employed - absent;
      partTimePropensity[cohort] = clamp(interpolateProfile(profiles.partTime[sexKey], age), 0, 1);
      workingTotal += workingPersons[cohort];
      partTimeRawTotal += workingPersons[cohort] * partTimePropensity[cohort];
    }
  }

  // Pass 3: part-time vs full-time (scaled to the aggregate target)
  const partTimeScale = partTimeRawTotal > 0 ? labourInputs.partTimeRate * workingTotal / partTimeRawTotal : 0;
  for (let cohort = 0; cohort < cohortCount; cohort++) {
    const working = workingPersons[cohort];
    if (working <= 0) continue;
    const stateOffset = cohort * STATE_COUNT;
    const partTime = working * Math.min(1, partTimePropensity[cohort] * partTimeScale);
    states[stateOffset + STATE.EMP_PART] = partTime;
    states[stateOffset + STATE.EMP_FULL] = working - partTime;
  }

  const totals = new Float64Array(STATE_COUNT);
  for (let cohort = 0; cohort < cohortCount; cohort++) {
    for (let state = 0; state < STATE_COUNT; state++) totals[state] += states[cohort * STATE_COUNT + state];
  }
  const payers = totals[STATE.EMP_FULL] + 0.5 * totals[STATE.EMP_PART];
  const recipients = totals[STATE.UNEMP] + totals[STATE.SICK_MAT] + totals[STATE.DISAB] + totals[STATE.RETIRED];
  const womenActivity25to45 = womenPopulation25to45 > 0 ? womenActive25to45 / womenPopulation25to45 : 0;
  return { states, totals, payers, recipients, womenActivity25to45 };
}

// ─── Age-structure indicators ───────────────────────────────────────────────

/**
 * Age-structure indicators of one population snapshot.
 * Mean age uses mid-year ages (x + 0.5; 101.5 for 100+); the median is interpolated within the age year.
 * Old-age dependency = 100 * (65+) / (20-64) (European Commission Ageing Report convention).
 * Inputs:  population ({ male, female }: Float64Array(101), thousands)
 * Output:  { total, male, female, children (0-19), working (20-64), seniors (65+),
 *            oldAgeDependency, meanAge, medianAge } (numbers)
 * Example: computeAgeIndicators(pop2024).medianAge
 */
export function computeAgeIndicators(population) {
  let total = 0, male = 0, female = 0, children = 0, working = 0, seniors = 0, weightedAge = 0;
  for (let age = 0; age < AGE_COUNT; age++) {
    const males = population.male[age];
    const females = population.female[age];
    const persons = males + females;
    male += males;
    female += females;
    total += persons;
    weightedAge += (age + (age === OPEN_AGE ? 1.5 : 0.5)) * persons;
    if (age < 20) children += persons;
    else if (age < 65) working += persons;
    else seniors += persons;
  }
  let medianAge = NaN;
  const half = total / 2;
  let cumulative = 0;
  for (let age = 0; age < AGE_COUNT; age++) {
    const persons = population.male[age] + population.female[age];
    if (persons > 0 && cumulative + persons >= half) {
      medianAge = age + (half - cumulative) / persons;
      break;
    }
    cumulative += persons;
  }
  return {
    total, male, female, children, working, seniors,
    oldAgeDependency: working > 0 ? 100 * seniors / working : NaN,
    meanAge: total > 0 ? weightedAge / total : NaN,
    medianAge
  };
}

// ─── Full simulation ────────────────────────────────────────────────────────

/**
 * Run the projection and the labour allocation for every year of the horizon.
 * Inputs:  startPopulation ({ male, female }: number[101], thousands on 1 January startYear)
 *          scenario ({ tfrTarget, migrationTarget (thousands), targetYear, e0MaleTarget, e0FemaleTarget,
 *                      retireAgeMale, retireAgeFemale, retireAgeLinkShare (0-1),
 *                      unemploymentRate (%), womenActivityChange (p.p.), partTimeRate (%),
 *                      disabilityMultiplier, studyShift (years) })
 *          calibration (object from data/calibration.json), startYear, endYear (number, years)
 * Output:  { years: number[], snapshots: { [year]: { male, female } }, states: { [year]: Float64Array },
 *            series: { [indicator]: number[] aligned with years } }
 * Example: runSimulation(anchors['2024'], scenario, calibration, 2024, 2100).series.oldAgeDependency
 */
export function runSimulation(startPopulation, scenario, calibration, startYear, endYear) {
  const baseYear = calibration.baseYear;
  const mortality = calibration.mortality;
  const leeCarterMale = prepareLeeCarter(mortality.male.qx, mortality.male.ageSensitivity);
  const leeCarterFemale = prepareLeeCarter(mortality.female.qx, mortality.female.ageSensitivity);
  const kappaTargetMale = solveKappaForLifeExpectancy(leeCarterMale, scenario.e0MaleTarget);
  const kappaTargetFemale = solveKappaForLifeExpectancy(leeCarterFemale, scenario.e0FemaleTarget);
  const labour = calibration.labour;
  const womenActivityShift = scenario.womenActivityChange / 100;

  const years = [];
  const snapshots = {};
  const states = {};
  const seriesKeys = [
    'total', 'male', 'female', 'children', 'working', 'seniors', 'oldAgeDependency', 'meanAge', 'medianAge',
    'births', 'deaths', 'netMigration', 'tfr', 'e0Male', 'e0Female', 'e65Male', 'e65Female',
    'retireAgeMale', 'retireAgeFemale', 'payers', 'recipients', 'recipientsPer100Payers', 'womenActivity25to45'
  ];
  const series = { stateTotals: [] };
  for (const key of seriesKeys) series[key] = [];

  let population = {
    male: Float64Array.from(startPopulation.male),
    female: Float64Array.from(startPopulation.female)
  };
  let e65UnisexBase = NaN;

  for (let year = startYear; year <= endYear; year++) {
    const mortalityProgress = clamp((year - baseYear) / (mortality.targetYear - baseYear), 0, 1);
    const lifeTableMale = buildLifeTable(qxFromKappa(leeCarterMale, kappaTargetMale * mortalityProgress));
    const lifeTableFemale = buildLifeTable(qxFromKappa(leeCarterFemale, kappaTargetFemale * mortalityProgress));
    const tfr = linearPath(calibration.fertility.tfrBase, scenario.tfrTarget, baseYear, scenario.targetYear, year);
    const asfr = buildAsfr(calibration.fertility.shape, tfr);
    const netMigrationTarget = linearPath(calibration.migration.netBase, scenario.migrationTarget, baseYear, scenario.targetYear, year);
    const migration = scaleMigration(calibration.migration, netMigrationTarget);

    const e65Unisex = 0.5 * (lifeTableMale.ex[65] + lifeTableFemale.ex[65]);
    if (year === startYear) e65UnisexBase = e65Unisex;
    const retireAgeShift = scenario.retireAgeLinkShare * (e65Unisex - e65UnisexBase);
    const retireAgeMale = clamp(scenario.retireAgeMale + retireAgeShift, RETIREMENT_AGE_BOUNDS[0], RETIREMENT_AGE_BOUNDS[1]);
    const retireAgeFemale = clamp(scenario.retireAgeFemale + retireAgeShift, RETIREMENT_AGE_BOUNDS[0], RETIREMENT_AGE_BOUNDS[1]);

    const labourResult = allocateLabourStates(population, {
      retireAge: [retireAgeMale, retireAgeFemale],
      retireAgeRef: [labour.retireAgeRef.male, labour.retireAgeRef.female],
      pivotAge: labour.pivotAge,
      unemploymentRate: scenario.unemploymentRate / 100,
      partTimeRate: scenario.partTimeRate / 100,
      womenActivityShift,
      disabilityMultiplier: scenario.disabilityMultiplier,
      studyShift: scenario.studyShift,
      maternityLeaveYears: labour.maternityLeaveYears
    }, labour.profiles, asfr);
    const ageIndicators = computeAgeIndicators(population);

    const step = projectOneYear(population, {
      male: survivalRatios(lifeTableMale),
      female: survivalRatios(lifeTableFemale)
    }, asfr, migration, calibration.sexRatioMaleShare);

    years.push(year);
    snapshots[year] = population;
    states[year] = labourResult.states;
    for (const key of ['total', 'male', 'female', 'children', 'working', 'seniors', 'oldAgeDependency', 'meanAge', 'medianAge']) {
      series[key].push(ageIndicators[key]);
    }
    series.births.push(step.births);
    series.deaths.push(step.deaths);
    series.netMigration.push(step.migrationApplied);
    series.tfr.push(tfr);
    series.e0Male.push(lifeTableMale.ex[0]);
    series.e0Female.push(lifeTableFemale.ex[0]);
    series.e65Male.push(lifeTableMale.ex[65]);
    series.e65Female.push(lifeTableFemale.ex[65]);
    series.retireAgeMale.push(retireAgeMale);
    series.retireAgeFemale.push(retireAgeFemale);
    series.payers.push(labourResult.payers);
    series.recipients.push(labourResult.recipients);
    series.recipientsPer100Payers.push(labourResult.payers > 0 ? 100 * labourResult.recipients / labourResult.payers : NaN);
    series.womenActivity25to45.push(100 * labourResult.womenActivity25to45);
    series.stateTotals.push(Array.from(labourResult.totals));

    population = step.next;
  }

  return { years, snapshots, states, series };
}
