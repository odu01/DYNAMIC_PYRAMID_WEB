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
// Labour market: conditional waterfall over 10 mutually exclusive states (see allocateLabourStates);
//   mothers of children under 3 are anchored on the children aged 0-2 in the population (computeMotherShares).

export const AGE_COUNT = 101;
export const OPEN_AGE = 100;
export const STATE_COUNT = 10;
export const STATE = Object.freeze({
  EMP_FULL: 0, EMP_PART: 1, STUDENT: 2, INACTIVE: 3, UNEMP: 4,
  SICK: 5, MATERNITY: 6, PARENTAL: 7, DISAB: 8, RETIRED: 9
});
export const STATE_KEYS = Object.freeze([
  'EMP_FULL', 'EMP_PART', 'STUDENT', 'INACTIVE', 'UNEMP', 'SICK', 'MATERNITY', 'PARENTAL', 'DISAB', 'RETIRED'
]);
export const CHILD_AGE_LIMIT = 15;
export const WOMEN_ACTIVITY_AGES = Object.freeze([25, 45]);

const INFANT_DEATH_TIMING = 0.1;   // a_0: mean fraction of the first year lived by infants who die
const MAX_PROBABILITY = 0.999999;
const MAX_UNEMPLOYMENT_SHARE = 0.95;
const MAX_SICK_SHARE = 0.6;
const MAX_ACTIVITY_SHARE = 0.995;
const MAX_MOTHER_SHARE = 0.9;      // technical bound: mothers of children under 3 <= 90 % of the available pool
const RETIREMENT_AGE_BOUNDS = [55, 75];
const DEFAULT_PARENTAL_HOME_SHARE = 0.8;
const DEFAULT_LFS_ACTIVITY_SHARES = Object.freeze({ student: 0.10, disabled: 0.30 });

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
 * Return a value when it is a finite number, otherwise a fallback.
 * Inputs:  value (any), fallback (number)
 * Output:  number
 * Example: finiteOr(undefined, 0.8)  // -> 0.8
 */
function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Argument at which a non-decreasing function reaches a target (bisection). When the target lies outside
 * [valueAt(lower), valueAt(upper)] the nearer bound is returned (saturation).
 * Inputs:  valueAt (function(number) -> number, non-decreasing), target (number),
 *          lower, upper (number, bracket), iterations (integer, default 100)
 * Output:  number (argument)
 * Example: bisectIncreasing(x => x * x, 2, 0, 2)  // -> 1.41421...
 */
function bisectIncreasing(valueAt, target, lower, upper, iterations = 100) {
  if (valueAt(upper) <= target) return upper;
  if (valueAt(lower) >= target) return lower;
  let low = lower;
  let high = upper;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const middle = 0.5 * (low + high);
    if (valueAt(middle) < target) low = middle;
    else high = middle;
  }
  return 0.5 * (low + high);
}

/**
 * Upper bracket for a scale lambda applied as min(cap, propensity * lambda): beyond it every cohort with a
 * positive propensity is at the cap, so the aggregate no longer changes.
 * Inputs:  propensities (Float64Array, per cohort), weights (Float64Array, per cohort), cap (number)
 * Output:  number (0 when no cohort has both a positive weight and a positive propensity)
 * Example: saturationScale(unemploymentPropensity, activeBase, 0.95)
 */
function saturationScale(propensities, weights, cap) {
  let smallest = Infinity;
  for (let index = 0; index < propensities.length; index++) {
    if (weights[index] > 0 && propensities[index] > 0) smallest = Math.min(smallest, propensities[index]);
  }
  return Number.isFinite(smallest) ? cap / smallest : 0;
}

