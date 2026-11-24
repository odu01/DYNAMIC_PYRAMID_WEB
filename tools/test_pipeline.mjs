#!/usr/bin/env node
// tools/test_pipeline.mjs -- Round-trip test of tools/build_data.mjs on synthetic Eurostat-style CSV files
//
// Usage:  node tools/test_pipeline.mjs        (exit code 1 on failure; temporary files go to os.tmpdir())
// The synthetic files are generated from the current provisional calibration, written in the same
// formats the real downloads use (SDMX-CSV with extra dimensions, open age groups, 5-year LFS groups),
// fed to buildCalibration() and compared with the values they were generated from.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGE_COUNT, runSimulation, hazardFromProbability, probabilityFromHazard } from '../model.js';
import { buildCalibration, ASSUMPTIONS } from './build_data.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDMX_HEADER = 'DATAFLOW,LAST UPDATE,freq,unit,sex,age,geo,TIME_PERIOD,OBS_VALUE,OBS_FLAG';

/**
 * Eurostat single-age code for an age (open interval code for the last one).
 * Inputs:  age (integer), openAge (integer), openCode (string, e.g. 'Y_OPEN' or 'Y_GE85')
 * Output:  string
 * Example: ageCode(0, 100, 'Y_OPEN')  // -> 'Y_LT1'
 */
function ageCode(age, openAge, openCode) {
  if (age === openAge) return openCode;
  return age === 0 ? 'Y_LT1' : 'Y' + age;
}

/**
 * Write rows to a CSV file in the temporary raw directory.
 * Inputs:  directory (string), fileName (string), header (string), lines (string[])
 * Output:  none
 * Example: writeCsv(rawDir, 'demo_pjan.csv', SDMX_HEADER, lines)
 */
function writeCsv(directory, fileName, header, lines) {
  fs.writeFileSync(path.join(directory, fileName), '﻿' + header + '\n' + lines.join('\n') + '\n');
}

/**
 * Population-weighted mean of an age profile over an age group.
 * Inputs:  profile (number[101]), weights (number[101]), start, end (integer ages)
 * Output:  number
 * Example: groupMean(activity.male, population.male, 25, 29)
 */
function groupMean(profile, weights, start, end) {
  let weighted = 0, total = 0;
  for (let age = start; age <= end; age++) { weighted += profile[age] * weights[age]; total += weights[age]; }
  return total > 0 ? weighted / total : 0;
}

/**
 * Generate the synthetic raw files, run the pipeline and compare outputs with the inputs.
 * Inputs:  none (reads data/calibration.json and data/anchors.json)
 * Output:  number (count of failed checks)
 * Example: const failures = runPipelineTest();
 */
