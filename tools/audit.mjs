#!/usr/bin/env node
// tools/audit.mjs -- Numerical audit of the simulator (model.js + data/*.json)
//
// Usage:  node tools/audit.mjs            (exit code 1 when a hard invariant fails)
// Part 1: hard invariants (accounting identities, targets reached, no NaN / negative values)
// Part 2: base-year values vs. reference statistics (informative; references marked "verify" are
//         approximate and must be checked against the official source before being relied on)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGE_COUNT, STATE, STATE_COUNT, runSimulation, allocateLabourStates, buildAsfr, buildLifeTable
} from '../model.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const END_YEAR = 2100;

// Reference statistics for the base year. verified=false: approximate, confirm with the source.
const REFERENCES = [
  { key: 'population', label: 'Obyvateľstvo k 1. 1. (tis.)', value: 5424.7, tolerance: 0.01, source: 'ŠÚ SR / Eurostat demo_pjan', verified: false },
  { key: 'births', label: 'Živonarodení za rok (tis.)', value: 47, tolerance: 0.05, source: 'ŠÚ SR', verified: false },
  { key: 'deaths', label: 'Zomretí za rok (tis.)', value: 55, tolerance: 0.05, source: 'ŠÚ SR', verified: false },
  { key: 'e0Male', label: 'e0 muži', value: 74.0, tolerance: 0.01, source: 'Eurostat demo_mlexpec', verified: false },
  { key: 'e0Female', label: 'e0 ženy', value: 81.0, tolerance: 0.01, source: 'Eurostat demo_mlexpec', verified: false },
  { key: 'employmentRateLfs', label: 'Miera zamestnanosti 15–64 (%), koncept VZPS', value: 72, tolerance: 0.03, source: 'Eurostat lfsa_ergan', verified: false },
  { key: 'unemployed', label: 'Nezamestnaní (tis.)', value: 150, tolerance: 0.1, source: 'Eurostat lfsa_ugad / ŠÚ VZPS', verified: false },
  { key: 'disabled', label: 'Poberatelia invalidného dôchodku (tis.)', value: 230, tolerance: 0.05, source: 'Sociálna poisťovňa', verified: false },
  { key: 'retired', label: 'Poberatelia starobného a predčasného dôchodku (tis.)', value: 1100, tolerance: 0.05, source: 'Sociálna poisťovňa', verified: false },
  { key: 'meanAge', label: 'Priemerný vek', value: 42.0, tolerance: 0.02, source: 'ŠÚ SR', verified: false }
];

/**
 * Read and parse a JSON file of the repository.
 * Inputs:  relativePath (string, path from the repository root)
 * Output:  object (parsed JSON) or null when the file does not exist
 * Example: readJson('data/calibration.json').baseYear
 */
function readJson(relativePath) {
  const filePath = path.join(REPO_ROOT, relativePath);
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
}

/**
 * Collect the outcome of one check.
 * Inputs:  results (object[], accumulator), name (string), passed (boolean), detail (string)
 * Output:  none (appends to results)
 * Example: check(results, 'no NaN', true, '')
 */
function check(results, name, passed, detail) {
  results.push({ name, passed, detail });
}

/**
 * Run all audits and print a report.
 * Inputs:  none (reads data/calibration.json and data/anchors.json)
 * Output:  number (count of failed hard invariants)
 * Example: const failures = runAudit();
 */