/**
 * Shares of women by single age who are mothers of a child under 34 weeks ("newborn") and of a child aged
 * 34 weeks to 3 years ("toddler"), anchored on the children aged 0-2 in the population. Children of age c
 * are assigned to mothers by the fertility age pattern at the mother's age at birth:
 *   g_o(x) = phi(x - o) / sum_y F_y phi(y - o),
 *   newborn(x) = tau C_0 g_{tau/2}(x),
 *   toddler(x) = (1 - tau) C_0 g_{(1+tau)/2}(x) + C_1 g_{1.5}(x) + C_2 g_{2.5}(x),
 * so that sum_x F_x newborn(x) = tau C_0 and sum_x F_x (newborn + toddler)(x) = C_0 + C_1 + C_2.
 * Inputs:  population ({ male, female }: Float64Array(101), thousands on 1 January)
 *          fertilityShape (number[101], age pattern of fertility, any positive scale)
 *          maternityLeaveYears (number, tau = 34/52)
 * Output:  { newborn: Float64Array(101), toddler: Float64Array(101) } (shares of women of each age)
 * Example: computeMotherShares(pop2024, calibration.fertility.shape, 34 / 52).toddler[30]
 */
export function computeMotherShares(population, fertilityShape, maternityLeaveYears) {
  const newborn = new Float64Array(AGE_COUNT);
  const toddler = new Float64Array(AGE_COUNT);
  const children = [0, 1, 2].map(age => population.male[age] + population.female[age]);
  const shapeAt = age => (age < 0 || age > OPEN_AGE ? 0 : Math.max(0, interpolateProfile(fertilityShape, age)));
  const kernel = offset => {
    const weights = new Float64Array(AGE_COUNT);
    let denominator = 0;
    for (let age = 0; age < AGE_COUNT; age++) {
      weights[age] = shapeAt(age - offset);
      denominator += population.female[age] * weights[age];
    }
    if (!(denominator > 0)) return new Float64Array(AGE_COUNT);
    for (let age = 0; age < AGE_COUNT; age++) weights[age] /= denominator;
    return weights;
  };
  const tau = clamp(finiteOr(maternityLeaveYears, 34 / 52), 0, 1);
  const kernelNewborn = kernel(tau / 2);
  const kernelAfterMaternity = kernel((1 + tau) / 2);
  const kernelAgeOne = kernel(1.5);
  const kernelAgeTwo = kernel(2.5);
  for (let age = 0; age < AGE_COUNT; age++) {
    newborn[age] = tau * children[0] * kernelNewborn[age];
    toddler[age] = (1 - tau) * children[0] * kernelAfterMaternity[age] + children[1] * kernelAgeOne[age] + children[2] * kernelAgeTwo[age];
  }
  return { newborn, toddler };
}

/**
 * Labour inputs of allocateLabourStates from slider settings in model units.
 * Inputs:  settings ({ unemploymentRate (%), partTimeRate (%), disabilityMultiplier, studyShift }),
 *          labour (calibration.labour), retireAges ([male, female] years), womenActivityShift (share),
 *          parentalHomeShare (0-1)
 * Output:  object (labourInputs)
 * Example: buildLabourInputs(scenario, calibration.labour, [63, 63], 0, 0.8)
 */
export function buildLabourInputs(settings, labour, retireAges, womenActivityShift, parentalHomeShare) {
  return {
    retireAge: retireAges,
    retireAgeRef: [labour.retireAgeRef.male, labour.retireAgeRef.female],
    pivotAge: labour.pivotAge,
    unemploymentRate: finiteOr(settings.unemploymentRate, 0) / 100,
    partTimeRate: finiteOr(settings.partTimeRate, 0) / 100,
    womenActivityShift: finiteOr(womenActivityShift, 0),
    disabilityMultiplier: finiteOr(settings.disabilityMultiplier, 1),
    studyShift: finiteOr(settings.studyShift, 0),
    parentalHomeShare: clamp(finiteOr(parentalHomeShare, DEFAULT_PARENTAL_HOME_SHARE), 0, 1),
    lfsActivityShares: labour.lfsActivityShares || DEFAULT_LFS_ACTIVITY_SHARES
  };
}