export function runPipelineTest() {
  const calibration = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'calibration.json'), 'utf8'));
  const anchors = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'anchors.json'), 'utf8'));
  const baseYear = calibration.baseYear;
  const population = anchors[String(baseYear)];
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rrz-pipeline-'));
  const rawDirectory = path.join(workDirectory, 'raw');
  const outDirectory = path.join(workDirectory, 'out');
  fs.mkdirSync(rawDirectory);
  fs.mkdirSync(outDirectory);
  const sexes = [['M', 'male'], ['F', 'female']];

  // demo_pjan: two years, totals and a T sex row that must be ignored
  const populationLines = [];
  for (const year of [baseYear - 1, baseYear]) {
    for (const [code, sexKey] of sexes) {
      for (let age = 0; age < AGE_COUNT; age++) {
        const persons = Math.round(population[sexKey][age] * 1000 * (year === baseYear ? 1 : 1.01));
        populationLines.push(`ESTAT:DEMO_PJAN(1.0),01/01/25,A,NR,${code},${ageCode(age, 100, 'Y_OPEN')},SK,${year},${persons},`);
      }
      populationLines.push(`ESTAT:DEMO_PJAN(1.0),01/01/25,A,NR,${code},TOTAL,SK,${year},1,`);
    }
    populationLines.push(`ESTAT:DEMO_PJAN(1.0),01/01/25,A,NR,T,Y10,SK,${year},1,`);
  }
  writeCsv(rawDirectory, 'demo_pjan.csv', SDMX_HEADER, populationLines);

  // demo_mlifetable: history with a known Lee-Carter structure; ages up to 84 + Y_GE85
  const trueSensitivity = calibration.mortality.male.ageSensitivity;
  const lifeTableLines = [];
  for (let year = baseYear - 25; year <= baseYear; year++) {
    const kappa = 3 * (baseYear - year);
    for (const [code, sexKey] of sexes) {
      for (let age = 0; age <= 85; age++) {
        const baseHazard = hazardFromProbability(calibration.mortality[sexKey].qx[age]);
        const probability = probabilityFromHazard(baseHazard * Math.exp(trueSensitivity[age] * kappa));
        const value = age === 85 ? 1 : probability;
        lifeTableLines.push(`ESTAT:DEMO_MLIFETABLE(1.0),01/01/25,A,PROBDEATH,${code},${ageCode(age, 85, 'Y_GE85')},SK,${year},${value.toFixed(6)},`);
      }
      lifeTableLines.push(`ESTAT:DEMO_MLIFETABLE(1.0),01/01/25,A,LIFEXP,${code},Y_GE85,SK,${year},5.1,`);
    }
  }
  writeCsv(rawDirectory, 'demo_mlifetable.csv', 'DATAFLOW,LAST UPDATE,freq,indic_de,sex,age,geo,TIME_PERIOD,OBS_VALUE,OBS_FLAG', lifeTableLines);

  // demo_fasfr: TFR 1.45 with the provisional shape (+ open groups that must be ignored)
  const fertilityLines = [];
  for (let age = 15; age <= 49; age++) {
    fertilityLines.push(`ESTAT:DEMO_FASFR(1.0),01/01/25,A,NR,Y${age},SK,${baseYear},${(1.45 * calibration.fertility.shape[age]).toFixed(6)},`);
  }
  fertilityLines.push(`ESTAT:DEMO_FASFR(1.0),01/01/25,A,NR,Y_LT15,SK,${baseYear},0.0004,`);
  fertilityLines.push(`ESTAT:DEMO_FASFR(1.0),01/01/25,A,NR,Y_GE50,SK,${baseYear},0.0001,`);
  writeCsv(rawDirectory, 'demo_fasfr.csv', 'DATAFLOW,LAST UPDATE,freq,unit,age,geo,TIME_PERIOD,OBS_VALUE,OBS_FLAG', fertilityLines);

  // migration: citizen and agedef dimensions that must be filtered
  const migrationLines = scale => {
    const lines = [];
    for (const citizen of ['TOTAL', 'FOR']) for (const agedef of ['COMPLET', 'REACH']) for (const [code] of sexes) {
      for (let age = 0; age < AGE_COUNT; age++) {
        const persons = Math.round(scale * 1000 * Math.exp(-0.5 * ((age - 28) / 11) ** 2) / 10);
        lines.push(`ESTAT:MIGR(1.0),01/01/25,A,${citizen},${agedef},NR,${code},${ageCode(age, 100, 'Y_GE100')},SK,${baseYear},${persons},`);
      }
    }
    return lines;
  };
  const migrationHeader = 'DATAFLOW,LAST UPDATE,freq,citizen,agedef,unit,sex,age,geo,TIME_PERIOD,OBS_VALUE,OBS_FLAG';
  writeCsv(rawDirectory, 'migr_imm1ctz.csv', migrationHeader, migrationLines(0.6));
  writeCsv(rawDirectory, 'migr_emi2.csv', migrationHeader, migrationLines(0.3));

  // pensions: 5-year groups from the provisional shares
  const profiles = calibration.labour.profiles;
  const pensionLines = [];
  for (const [code, sexKey] of sexes) {
    for (let start = 15; start <= 95; start += 5) {
      let retired = 0, disabled = 0;
      for (let age = start; age <= Math.min(start + 4, 100); age++) {
        retired += profiles.retired[sexKey][age] * population[sexKey][age] * 1000;
        disabled += profiles.disabled[sexKey][age] * population[sexKey][age] * 1000;
      }
      pensionLines.push(`${start}-${start + 4},${code},${Math.round(retired)},0,${Math.round(disabled)}`);
    }
    pensionLines.push(`100+,${code},${Math.round(profiles.retired[sexKey][100] * population[sexKey][100] * 1000)},0,0`);
  }
  writeCsv(rawDirectory, 'sp_poberatelia.csv', 'age,sex,old_age,early,disability', pensionLines);

  // LFS: marginal activity implied by the provisional conditional activity, unemployment, part-time
  const marginalActivity = {};
  for (const [, sexKey] of sexes) {
    marginalActivity[sexKey] = Array.from({ length: AGE_COUNT }, (_, age) => {
      if (age < 15) return 0;
      const s = profiles.student[sexKey][age], d = profiles.disabled[sexKey][age], r = profiles.retired[sexKey][age];
      const conditional = profiles.activity[sexKey][age];
      if (age >= calibration.labour.retireAgeRef[sexKey]) return conditional;
      return conditional * (1 - s - d - r) + ASSUMPTIONS.studentActivityShare * s + ASSUMPTIONS.disabledActivityShare * d;
    });
  }
  const lfsLines = profileOf => {
    const lines = [];
    for (const [code, sexKey] of sexes) {
      for (let start = 15; start <= 70; start += 5) {
        const value = 100 * groupMean(profileOf(sexKey), population[sexKey], start, start + 4);
        lines.push(`ESTAT:LFSA(1.0),01/01/25,A,TOTAL,PC,${code},Y${start}-${start + 4},SK,${baseYear},${value.toFixed(2)},`);
      }
      lines.push(`ESTAT:LFSA(1.0),01/01/25,A,TOTAL,PC,${code},Y15-64,SK,${baseYear},55.5,`);
    }
    lines.push(`ESTAT:LFSA(1.0),01/01/25,A,TOTAL,PC,T,Y15-74,SK,${baseYear},5.6,`);
    lines.push(`ESTAT:LFSA(1.0),01/01/25,A,TOTAL,PC,T,Y15-64,SK,${baseYear},9.9,`);
    return lines;
  };
  const lfsHeader = 'DATAFLOW,LAST UPDATE,freq,citizen,unit,sex,age,geo,TIME_PERIOD,OBS_VALUE,OBS_FLAG';
  writeCsv(rawDirectory, 'lfsa_argan.csv', lfsHeader, lfsLines(sexKey => marginalActivity[sexKey]));
  writeCsv(rawDirectory, 'lfsa_urgan.csv', lfsHeader, lfsLines(sexKey => profiles.unemployment[sexKey]));
  writeCsv(rawDirectory, 'lfsa_eppgan.csv', lfsHeader, lfsLines(sexKey => profiles.partTime[sexKey]));

  // EUROPOP2023 benchmark: our own projection, two projection variants (BSL must be chosen)
  const simulation = runSimulation(population, calibration.defaults, calibration, baseYear, 2100);
  const benchmarkLines = [];
  for (const projection of ['BSL', 'LFRT']) {
    for (const year of simulation.years) {
      for (const [code, sexKey] of sexes) {
        for (let age = 0; age < AGE_COUNT; age++) {
          const persons = Math.round(simulation.snapshots[year][sexKey][age] * 1000 * (projection === 'BSL' ? 1 : 0.9));
          benchmarkLines.push(`ESTAT:PROJ_23NP(1.0),01/01/25,A,${projection},PER,${code},${ageCode(age, 100, 'Y_GE100')},SK,${year},${persons},`);
        }
      }
    }
  }
  writeCsv(rawDirectory, 'proj_23np.csv', 'DATAFLOW,LAST UPDATE,freq,projection,unit,sex,age,geo,TIME_PERIOD,OBS_VALUE,OBS_FLAG', benchmarkLines);
  writeCsv(rawDirectory, 'parameters.csv', 'key,value,source', [
    'e0_male_target,85,EUROPOP2023 (test)', 'e0_female_target,89,EUROPOP2023 (test)',
    'retire_age_ref_male,63,zakon (test)', 'retire_age_ref_female,63,zakon (test)'
  ]);

  const built = buildCalibration({ rawDir: rawDirectory, outDir: outDirectory, write: true, log: () => {} });
  const result = built.calibration;
  const failures = [];
  const expect = (name, passed, detail) => {
    console.log(`  ${passed ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!passed) failures.push(name);
  };

  const sourceTotal = ['male', 'female'].reduce((sum, sexKey) => sum + population[sexKey].reduce((inner, value) => inner + Math.round(value * 1000) / 1000, 0), 0);
  const builtTotal = ['male', 'female'].reduce((sum, sexKey) => sum + built.anchors[baseYear][sexKey].reduce((inner, value) => inner + value, 0), 0);
  expect('Populácia: zvolený základný rok a súčet', result.baseYear === baseYear && Math.abs(builtTotal - sourceTotal) < 0.01, `${builtTotal.toFixed(2)} vs ${sourceTotal.toFixed(2)}`);
  const qxGap = Math.max(...Array.from({ length: 85 }, (_, age) => Math.abs(result.mortality.male.qx[age] - calibration.mortality.male.qx[age])));
  expect('Úmrtnosť: q_x do 84 rokov reprodukované', qxGap < 2e-6, `max odchýlka ${qxGap.toExponential(2)}`);
  const q100 = result.mortality.male.qx[100];
  expect('Úmrtnosť: extrapolácia 85+ a otvorený interval', q100 > 0.1 && q100 < 0.95 && result.mortality.male.qx[95] > result.mortality.male.qx[85], `q85 ${result.mortality.male.qx[85].toFixed(3)}, q95 ${result.mortality.male.qx[95].toFixed(3)}, q100 ${q100.toFixed(3)}`);
  const fitted = result.mortality.male.ageSensitivity.slice(0, 85);
  const truth = trueSensitivity.slice(0, 85);
  const fittedSum = fitted.reduce((sum, value) => sum + value, 0);
  const truthSum = truth.reduce((sum, value) => sum + value, 0);
  const sensitivityGap = Math.max(...fitted.map((value, age) => Math.abs(value / fittedSum - truth[age] / truthSum)));
  expect('Lee-Carter: b_x odhadnuté zo syntetickej histórie', sensitivityGap < 1e-4 && result.meta.components.mortalityImprovement.status === 'official', `max odchýlka ${sensitivityGap.toExponential(2)}`);
  expect('Plodnosť: TFR a profil', Math.abs(result.fertility.tfrBase - 1.45) < 1e-4, `TFR ${result.fertility.tfrBase.toFixed(4)}`);
  expect('Migrácia: filtrovanie citizen/agedef a saldo', Math.abs(result.migration.netBase - (result.migration.emigrationBase)) < 0.05 * result.migration.emigrationBase && result.migration.emigrationBase > 0,
    `saldo ${result.migration.netBase.toFixed(2)}, emigrácia ${result.migration.emigrationBase.toFixed(2)} tis.`);
  const retiredGap = groupMean(result.labour.profiles.retired.male, population.male, 65, 69) - groupMean(profiles.retired.male, population.male, 65, 69);
  expect('Dôchodcovia: 5-ročné skupiny → podiely', Math.abs(retiredGap) < 0.002, `odchýlka ${retiredGap.toFixed(4)}`);
  let activityError = 0, activityCount = 0;
  for (let age = 20; age <= 60; age++) {
    activityError += Math.abs(result.labour.profiles.activity.female[age] - profiles.activity.female[age]);
    activityCount++;
  }
  expect('Aktivita: VZPS → podmienená aktivita (round-trip, 5-ročné skupiny)', activityError / activityCount < 0.03, `priemerná odchýlka ${(activityError / activityCount).toFixed(4)}`);
  expect('Nezamestnanosť a čiastočné úväzky: agregát Y15-74 (T)', result.defaults.unemploymentRate === 5.6, `${result.defaults.unemploymentRate} %`);
  expect('Parametre: cieľové e0 z parameters.csv', result.defaults.e0MaleTarget === 85 && result.defaults.e0FemaleTarget === 89, `${result.defaults.e0MaleTarget} / ${result.defaults.e0FemaleTarget}`);
  expect('Benchmark: variant BSL, roky 2024–2100', built.benchmark && built.benchmark.years.length === simulation.years.length
    && Math.abs(built.benchmark.male[2050].reduce((sum, value) => sum + value, 0) - simulation.snapshots[2050].male.reduce((sum, value) => sum + value, 0)) < 0.5,
    built.benchmark ? `${built.benchmark.years.length} rokov` : 'chýba');
  expect('Stav kalibrácie = official (všetky jadrové zložky)', result.meta.status === 'official', result.meta.status);
  const rerun = runSimulation(built.anchors[baseYear], result.defaults, result, baseYear, 2100);
  expect('Simulácia na novej kalibrácii beží bez NaN', rerun.series.total.every(Number.isFinite) && rerun.series.recipientsPer100Payers.every(Number.isFinite),
    `populácia 2100: ${rerun.series.total.at(-1).toFixed(0)} tis.`);
  for (const fileName of ['calibration.json', 'anchors.json', 'benchmark.json']) {
    const content = fs.readFileSync(path.join(outDirectory, fileName), 'utf8');
    let parsed = true;
    try { JSON.parse(content); } catch { parsed = false; }
    expect(`Výstup ${fileName} je platný JSON`, parsed, `${(content.length / 1024).toFixed(0)} kB`);
  }

  fs.rmSync(workDirectory, { recursive: true, force: true });
  console.log(failures.length ? `\n${failures.length} test(y) zlyhali.` : '\nVšetky testy pipeline prešli.');
  return failures.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = runPipelineTest() ? 1 : 0;
}