export function runAudit() {
  const calibration = readJson('data/calibration.json');
  const anchors = readJson('data/anchors.json');
  const startYear = calibration.baseYear;
  const startPopulation = anchors[String(startYear)];
  const scenario = { ...calibration.defaults };
  const simulation = runSimulation(startPopulation, scenario, calibration, startYear, END_YEAR);
  const { years, snapshots, states, series } = simulation;
  const results = [];

  // 1. No NaN / negative values; state totals equal the population of every cohort
  let worstStateGap = 0;
  let badValues = 0;
  for (const year of years) {
    const population = snapshots[year];
    const yearStates = states[year];
    for (let age = 0; age < AGE_COUNT; age++) {
      for (let sex = 0; sex < 2; sex++) {
        const persons = sex === 0 ? population.male[age] : population.female[age];
        if (!Number.isFinite(persons) || persons < 0) badValues++;
        let stateSum = 0;
        for (let state = 0; state < STATE_COUNT; state++) {
          const value = yearStates[(age * 2 + sex) * STATE_COUNT + state];
          if (!Number.isFinite(value) || value < -1e-12) badValues++;
          stateSum += value;
        }
        worstStateGap = Math.max(worstStateGap, Math.abs(stateSum - persons));
      }
    }
  }
  check(results, 'Žiadne NaN ani záporné hodnoty (populácia aj stavy)', badValues === 0, `${badValues} chybných hodnôt`);
  check(results, 'Súčet 8 stavov = populácia kohorty', worstStateGap < 1e-9, `max odchýlka ${worstStateGap.toExponential(2)} tis.`);

  // 2. Demographic balance P(t+1) = P(t) + B - D + M
  let worstBalance = 0;
  for (let index = 0; index < years.length - 1; index++) {
    const balance = series.total[index] + series.births[index] - series.deaths[index] + series.netMigration[index] - series.total[index + 1];
    worstBalance = Math.max(worstBalance, Math.abs(balance));
  }
  check(results, 'Bilancia P(t+1) = P(t) + B − D + M', worstBalance < 1e-8, `max odchýlka ${worstBalance.toExponential(2)} tis.`);

  // 3. Open interval 100+ keeps survivors
  const openAgeLater = snapshots[startYear + 5].male[100] + snapshots[startYear + 5].female[100];
  check(results, 'Otvorený interval 100+ neprázdny po 5 rokoch', openAgeLater > 0.05, `${openAgeLater.toFixed(3)} tis.`);

  // 4. Base year reproduces calibration; targets reached
  const lastIndex = years.length - 1;
  check(results, 'e0 v základnom roku = kalibrácia', Math.abs(series.e0Male[0] - calibration.baseValues.e0Male) < 1e-3 && Math.abs(series.e0Female[0] - calibration.baseValues.e0Female) < 1e-3,
    `${series.e0Male[0].toFixed(3)} / ${series.e0Female[0].toFixed(3)}`);
  check(results, `e0 v roku ${END_YEAR} = cieľ scenára`, Math.abs(series.e0Male[lastIndex] - scenario.e0MaleTarget) < 0.01 && Math.abs(series.e0Female[lastIndex] - scenario.e0FemaleTarget) < 0.01,
    `${series.e0Male[lastIndex].toFixed(3)} / ${series.e0Female[lastIndex].toFixed(3)} vs ${scenario.e0MaleTarget} / ${scenario.e0FemaleTarget}`);
  const unemploymentShares = series.stateTotals.map(totals => {
    const active = totals[STATE.EMP_FULL] + totals[STATE.EMP_PART] + totals[STATE.SICK_MAT] + totals[STATE.UNEMP];
    return 100 * totals[STATE.UNEMP] / active;
  });
  const worstUnemploymentGap = Math.max(...unemploymentShares.map(value => Math.abs(value - scenario.unemploymentRate)));
  check(results, 'Agregátna miera nezamestnanosti = posuvník (každý rok)', worstUnemploymentGap < 1e-6, `max odchýlka ${worstUnemploymentGap.toExponential(2)} p. b.`);
  const partTimeShares = series.stateTotals.map(totals => 100 * totals[STATE.EMP_PART] / (totals[STATE.EMP_FULL] + totals[STATE.EMP_PART]));
  const worstPartTimeGap = Math.max(...partTimeShares.map(value => Math.abs(value - scenario.partTimeRate)));
  check(results, 'Podiel čiastočných úväzkov = posuvník (každý rok)', worstPartTimeGap < 1e-6, `max odchýlka ${worstPartTimeGap.toExponential(2)} p. b.`);

  // 5. Comparative statics: directions of slider effects in 2060
  const index2060 = years.indexOf(2060);
  const variant = overrides => runSimulation(startPopulation, { ...scenario, ...overrides }, calibration, startYear, END_YEAR).series;
  const higherRetirement = variant({ retireAgeMale: scenario.retireAgeMale + 2, retireAgeFemale: scenario.retireAgeFemale + 2 });
  check(results, 'Vyšší dôchodkový vek → menej poberateľov na 100 platiteľov (2060)',
    higherRetirement.recipientsPer100Payers[index2060] < series.recipientsPer100Payers[index2060],
    `${higherRetirement.recipientsPer100Payers[index2060].toFixed(1)} vs ${series.recipientsPer100Payers[index2060].toFixed(1)}`);
  const higherFertility = variant({ tfrTarget: scenario.tfrTarget + 0.3 });
  check(results, 'Vyššia plodnosť → viac obyvateľov (2060)', higherFertility.total[index2060] > series.total[index2060],
    `${higherFertility.total[index2060].toFixed(0)} vs ${series.total[index2060].toFixed(0)}`);
  const linkedRetirement = variant({ retireAgeLinkShare: 1 });
  check(results, 'Naviazanie na e65 zvyšuje dôchodkový vek', linkedRetirement.retireAgeMale[lastIndex] > scenario.retireAgeMale,
    `${linkedRetirement.retireAgeMale[lastIndex].toFixed(2)} r. v ${END_YEAR}`);
  const longerStudy = variant({ studyShift: 2 });
  check(results, 'Dlhšie štúdium → viac študentov v základnom roku', longerStudy.stateTotals[0][STATE.STUDENT] > series.stateTotals[0][STATE.STUDENT],
    `${longerStudy.stateTotals[0][STATE.STUDENT].toFixed(0)} vs ${series.stateTotals[0][STATE.STUDENT].toFixed(0)}`);

  // Part 2: base-year values vs. references
  const totals = series.stateTotals[0];
  const population = snapshots[startYear];
  const asfr = buildAsfr(calibration.fertility.shape, calibration.fertility.tfrBase);
  const labourBase = allocateLabourStates(population, {
    retireAge: [scenario.retireAgeMale, scenario.retireAgeFemale],
    retireAgeRef: [calibration.labour.retireAgeRef.male, calibration.labour.retireAgeRef.female],
    pivotAge: calibration.labour.pivotAge,
    unemploymentRate: scenario.unemploymentRate / 100,
    partTimeRate: scenario.partTimeRate / 100,
    womenActivityShift: 0,
    disabilityMultiplier: 1,
    studyShift: 0,
    maternityLeaveYears: calibration.labour.maternityLeaveYears
  }, calibration.labour.profiles, asfr);
  let population15to64 = 0;
  let employed15to64 = 0;
  let lfsEmployed15to64 = 0;
  const assumptions = calibration.meta.assumptions;
  for (let age = 15; age <= 64; age++) {
    for (let sex = 0; sex < 2; sex++) {
      const offset = (age * 2 + sex) * STATE_COUNT;
      const cohortStates = labourBase.states.subarray(offset, offset + STATE_COUNT);
      const persons = cohortStates.reduce((sum, value) => sum + value, 0);
      const employed = cohortStates[STATE.EMP_FULL] + cohortStates[STATE.EMP_PART] + cohortStates[STATE.SICK_MAT];
      population15to64 += persons;
      employed15to64 += employed;
      const retireAgeRef = sex === 0 ? calibration.labour.retireAgeRef.male : calibration.labour.retireAgeRef.female;
      const workingPensioners = age >= retireAgeRef ? cohortStates[STATE.RETIRED] * 0.2 : 0;
      lfsEmployed15to64 += employed + assumptions.studentActivityShare * (age >= 15 ? cohortStates[STATE.STUDENT] : 0) * 0.9
        + assumptions.disabledActivityShare * cohortStates[STATE.DISAB] * 0.95 + workingPensioners;
    }
  }
  const actual = {
    population: series.total[0],
    births: series.births[0],
    deaths: series.deaths[0],
    e0Male: series.e0Male[0],
    e0Female: series.e0Female[0],
    employmentRateLfs: 100 * lfsEmployed15to64 / population15to64,
    unemployed: totals[STATE.UNEMP],
    disabled: totals[STATE.DISAB],
    retired: totals[STATE.RETIRED],
    meanAge: series.meanAge[0]
  };

  console.log(`\nAUDIT — kalibrácia: ${calibration.meta.status}, základný rok ${startYear}, horizont ${END_YEAR}\n`);
  console.log('1) Tvrdé invarianty');
  for (const result of results) console.log(`  ${result.passed ? 'OK  ' : 'FAIL'} ${result.name} — ${result.detail}`);
  console.log('\n2) Základný rok vs. referencie (verify = hodnota z pamäti, overiť v zdroji)');
  for (const reference of REFERENCES) {
    const value = actual[reference.key];
    const gap = (value - reference.value) / reference.value;
    const flag = Math.abs(gap) <= reference.tolerance ? 'v tolerancii' : 'MIMO';
    console.log(`  ${reference.label.padEnd(52)} model ${value.toFixed(1).padStart(8)}  ref ${String(reference.value).padStart(7)}  ${(100 * gap).toFixed(1).padStart(6)} %  ${flag}${reference.verified ? '' : ' (verify)'}  [${reference.source}]`);
  }
  console.log(`\n  Zamestnaní 15–64 v koncepte modelu (bez pracujúcich dôchodcov/študentov/invalidných): ${(100 * employed15to64 / population15to64).toFixed(1)} %`);
  console.log(`  Poberatelia na 100 platiteľov: ${series.recipientsPer100Payers[0].toFixed(1)}; starobná závislosť 65+/20–64: ${series.oldAgeDependency[0].toFixed(1)}; medián veku ${series.medianAge[0].toFixed(1)}`);
  const checkpoints = [2030, 2050, 2070, END_YEAR].map(year => years.indexOf(year));
  console.log('\n3) Vývoj (základný scenár)');
  console.log('  rok   populácia  pôrody  úmrtia   e0 M   e0 Ž   65+/20–64  pober./100 plat.');
  for (const index of [0, ...checkpoints]) {
    console.log(`  ${years[index]}  ${series.total[index].toFixed(0).padStart(8)}  ${series.births[index].toFixed(1).padStart(6)}  ${series.deaths[index].toFixed(1).padStart(6)}  ${series.e0Male[index].toFixed(1).padStart(5)}  ${series.e0Female[index].toFixed(1).padStart(5)}  ${series.oldAgeDependency[index].toFixed(1).padStart(9)}  ${series.recipientsPer100Payers[index].toFixed(1).padStart(10)}`);
  }
  const benchmark = readJson('data/benchmark.json');
  if (benchmark) {
    console.log('\n4) Benchmark EUROPOP2023 (populácia, tis.)');
    for (const year of [2030, 2050, 2070, END_YEAR]) {
      if (!benchmark.male[year]) continue;
      const europop = benchmark.male[year].reduce((sum, value) => sum + value, 0) + benchmark.female[year].reduce((sum, value) => sum + value, 0);
      const model = series.total[years.indexOf(year)];
      console.log(`  ${year}: model ${model.toFixed(0)}, EUROPOP ${europop.toFixed(0)}, rozdiel ${(100 * (model - europop) / europop).toFixed(1)} %`);
    }
  } else {
    console.log('\n4) Benchmark EUROPOP2023: chýba data/benchmark.json');
  }
  const lifeTable = buildLifeTable(calibration.mortality.male.qx);
  console.log(`\n  Kontrola life table: e0 muži ${lifeTable.ex[0].toFixed(2)}, e65 muži ${lifeTable.ex[65].toFixed(2)}`);

  const failures = results.filter(result => !result.passed).length;
  console.log(`\n${failures ? failures + ' invariant(y) zlyhali.' : 'Všetky tvrdé invarianty prešli.'}`);
  return failures;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = runAudit() ? 1 : 0;
}