/**
 * Allocate every age-sex cohort N to 10 mutually exclusive labour states (conditional waterfall):
 *   age < 15 -> STUDENT (dependent children). Otherwise, with x' = effectiveLabourAge:
 *   RETIRED R = N r(x');  DISAB D = min(N - R, N delta d(x'));  STUDENT S = (N - R - D) s(x - studyShift)
 *   Q = N - R - D - S.  Women only: Y_N = N newborn(x), Y_T = N toddler(x), scaled down if above 0.9 Q;
 *   H = theta Y_T (at home -> PARENTAL), K = (1 - theta) Y_T (working mothers -> employed).
 *   Q~ = Q - Y_T, nu = Y_N / Q~;  A = Q~ clamp(a(x') + shift [women 25-45], 0, 0.995);  I0 = Q~ - A
 *   U0 = A min(0.95, u(x) lambda_U);  E0 = A - U0
 *   INACTIVE = (1 - nu) I0;  UNEMP = (1 - nu) U0;  MATERNITY = nu E0;  PARENTAL = H + nu (I0 + U0)
 *   SICK = (E0 - MATERNITY + K) min(0.6, p(x));  W = E0 - MATERNITY + K - SICK
 *   EMP_PART = W min(1, pi(x) lambda_P);  EMP_FULL = W - EMP_PART
 *   lambda_U and lambda_P are found by bisection so that UNEMP / (EMP + SICK + MATERNITY + UNEMP) and
 *   EMP_PART / (EMP_FULL + EMP_PART) equal the targets exactly, also when the caps bind.
 * Inputs:  population ({ male, female }: Float64Array(101), thousands)
 *          labourInputs (output of buildLabourInputs)
 *          profiles ({ retired, disabled, student, activity, unemployment, partTime, sick }: { male, female } number[101])
 *          motherShares ({ newborn, toddler }: Float64Array(101), output of computeMotherShares; null = no mothers)
 * Output:  { states: Float64Array(101*2*10) indexed [(age*2 + sex)*10 + state], totals: Float64Array(10),
 *            payers, recipients, womenActivity25to45 (share, LFS concept), mothersAllocated, mothersDropped,
 *            unemploymentScale, partTimeScale }
 * Example: allocateLabourStates(pop2024, labourInputs, calibration.labour.profiles, motherShares).totals
 */
