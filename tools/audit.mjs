#!/usr/bin/env node
// tools/audit.mjs -- Numerical audit of the simulator (model.js + data/*.json + config.js sliders)
//
// Usage:  node tools/audit.mjs            (exit code 1 when a hard invariant fails)
// Part 1: hard invariants (accounting identities, exact targets, slider extremes, no NaN / negative values)
// Part 2: base-year values vs. reference statistics (informative; references marked "verify" are
//         approximate and must be checked against the official source before being relied on)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGE_COUNT, STATE, STATE_COUNT, runSimulation, buildLifeTable, computeMotherShares, allocateLabourStates, buildLabourInputs
} from '../model.js';
import { SLIDERS } from '../config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const END_YEAR = 2100;

// Reference statistics for the base year. verified=false: approximate (from memory), confirm with the source.
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
  { key: 'maternity', label: 'Ženy na materskej (tis.)', value: 27, tolerance: 0.25, source: 'Sociálna poisťovňa (poberatelia materského, aj otcovia)', verified: false },
  { key: 'parental', label: 'Rodičovská doma (model) vs. poberatelia RP spolu (tis.)', value: 120, tolerance: 0.25, source: 'ÚPSVaR (vrátane pracujúcich poberateľov)', verified: false },
  { key: 'sick', label: 'Osoby na PN (tis., priemerný denný stav)', value: 100, tolerance: 0.25, source: 'Sociálna poisťovňa', verified: false },
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
  results.push({ name, passed: Boolean(passed), detail });
}

/**
 * Structural checks of one simulation: finite and non-negative values, states summing to each cohort,
 * maternity and parental leave for women only, exact unemployment and part-time aggregates.
 * Inputs:  simulation (runSimulation output), scenario (model units)
 * Output:  { badValues, worstStateGap, menOnLeave, worstUnemploymentGap, worstPartTimeGap, badSeries }
 * Example: structuralChecks(runSimulation(...), scenario).badValues
 */