export function allocateLabourStates(population, labourInputs, profiles, motherShares) {
  const cohortCount = AGE_COUNT * 2;
  const states = new Float64Array(cohortCount * STATE_COUNT);
  const activeBase = new Float64Array(cohortCount);
  const inactiveBase = new Float64Array(cohortCount);
  const newbornShare = new Float64Array(cohortCount);
  const workingMothers = new Float64Array(cohortCount);
  const unemploymentPropensity = new Float64Array(cohortCount);
  const sickPropensity = new Float64Array(cohortCount);
  const partTimePropensity = new Float64Array(cohortCount);
  const workingPersons = new Float64Array(cohortCount);
  const sexKeys = ['male', 'female'];
  const homeShare = clamp(finiteOr(labourInputs.parentalHomeShare, DEFAULT_PARENTAL_HOME_SHARE), 0, 1);
  const lfsShares = labourInputs.lfsActivityShares || DEFAULT_LFS_ACTIVITY_SHARES;
  const womenActivityShift = finiteOr(labourInputs.womenActivityShift, 0);
  let mothersAllocated = 0;
  let mothersDropped = 0;

  // Pass 1: pensions, students, mothers of young children, activity
  for (let age = 0; age < AGE_COUNT; age++) {
    for (let sex = 0; sex < 2; sex++) {
      const sexKey = sexKeys[sex];
      const cohort = age * 2 + sex;
      const stateOffset = cohort * STATE_COUNT;
      const persons = Math.max(0, population[sexKey][age]);
      if (!(persons > 0)) continue;
      if (age < CHILD_AGE_LIMIT) {
        states[stateOffset + STATE.STUDENT] = persons;
        continue;
      }
      const labourAge = effectiveLabourAge(age, labourInputs.retireAge[sex], labourInputs.retireAgeRef[sex], labourInputs.pivotAge);
      const retired = persons * clamp(interpolateProfile(profiles.retired[sexKey], labourAge), 0, 1);
      const disabledShare = clamp(interpolateProfile(profiles.disabled[sexKey], labourAge) * labourInputs.disabilityMultiplier, 0, 1);
      const disabled = Math.max(0, Math.min(persons - retired, persons * disabledShare));
      const notPensioner = Math.max(0, persons - retired - disabled);
      const students = notPensioner * clamp(interpolateProfile(profiles.student[sexKey], age - labourInputs.studyShift), 0, 1);
      const pool = Math.max(0, notPensioner - students);

      let newbornMothers = 0;
      let toddlerMothers = 0;
      if (sex === 1 && motherShares) {
        const wantedNewborn = persons * Math.max(0, motherShares.newborn[age]);
        const wantedToddler = persons * Math.max(0, motherShares.toddler[age]);
        const wanted = wantedNewborn + wantedToddler;
        if (wanted > 0) {
          const factor = pool > 0 ? Math.min(1, MAX_MOTHER_SHARE * pool / wanted) : 0;
          newbornMothers = wantedNewborn * factor;
          toddlerMothers = wantedToddler * factor;
          mothersAllocated += wanted * factor;
          mothersDropped += wanted * (1 - factor);
        }
      }
      const atHome = homeShare * toddlerMothers;
      const remaining = pool - toddlerMothers;
      const nu = remaining > 0 ? Math.min(1, newbornMothers / remaining) : 0;

      let activityShare = interpolateProfile(profiles.activity[sexKey], labourAge);
      if (sex === 1 && age >= WOMEN_ACTIVITY_AGES[0] && age <= WOMEN_ACTIVITY_AGES[1]) activityShare += womenActivityShift;
      const active = remaining * clamp(activityShare, 0, MAX_ACTIVITY_SHARE);

      states[stateOffset + STATE.RETIRED] = retired;
      states[stateOffset + STATE.DISAB] = disabled;
      states[stateOffset + STATE.STUDENT] = students;
      states[stateOffset + STATE.PARENTAL] = atHome;
      activeBase[cohort] = active;
      inactiveBase[cohort] = remaining - active;
      newbornShare[cohort] = nu;
      workingMothers[cohort] = toddlerMothers - atHome;
      unemploymentPropensity[cohort] = clamp(interpolateProfile(profiles.unemployment[sexKey], age), 0, 1);
      sickPropensity[cohort] = clamp(interpolateProfile(profiles.sick[sexKey], age), 0, MAX_SICK_SHARE);
      partTimePropensity[cohort] = clamp(interpolateProfile(profiles.partTime[sexKey], age), 0, 1);
    }
  }

  // Unemployment scale: aggregate UNEMP / LFS-active equals the target (bisection handles the 0.95 cap)
  const unemploymentTarget = clamp(finiteOr(labourInputs.unemploymentRate, 0), 0, MAX_UNEMPLOYMENT_SHARE);
  const unemploymentRateAt = scale => {
    let unemployed = 0;
    let active = 0;
    for (let cohort = 0; cohort < cohortCount; cohort++) {
      const base = activeBase[cohort];
      if (!(base > 0) && !(workingMothers[cohort] > 0)) continue;
      const raw = base * Math.min(MAX_UNEMPLOYMENT_SHARE, unemploymentPropensity[cohort] * scale);
      unemployed += (1 - newbornShare[cohort]) * raw;
      active += base + workingMothers[cohort] - newbornShare[cohort] * raw;
    }
    return active > 0 ? unemployed / active : 0;
  };
  const unemploymentScale = bisectIncreasing(unemploymentRateAt, unemploymentTarget, 0,
    saturationScale(unemploymentPropensity, activeBase, MAX_UNEMPLOYMENT_SHARE));

  // Pass 2: unemployment, maternity, parental leave of non-employed new mothers, sick leave
  for (let cohort = 0; cohort < cohortCount; cohort++) {
    const base = activeBase[cohort];
    const inactive = inactiveBase[cohort];
    const working = workingMothers[cohort];
    if (!(base > 0) && !(inactive > 0) && !(working > 0)) continue;
    const stateOffset = cohort * STATE_COUNT;
    const nu = newbornShare[cohort];
    const unemployedRaw = base * Math.min(MAX_UNEMPLOYMENT_SHARE, unemploymentPropensity[cohort] * unemploymentScale);
    const employedRaw = base - unemployedRaw;
    const maternity = nu * employedRaw;
    states[stateOffset + STATE.INACTIVE] = (1 - nu) * inactive;
    states[stateOffset + STATE.UNEMP] = (1 - nu) * unemployedRaw;
    states[stateOffset + STATE.MATERNITY] = maternity;
    states[stateOffset + STATE.PARENTAL] += nu * (inactive + unemployedRaw);
    const employedAtWork = employedRaw - maternity + working;
    const sick = employedAtWork * sickPropensity[cohort];
    states[stateOffset + STATE.SICK] = sick;
    workingPersons[cohort] = employedAtWork - sick;
  }

  // Part-time scale: EMP_PART / (EMP_FULL + EMP_PART) equals the target (bisection handles the cap at 1)
  let workingTotal = 0;
  for (let cohort = 0; cohort < cohortCount; cohort++) workingTotal += workingPersons[cohort];
  const partTimeTarget = clamp(finiteOr(labourInputs.partTimeRate, 0), 0, 1);
  const partTimeShareAt = scale => {
    if (!(workingTotal > 0)) return 0;
    let partTime = 0;
    for (let cohort = 0; cohort < cohortCount; cohort++) {
      if (workingPersons[cohort] > 0) partTime += workingPersons[cohort] * Math.min(1, partTimePropensity[cohort] * scale);
    }
    return partTime / workingTotal;
  };
  const partTimeScale = bisectIncreasing(partTimeShareAt, partTimeTarget, 0, saturationScale(partTimePropensity, workingPersons, 1));

  // Pass 3: part-time vs full-time
  for (let cohort = 0; cohort < cohortCount; cohort++) {
    const working = workingPersons[cohort];
    if (!(working > 0)) continue;
    const stateOffset = cohort * STATE_COUNT;
    const partTime = working * Math.min(1, partTimePropensity[cohort] * partTimeScale);
    states[stateOffset + STATE.EMP_PART] = partTime;
    states[stateOffset + STATE.EMP_FULL] = working - partTime;
  }

  const totals = new Float64Array(STATE_COUNT);
  for (let cohort = 0; cohort < cohortCount; cohort++) {
    for (let state = 0; state < STATE_COUNT; state++) totals[state] += states[cohort * STATE_COUNT + state];
  }

  // Activity of women 25-45 in the LFS concept: employed (incl. sick and maternity leave) + unemployed,
  // plus the assumed active shares of students and disability pensioners; parental leave is inactive.
  let womenActive = 0;
  let womenPopulation = 0;
  for (let age = WOMEN_ACTIVITY_AGES[0]; age <= WOMEN_ACTIVITY_AGES[1]; age++) {
    const offset = (age * 2 + 1) * STATE_COUNT;
    womenPopulation += Math.max(0, population.female[age]);
    womenActive += states[offset + STATE.EMP_FULL] + states[offset + STATE.EMP_PART] + states[offset + STATE.SICK]
      + states[offset + STATE.MATERNITY] + states[offset + STATE.UNEMP]
      + lfsShares.student * states[offset + STATE.STUDENT] + lfsShares.disabled * states[offset + STATE.DISAB];
  }

  const payers = totals[STATE.EMP_FULL] + 0.5 * totals[STATE.EMP_PART];
  const recipients = totals[STATE.UNEMP] + totals[STATE.SICK] + totals[STATE.MATERNITY] + totals[STATE.PARENTAL]
    + totals[STATE.DISAB] + totals[STATE.RETIRED];
  return {
    states, totals, payers, recipients,
    womenActivity25to45: womenPopulation > 0 ? womenActive / womenPopulation : 0,
    mothersAllocated, mothersDropped, unemploymentScale, partTimeScale
  };
}

/**
 * Additive shift of the conditional activity of women 25-45 at which their LFS activity rate equals a target
 * (bisection on [-1, 1]; the rate is non-decreasing in the shift). Used once per simulation on the base-year
 * population with the default values of all other sliders.
 * Inputs:  population ({ male, female }: Float64Array(101)), labourInputs (output of buildLabourInputs),
 *          profiles (calibration.labour.profiles), motherShares (output of computeMotherShares),
 *          targetShare (number, 0-1; NaN -> shift 0)
 * Output:  { shift, achieved, minimum, maximum (shares 0-1), attainable (boolean) }
 * Example: solveWomenActivityShift(pop2024, defaultInputs, profiles, motherShares, 0.82).shift
 */
export function solveWomenActivityShift(population, labourInputs, profiles, motherShares, targetShare) {
  const rateAt = shift => allocateLabourStates(population, { ...labourInputs, womenActivityShift: shift }, profiles, motherShares).womenActivity25to45;
  const minimum = rateAt(-1);
  const maximum = rateAt(1);
  if (!Number.isFinite(targetShare)) {
    return { shift: 0, achieved: rateAt(0), minimum, maximum, attainable: false };
  }
  const shift = bisectIncreasing(rateAt, targetShare, -1, 1, 60);
  return {
    shift,
    achieved: rateAt(shift),
    minimum,
    maximum,
    attainable: targetShare >= minimum - 1e-9 && targetShare <= maximum + 1e-9
  };
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
 * The women-activity shift is solved once, on the base-year population with the DEFAULT values of all other
 * sliders (calibration.defaults), so that the LFS activity rate of women 25-45 equals scenario.womenActivityLevel;
 * the shift is then kept for all years (fertility and the other sliders move the actual rate).
 * Inputs:  startPopulation ({ male, female }: number[101], thousands on 1 January startYear)
 *          scenario ({ tfrTarget, migrationTarget (thousands), targetYear, e0MaleTarget, e0FemaleTarget,
 *                      retireAgeMale, retireAgeFemale, retireAgeLinkShare (0-1), unemploymentRate (%),
 *                      womenActivityLevel (%), parentalHomeShare (0-1), partTimeRate (%),
 *                      disabilityMultiplier, studyShift (years) })
 *          calibration (object from data/calibration.json), startYear, endYear (number, years)
 * Output:  { years: number[], snapshots: { [year]: { male, female } }, states: { [year]: Float64Array(2020) },
 *            series: { [indicator]: number[] aligned with years },
 *            womenActivityFit: { target, achieved, minimum, maximum (%), shift, attainable } }
 * Example: runSimulation(anchors['2024'], scenario, calibration, 2024, 2100).series.economicDependency
 */
export function runSimulation(startPopulation, scenario, calibration, startYear, endYear) {
  const baseYear = calibration.baseYear;
  const mortality = calibration.mortality;
  const leeCarterMale = prepareLeeCarter(mortality.male.qx, mortality.male.ageSensitivity);
  const leeCarterFemale = prepareLeeCarter(mortality.female.qx, mortality.female.ageSensitivity);
  const kappaTargetMale = solveKappaForLifeExpectancy(leeCarterMale, scenario.e0MaleTarget);
  const kappaTargetFemale = solveKappaForLifeExpectancy(leeCarterFemale, scenario.e0FemaleTarget);
  const labour = calibration.labour;
  const defaults = calibration.defaults || {};
  const fertilityShape = calibration.fertility.shape;
  const parentalHomeShare = clamp(finiteOr(scenario.parentalHomeShare, finiteOr(defaults.parentalHomeShare, DEFAULT_PARENTAL_HOME_SHARE)), 0, 1);

  let population = {
    male: Float64Array.from(startPopulation.male),
    female: Float64Array.from(startPopulation.female)
  };

  // Women-activity level: shift solved once at the base year under the default values of the other sliders
  const defaultInputs = buildLabourInputs(defaults, labour, [
    finiteOr(defaults.retireAgeMale, labour.retireAgeRef.male),
    finiteOr(defaults.retireAgeFemale, labour.retireAgeRef.female)
  ], 0, finiteOr(defaults.parentalHomeShare, DEFAULT_PARENTAL_HOME_SHARE));
  const baseMotherShares = computeMotherShares(population, fertilityShape, labour.maternityLeaveYears);
  const targetShare = Number.isFinite(scenario.womenActivityLevel) ? scenario.womenActivityLevel / 100 : NaN;
  const fit = solveWomenActivityShift(population, defaultInputs, labour.profiles, baseMotherShares, targetShare);
  const womenActivityFit = {
    target: 100 * targetShare,
    achieved: 100 * fit.achieved,
    minimum: 100 * fit.minimum,
    maximum: 100 * fit.maximum,
    shift: fit.shift,
    attainable: fit.attainable
  };

  const years = [];
  const snapshots = {};
  const states = {};
  const seriesKeys = [
    'total', 'male', 'female', 'children', 'working', 'seniors', 'oldAgeDependency', 'meanAge', 'medianAge',
    'births', 'deaths', 'netMigration', 'tfr', 'e0Male', 'e0Female', 'e65Male', 'e65Female',
    'retireAgeMale', 'retireAgeFemale', 'payers', 'recipients', 'recipientsPer100Payers',
    'economicOldAgeDependency', 'economicDependency', 'womenActivity25to45', 'maternity', 'parental', 'mothersDropped'
  ];
  const series = { stateTotals: [] };
  for (const key of seriesKeys) series[key] = [];
  let e65UnisexBase = NaN;

  for (let year = startYear; year <= endYear; year++) {
    const mortalityProgress = clamp((year - baseYear) / (mortality.targetYear - baseYear), 0, 1);
    const lifeTableMale = buildLifeTable(qxFromKappa(leeCarterMale, kappaTargetMale * mortalityProgress));
    const lifeTableFemale = buildLifeTable(qxFromKappa(leeCarterFemale, kappaTargetFemale * mortalityProgress));
    const tfr = linearPath(calibration.fertility.tfrBase, scenario.tfrTarget, baseYear, scenario.targetYear, year);
    const asfr = buildAsfr(fertilityShape, tfr);
    const netMigrationTarget = linearPath(calibration.migration.netBase, scenario.migrationTarget, baseYear, scenario.targetYear, year);
    const migration = scaleMigration(calibration.migration, netMigrationTarget);

    const e65Unisex = 0.5 * (lifeTableMale.ex[65] + lifeTableFemale.ex[65]);
    if (year === startYear) e65UnisexBase = e65Unisex;
    const retireAgeShift = scenario.retireAgeLinkShare * (e65Unisex - e65UnisexBase);
    const retireAgeMale = clamp(scenario.retireAgeMale + retireAgeShift, RETIREMENT_AGE_BOUNDS[0], RETIREMENT_AGE_BOUNDS[1]);
    const retireAgeFemale = clamp(scenario.retireAgeFemale + retireAgeShift, RETIREMENT_AGE_BOUNDS[0], RETIREMENT_AGE_BOUNDS[1]);

    const motherShares = year === startYear ? baseMotherShares : computeMotherShares(population, fertilityShape, labour.maternityLeaveYears);
    const labourResult = allocateLabourStates(population,
      buildLabourInputs(scenario, labour, [retireAgeMale, retireAgeFemale], fit.shift, parentalHomeShare),
      labour.profiles, motherShares);
    const ageIndicators = computeAgeIndicators(population);

    const step = projectOneYear(population, {
      male: survivalRatios(lifeTableMale),
      female: survivalRatios(lifeTableFemale)
    }, asfr, migration, calibration.sexRatioMaleShare);

    const payers = labourResult.payers;
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
    series.payers.push(payers);
    series.recipients.push(labourResult.recipients);
    series.recipientsPer100Payers.push(payers > 0 ? 100 * labourResult.recipients / payers : NaN);
    series.economicOldAgeDependency.push(payers > 0 ? 100 * labourResult.totals[STATE.RETIRED] / payers : NaN);
    series.economicDependency.push(payers > 0 ? 100 * (ageIndicators.total - payers) / payers : NaN);
    series.womenActivity25to45.push(100 * labourResult.womenActivity25to45);
    series.maternity.push(labourResult.totals[STATE.MATERNITY]);
    series.parental.push(labourResult.totals[STATE.PARENTAL]);
    series.mothersDropped.push(labourResult.mothersDropped);
    series.stateTotals.push(Array.from(labourResult.totals));

    population = step.next;
  }

  return { years, snapshots, states, series, womenActivityFit };
}