function structuralChecks(simulation, scenario) {
  const { years, snapshots, states, series } = simulation;
  let badValues = 0;
  let worstStateGap = 0;
  let menOnLeave = 0;
  for (const year of years) {
    const population = snapshots[year];
    const yearStates = states[year];
    for (let age = 0; age < AGE_COUNT; age++) {
      for (let sex = 0; sex < 2; sex++) {
        const persons = sex === 0 ? population.male[age] : population.female[age];
        if (!Number.isFinite(persons) || persons < 0) badValues++;
        const offset = (age * 2 + sex) * STATE_COUNT;
        let stateSum = 0;
        for (let state = 0; state < STATE_COUNT; state++) {
          const value = yearStates[offset + state];
          if (!Number.isFinite(value) || value < -1e-12) badValues++;
          stateSum += value;
        }
        worstStateGap = Math.max(worstStateGap, Math.abs(stateSum - persons));
        if (sex === 0) menOnLeave += Math.abs(yearStates[offset + STATE.MATERNITY]) + Math.abs(yearStates[offset + STATE.PARENTAL]);
      }
    }
  }
  let badSeries = 0;
  for (const [key, values] of Object.entries(series)) {
    if (key === 'stateTotals') continue;
    for (const value of values) if (!Number.isFinite(value)) badSeries++;
  }
  const unemploymentGaps = series.stateTotals.map(totals => {
    const active = totals[STATE.EMP_FULL] + totals[STATE.EMP_PART] + totals[STATE.SICK] + totals[STATE.MATERNITY] + totals[STATE.UNEMP];
    return Math.abs(100 * totals[STATE.UNEMP] / active - scenario.unemploymentRate);
  });
  const partTimeGaps = series.stateTotals.map(totals => Math.abs(100 * totals[STATE.EMP_PART] / (totals[STATE.EMP_FULL] + totals[STATE.EMP_PART]) - scenario.partTimeRate));
  return {
    badValues, worstStateGap, menOnLeave, badSeries,
    worstUnemploymentGap: Math.max(...unemploymentGaps),
    worstPartTimeGap: Math.max(...partTimeGaps)
  };
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
  const simulate = (overrides, endYear = END_YEAR, calibrationUsed = calibration) =>
    runSimulation(startPopulation, { ...scenario, ...overrides }, calibrationUsed, startYear, endYear);
  const simulation = simulate({});
  const { years, snapshots, series } = simulation;
  const results = [];

  // 1. Structure of the default run
  const base = structuralChecks(simulation, scenario);
  check(results, 'Žiadne NaN ani záporné hodnoty (populácia, stavy, rady)', base.badValues === 0 && base.badSeries === 0, `${base.badValues} stavov, ${base.badSeries} hodnôt radov`);
  check(results, 'Súčet 10 stavov = populácia kohorty', base.worstStateGap < 1e-9, `max odchýlka ${base.worstStateGap.toExponential(2)} tis.`);
  check(results, 'Materská a rodičovská len u žien', base.menOnLeave === 0, `${base.menOnLeave} tis. u mužov`);
  check(results, 'Agregátna miera nezamestnanosti = posuvník (každý rok)', base.worstUnemploymentGap < 1e-6, `max odchýlka ${base.worstUnemploymentGap.toExponential(2)} p. b.`);
  check(results, 'Podiel čiastočných úväzkov = posuvník (každý rok)', base.worstPartTimeGap < 1e-6, `max odchýlka ${base.worstPartTimeGap.toExponential(2)} p. b.`);

  // 2. Demography
  let worstBalance = 0;
  for (let index = 0; index < years.length - 1; index++) {
    const balance = series.total[index] + series.births[index] - series.deaths[index] + series.netMigration[index] - series.total[index + 1];
    worstBalance = Math.max(worstBalance, Math.abs(balance));
  }
  check(results, 'Bilancia P(t+1) = P(t) + B − D + M', worstBalance < 1e-8, `max odchýlka ${worstBalance.toExponential(2)} tis.`);
  const openAgeLater = snapshots[startYear + 5].male[100] + snapshots[startYear + 5].female[100];
  check(results, 'Otvorený interval 100+ neprázdny po 5 rokoch', openAgeLater > 0.05, `${openAgeLater.toFixed(3)} tis.`);
  const lastIndex = years.length - 1;
  check(results, 'e0 v základnom roku = kalibrácia', Math.abs(series.e0Male[0] - calibration.baseValues.e0Male) < 1e-3 && Math.abs(series.e0Female[0] - calibration.baseValues.e0Female) < 1e-3,
    `${series.e0Male[0].toFixed(3)} / ${series.e0Female[0].toFixed(3)}`);
  check(results, `e0 v roku ${END_YEAR} = cieľ scenára`, Math.abs(series.e0Male[lastIndex] - scenario.e0MaleTarget) < 0.01 && Math.abs(series.e0Female[lastIndex] - scenario.e0FemaleTarget) < 0.01,
    `${series.e0Male[lastIndex].toFixed(3)} / ${series.e0Female[lastIndex].toFixed(3)} vs ${scenario.e0MaleTarget} / ${scenario.e0FemaleTarget}`);

  // 3. Mothers of young children
  const motherShares = computeMotherShares(startPopulation, calibration.fertility.shape, calibration.labour.maternityLeaveYears);
  let mothers = 0;
  for (let age = 0; age < AGE_COUNT; age++) mothers += startPopulation.female[age] * (motherShares.newborn[age] + motherShares.toddler[age]);
  const children = [0, 1, 2].reduce((sum, age) => sum + startPopulation.male[age] + startPopulation.female[age], 0);
  check(results, 'Matky malých detí = deti vo veku 0–2 (ukotvenie)', Math.abs(mothers - children) < 1e-9, `${mothers.toFixed(3)} vs ${children.toFixed(3)} tis.`);
  const allocation = allocateLabourStates(startPopulation, buildLabourInputs(scenario, calibration.labour,
    [scenario.retireAgeMale, scenario.retireAgeFemale], simulation.womenActivityFit.shift, scenario.parentalHomeShare), calibration.labour.profiles, motherShares);
  check(results, 'Pridelené matky = deti 0–2, nič neorezané (predvolené)', Math.abs(allocation.mothersAllocated - children) < 1e-9 && Math.max(...series.mothersDropped) === 0,
    `pridelené ${allocation.mothersAllocated.toFixed(3)} tis., orezané max ${Math.max(...series.mothersDropped).toFixed(4)} tis.`);

  // 4. Defaults, base values and the women-activity level
  const offGrid = SLIDERS.filter(slider => {
    const value = calibration.defaults[slider.key] / slider.scale;
    const steps = (value - slider.min) / slider.step;
    return !Number.isFinite(value) || Math.abs(steps - Math.round(steps)) > 1e-6;
  }).map(slider => slider.key);
  check(results, 'Predvolené hodnoty ležia na krokoch posuvníkov', offGrid.length === 0, offGrid.join(', ') || 'všetky');
  const baseValues = calibration.baseValues;
  const relativeGap = (value, reference) => Math.abs(value - reference) / Math.max(1e-9, Math.abs(reference));
  const totalsGap = Math.max(...Object.entries(STATE).map(([key, index]) => relativeGap(series.stateTotals[0][index], baseValues.stateTotals[key])));
  const baseMatches = totalsGap < 1e-5 && relativeGap(series.recipientsPer100Payers[0], baseValues.recipientsPer100Payers) < 1e-5
    && relativeGap(series.economicOldAgeDependency[0], baseValues.economicOldAgeDependency) < 1e-5
    && relativeGap(series.economicDependency[0], baseValues.economicDependency) < 1e-5;
  check(results, 'Predvolený scenár reprodukuje baseValues', baseMatches, `max relatívna odchýlka stavov ${totalsGap.toExponential(2)}`);
  check(results, 'Predvolená úroveň aktivity žien sa v 2024 dosiahne presne', Math.abs(series.womenActivity25to45[0] - scenario.womenActivityLevel) < 1e-6,
    `${series.womenActivity25to45[0].toFixed(6)} vs ${scenario.womenActivityLevel}`);
  const levelGaps = [65, 72.5, 78, 82].map(level => Math.abs(simulate({ womenActivityLevel: level }, startYear).series.womenActivity25to45[0] - level));
  check(results, 'Ľubovoľná úroveň v rozsahu sa v 2024 dosiahne presne (65; 72,5; 78; 82 %)', Math.max(...levelGaps) < 1e-6, `max odchýlka ${Math.max(...levelGaps).toExponential(2)} p. b.`);

  // 5. Indicator identities
  let worstIdentity = 0;
  series.stateTotals.forEach((totals, index) => {
    const payers = series.payers[index];
    const nonPayers = totals[STATE.STUDENT] + totals[STATE.INACTIVE] + totals[STATE.UNEMP] + totals[STATE.SICK] + totals[STATE.MATERNITY]
      + totals[STATE.PARENTAL] + totals[STATE.DISAB] + totals[STATE.RETIRED] + 0.5 * totals[STATE.EMP_PART];
    worstIdentity = Math.max(worstIdentity,
      Math.abs(100 * nonPayers / payers - series.economicDependency[index]),
      Math.abs(100 * totals[STATE.RETIRED] / payers - series.economicOldAgeDependency[index]),
      Math.abs(payers - totals[STATE.EMP_FULL] - 0.5 * totals[STATE.EMP_PART]));
  });
  check(results, 'Zložkové identity indexov ekonomickej závislosti', worstIdentity < 1e-8, `max odchýlka ${worstIdentity.toExponential(2)}`);

  // 6. Slider extremes and a combined extreme
  const extremeFailures = [];
  const extremeRuns = [];
  for (const slider of SLIDERS) {
    for (const end of ['min', 'max']) extremeRuns.push({ label: `${slider.key}=${end}`, overrides: { [slider.key]: slider[end] * slider.scale } });
  }
  extremeRuns.push({
    label: 'kombinácia extrémov',
    overrides: { studyShift: 2, tfrTarget: 2.5, disabilityMultiplier: 2, parentalHomeShare: 1, unemploymentRate: 20, partTimeRate: 30, retireAgeMale: 58, retireAgeFemale: 70, migrationTarget: -20 }
  });
  for (const run of extremeRuns) {
    const runScenario = { ...scenario, ...run.overrides };
    const result = structuralChecks(simulate(run.overrides), runScenario);
    if (result.badValues || result.badSeries || result.worstStateGap > 1e-9 || result.menOnLeave || result.worstUnemploymentGap > 1e-6 || result.worstPartTimeGap > 1e-6) {
      extremeFailures.push(`${run.label} (NaN/záp. ${result.badValues + result.badSeries}, súčet ${result.worstStateGap.toExponential(1)}, U ${result.worstUnemploymentGap.toExponential(1)}, PT ${result.worstPartTimeGap.toExponential(1)})`);
    }
  }
  check(results, `Extrémy posuvníkov (${extremeRuns.length} behov): konečné hodnoty, súčty, presné agregáty`, extremeFailures.length === 0, extremeFailures.slice(0, 3).join('; ') || 'všetky v poriadku');
  const steepCalibration = JSON.parse(JSON.stringify(calibration));
  for (const sexKey of ['male', 'female']) {
    steepCalibration.labour.profiles.unemployment[sexKey] = steepCalibration.labour.profiles.unemployment[sexKey].map((value, age) => (age >= 15 && age < 20 ? 0.38 : age < 25 ? Math.max(value, 0.22) : value));
  }
  const steep = structuralChecks(simulate({ unemploymentRate: 20 }, END_YEAR, steepCalibration), { ...scenario, unemploymentRate: 20 });
  check(results, 'Presná nezamestnanosť aj pri strmom profile mladých (20 %, strop 0,95)', steep.worstUnemploymentGap < 1e-6, `max odchýlka ${steep.worstUnemploymentGap.toExponential(2)} p. b.`);

  // 7. Directions of slider effects
  const index2060 = years.indexOf(2060);
  const indexOf = year => years.indexOf(year);
  const higherRetirement = simulate({ retireAgeMale: scenario.retireAgeMale + 2, retireAgeFemale: scenario.retireAgeFemale + 2 }).series;
  check(results, 'Vyšší dôchodkový vek → menej poberateľov aj nižšia ekonomická závislosť starších (2060)',
    higherRetirement.recipientsPer100Payers[index2060] < series.recipientsPer100Payers[index2060] && higherRetirement.economicOldAgeDependency[index2060] < series.economicOldAgeDependency[index2060],
    `${higherRetirement.economicOldAgeDependency[index2060].toFixed(1)} vs ${series.economicOldAgeDependency[index2060].toFixed(1)}`);
  const higherFertility = simulate({ tfrTarget: scenario.tfrTarget + 0.3 }).series;
  const parentalSum = values => [2027, 2028, 2029, 2030].reduce((sum, year) => sum + values[indexOf(year)], 0);
  check(results, 'Vyššia plodnosť → viac rodičovskej o 1–3 roky neskôr (2027–2030), 2025 rovnako',
    parentalSum(higherFertility.parental) > parentalSum(series.parental) && Math.abs(higherFertility.parental[indexOf(2025)] - series.parental[indexOf(2025)]) < 1e-9,
    `${parentalSum(higherFertility.parental).toFixed(1)} vs ${parentalSum(series.parental).toFixed(1)} tis.`);
  check(results, 'Vyššia plodnosť → viac obyvateľov (2060)', higherFertility.total[index2060] > series.total[index2060],
    `${higherFertility.total[index2060].toFixed(0)} vs ${series.total[index2060].toFixed(0)}`);
  const fewerAtHome = simulate({ parentalHomeShare: 0.4 }).series;
  const moreAtHome = simulate({ parentalHomeShare: 1 }).series;
  check(results, 'Viac matiek doma → nižšia aktivita žien a viac poberateľov (2024)',
    moreAtHome.womenActivity25to45[0] < series.womenActivity25to45[0] && series.womenActivity25to45[0] < fewerAtHome.womenActivity25to45[0]
    && moreAtHome.recipientsPer100Payers[0] > series.recipientsPer100Payers[0] && series.recipientsPer100Payers[0] > fewerAtHome.recipientsPer100Payers[0],
    `aktivita ${fewerAtHome.womenActivity25to45[0].toFixed(1)} / ${series.womenActivity25to45[0].toFixed(1)} / ${moreAtHome.womenActivity25to45[0].toFixed(1)} %`);
  const linkedRetirement = simulate({ retireAgeLinkShare: 1 }).series;
  check(results, 'Naviazanie na e65 zvyšuje dôchodkový vek', linkedRetirement.retireAgeMale[lastIndex] > scenario.retireAgeMale,
    `${linkedRetirement.retireAgeMale[lastIndex].toFixed(2)} r. v ${END_YEAR}`);
  const longerStudy = simulate({ studyShift: 2 }).series;
  check(results, 'Dlhšie štúdium → viac študentov v základnom roku', longerStudy.stateTotals[0][STATE.STUDENT] > series.stateTotals[0][STATE.STUDENT],
    `${longerStudy.stateTotals[0][STATE.STUDENT].toFixed(0)} vs ${series.stateTotals[0][STATE.STUDENT].toFixed(0)}`);

  // Part 2: base-year values vs. references (LFS concept from the default run)
  const totals = series.stateTotals[0];
  const baseStates = simulation.states[startYear];
  const shares = calibration.labour.lfsActivityShares;
  let population15to64 = 0;
  let employed15to64 = 0;
  let lfsEmployed15to64 = 0;
  for (let age = 15; age <= 64; age++) {
    for (let sex = 0; sex < 2; sex++) {
      const offset = (age * 2 + sex) * STATE_COUNT;
      const cohort = baseStates.subarray(offset, offset + STATE_COUNT);
      const persons = cohort.reduce((sum, value) => sum + value, 0);
      const employed = cohort[STATE.EMP_FULL] + cohort[STATE.EMP_PART] + cohort[STATE.SICK] + cohort[STATE.MATERNITY];
      const retireAgeRef = sex === 0 ? calibration.labour.retireAgeRef.male : calibration.labour.retireAgeRef.female;
      population15to64 += persons;
      employed15to64 += employed;
      lfsEmployed15to64 += employed + shares.student * cohort[STATE.STUDENT] * 0.9 + shares.disabled * cohort[STATE.DISAB] * 0.95
        + (age >= retireAgeRef ? cohort[STATE.RETIRED] * 0.2 : 0);
    }
  }
  const actual = {
    population: series.total[0], births: series.births[0], deaths: series.deaths[0],
    e0Male: series.e0Male[0], e0Female: series.e0Female[0],
    employmentRateLfs: 100 * lfsEmployed15to64 / population15to64,
    unemployed: totals[STATE.UNEMP], disabled: totals[STATE.DISAB], retired: totals[STATE.RETIRED],
    maternity: totals[STATE.MATERNITY], parental: totals[STATE.PARENTAL], sick: totals[STATE.SICK],
    meanAge: series.meanAge[0]
  };

  console.log(`\nAUDIT — kalibrácia: ${calibration.meta.status} (schéma ${calibration.meta.schemaVersion}), základný rok ${startYear}, horizont ${END_YEAR}\n`);
  console.log('1) Tvrdé invarianty');
  for (const result of results) console.log(`  ${result.passed ? 'OK  ' : 'FAIL'} ${result.name} — ${result.detail}`);
  console.log('\n2) Základný rok vs. referencie (verify = hodnota z pamäti, overiť v zdroji)');
  for (const reference of REFERENCES) {
    const value = actual[reference.key];
    const gap = (value - reference.value) / reference.value;
    const flag = Math.abs(gap) <= reference.tolerance ? 'v tolerancii' : 'MIMO';
    console.log(`  ${reference.label.padEnd(56)} model ${value.toFixed(1).padStart(8)}  ref ${String(reference.value).padStart(7)}  ${(100 * gap).toFixed(1).padStart(6)} %  ${flag}${reference.verified ? '' : ' (verify)'}  [${reference.source}]`);
  }
  console.log(`\n  Zamestnaní 15–64 v koncepte modelu (bez pracujúcich dôchodcov/študentov/invalidných): ${(100 * employed15to64 / population15to64).toFixed(1)} %`);
  console.log(`  Aktivita žien 25–45 (VZPS): ${series.womenActivity25to45[0].toFixed(2)} %, maximum pri predvolených predpokladoch ${simulation.womenActivityFit.maximum.toFixed(2)} %`);
  console.log(`  Na 100 platiteľov: poberatelia ${series.recipientsPer100Payers[0].toFixed(1)}, starobní dôchodcovia ${series.economicOldAgeDependency[0].toFixed(1)}, neplatitelia ${series.economicDependency[0].toFixed(1)}; 65+/20–64 ${series.oldAgeDependency[0].toFixed(1)}; medián veku ${series.medianAge[0].toFixed(1)}`);
  const checkpoints = [2030, 2050, 2070, END_YEAR].map(year => years.indexOf(year));
  console.log('\n3) Vývoj (základný scenár)');
  console.log('  rok   populácia  pôrody  úmrtia   e0 M   e0 Ž  65+/20–64  pober./100  dôch./100  neplat./100  rodičovská');
  for (const index of [0, ...checkpoints]) {
    console.log(`  ${years[index]}  ${series.total[index].toFixed(0).padStart(8)}  ${series.births[index].toFixed(1).padStart(6)}  ${series.deaths[index].toFixed(1).padStart(6)}  ${series.e0Male[index].toFixed(1).padStart(5)}  ${series.e0Female[index].toFixed(1).padStart(5)}  ${series.oldAgeDependency[index].toFixed(1).padStart(9)}  ${series.recipientsPer100Payers[index].toFixed(1).padStart(10)}  ${series.economicOldAgeDependency[index].toFixed(1).padStart(9)}  ${series.economicDependency[index].toFixed(1).padStart(11)}  ${series.parental[index].toFixed(1).padStart(10)}`);
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
