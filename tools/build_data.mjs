#!/usr/bin/env node
// tools/build_data.mjs -- Build the simulator's calibration inputs from CSV files
//
// Usage:   node tools/build_data.mjs [--raw <dir>] [--out <dir>]          (defaults: data/raw, data)
// Inputs:  CSV files described in data/raw/README.md (Eurostat SDMX-CSV exports + small tidy CSV files)
// Outputs: <out>/calibration.json (always), <out>/anchors.json (when demo_pjan.csv is present),
//          <out>/benchmark.json (when proj_23np.csv is present)
// A component whose CSV is missing falls back to a PROVISIONAL parametric profile. The status and the
// source of every component are recorded in calibration.meta.components and shown in the page.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AGE_COUNT, OPEN_AGE, STATE, STATE_COUNT, STATE_KEYS, buildLifeTable, allocateLabourStates, computeMotherShares,
  buildLabourInputs, solveWomenActivityShift, runSimulation, interpolateProfile,
  hazardFromProbability, probabilityFromHazard, clamp
} from '../model.js';
import { SLIDERS } from '../config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_YEAR = 2024;
const MORTALITY_TARGET_YEAR = 2100;
const DEFAULT_TARGET_YEAR = 2050;
const PIVOT_AGE = 50;
const CALIBRATION_SCHEMA_VERSION = 2;
const SEX_KEYS = ['male', 'female'];

// Modelling assumptions (documented in metodika.html; change here, then rebuild)
export const ASSUMPTIONS = Object.freeze({
  studentActivityShare: 0.10,          // share of full-time students counted as active in the LFS
  disabledActivityShare: 0.30,         // share of disability pensioners counted as active in the LFS
  leeCarterWindowYears: 25,            // history used to estimate b_x
  leeCarterExcludedYears: [2020, 2021, 2022],   // COVID-19 years left out of the b_x estimate
  sensitivityTaper: { startAge: 85, endAge: 100, endFactor: 0.25 },
  maternityLeaveWeeks: 34,             // materska (zakon c. 461/2003 Z. z.), standard case
  sexRatioMaleShare: 0.512,            // ~105 boys per 100 girls
  parentalLeaveLfsStatus: 'neaktívni (predpoklad; zaradenie vo VZPS overiť s ŠÚ SR)'
});

// Provisional values used only when the corresponding CSV is missing (NOT official data)
export const PROVISIONAL = Object.freeze({
  tfrBase: 1.5,
  netMigrationBase: 1,
  e0MaleTarget: 84,
  e0FemaleTarget: 88.5,
  retireAgeRef: 63,
  unemploymentRate: 5.3,
  partTimeRate: 3.5,
  parentalHomeShare: 0.8
});

// ─── Generic helpers ────────────────────────────────────────────────────────

/**
 * New array of AGE_COUNT values produced by a function of age.
 * Inputs:  valueAtAge (function(age:number) -> number)
 * Output:  number[] (101 values)
 * Example: ageArray(age => age < 15 ? 1 : 0)
 */
function ageArray(valueAtAge) {
  return Array.from({ length: AGE_COUNT }, (_, age) => valueAtAge(age));
}

/**
 * Round to a number of significant digits (keeps JSON files small and diffs readable).
 * Inputs:  value (number, scalar), digits (integer, default 6)
 * Output:  number (scalar)
 * Example: roundSignificant(0.0123456789, 4)  // -> 0.01235
 */
function roundSignificant(value, digits = 6) {
  if (!Number.isFinite(value) || value === 0) return value;
  return Number(value.toPrecision(digits));
}

/**
 * Normalise a { male, female } pair of non-negative profiles so that both together sum to 1.
 * Inputs:  profile ({ male, female }: number[101])
 * Output:  { male, female } (number[101]); zeros when the sum is not positive
 * Example: normaliseSexProfile({ male: imm.male, female: imm.female })
 */
function normaliseSexProfile(profile) {
  let total = 0;
  for (const sexKey of SEX_KEYS) for (const value of profile[sexKey]) total += Math.max(0, value);
  const scale = total > 0 ? 1 / total : 0;
  return {
    male: profile.male.map(value => Math.max(0, value) * scale),
    female: profile.female.map(value => Math.max(0, value) * scale)
  };
}

/**
 * Serialise JSON with objects indented and arrays of numbers kept on one line.
 * Inputs:  value (any JSON value), indent (string, current indentation)
 * Output:  string
 * Example: formatJson({ a: [1, 2] })  // '{\n  "a": [1, 2]\n}'
 */
export function formatJson(value, indent = '') {
  if (Array.isArray(value)) {
    if (value.every(item => item === null || typeof item !== 'object')) {
      return '[' + value.map(item => JSON.stringify(typeof item === 'number' ? roundSignificant(item) : item)).join(', ') + ']';
    }
    const inner = indent + '  ';
    return '[\n' + value.map(item => inner + formatJson(item, inner)).join(',\n') + '\n' + indent + ']';
  }
  if (value && typeof value === 'object') {
    const inner = indent + '  ';
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (!entries.length) return '{}';
    return '{\n' + entries.map(([key, item]) => inner + JSON.stringify(key) + ': ' + formatJson(item, inner)).join(',\n') + '\n' + indent + '}';
  }
  return JSON.stringify(typeof value === 'number' ? roundSignificant(value) : value);
}

// ─── CSV parsing ────────────────────────────────────────────────────────────

/**
 * Parse delimited text (comma, semicolon or tab; RFC 4180 quoting) into row objects keyed by
 * lower-case header names.
 * Inputs:  text (string, file contents)
 * Output:  object[] (one per data row; values are trimmed strings)
 * Example: parseDelimited('age,sex,share\n20,M,0.4')  // -> [{ age: '20', sex: 'M', share: '0.4' }]
 */
export function parseDelimited(text) {
  const cleanText = text.replace(/^﻿/, '');
  const firstLine = cleanText.split(/\r?\n/, 1)[0];
  const delimiter = [',', ';', '\t']
    .map(candidate => [candidate, firstLine.split(candidate).length])
    .sort((left, right) => right[1] - left[1])[0][0];
  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  const pushRecord = () => {
    record.push(field);
    field = '';
    if (record.some(item => item !== '')) records.push(record);
    record = [];
  };
  for (let index = 0; index < cleanText.length; index++) {
    const character = cleanText[index];
    if (inQuotes) {
      if (character === '"' && cleanText[index + 1] === '"') { field += '"'; index++; }
      else if (character === '"') inQuotes = false;
      else field += character;
    } else if (character === '"') inQuotes = true;
    else if (character === delimiter) { record.push(field); field = ''; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && cleanText[index + 1] === '\n') index++;
      pushRecord();
    } else field += character;
  }
  if (field !== '' || record.length) pushRecord();
  if (!records.length) return [];
  const header = records.shift().map(name => name.trim().toLowerCase());
  return records.map(values => Object.fromEntries(header.map((name, column) => [name, (values[column] ?? '').trim()])));
}

/**
 * Code part of an Eurostat cell that may carry a label ("Y15: 15 years" -> "Y15").
 * Inputs:  cell (string)
 * Output:  string (upper case, no spaces)
 * Example: codeOf('F: Females')  // -> 'F'
 */
function codeOf(cell) {
  return String(cell ?? '').split(':')[0].trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * Parse an age code (Eurostat or tidy) into an interval.
 * Supported: Y_LT1, Y_LT15, Y5, Y15-19, Y_GE85, Y_OPEN, 20, 60-64, 85+. Returns null for TOTAL, UNK...
 * Inputs:  cell (string)
 * Output:  { start: number|null, end: number, open: boolean } | null (start null for Y_OPEN)
 * Example: parseAgeCode('Y15-19')  // -> { start: 15, end: 19, open: false }
 */
export function parseAgeCode(cell) {
  const code = codeOf(cell);
  let match;
  if (code === 'Y_LT1') return { start: 0, end: 0, open: false };
  if ((match = code.match(/^Y_LT(\d+)$/))) return { start: 0, end: Number(match[1]) - 1, open: false };
  if ((match = code.match(/^Y_GE(\d+)$/))) return { start: Number(match[1]), end: OPEN_AGE, open: true };
  if (code === 'Y_OPEN') return { start: null, end: OPEN_AGE, open: true };
  if ((match = code.match(/^Y?(\d+)-Y?(\d+)$/))) return { start: Number(match[1]), end: Number(match[2]), open: false };
  if ((match = code.match(/^Y?(\d+)\+$/))) return { start: Number(match[1]), end: OPEN_AGE, open: true };
  if ((match = code.match(/^Y?(\d+)$/))) return { start: Number(match[1]), end: Number(match[1]), open: false };
  return null;
}

/**
 * Sex key from Eurostat or tidy codes.
 * Inputs:  cell (string; M, F, T, MALE, FEMALE, MUZI, ZENY ...)
 * Output:  'male' | 'female' | 'total' | null
 * Example: parseSexCode('F')  // -> 'female'
 */
function parseSexCode(cell) {
  const code = codeOf(cell);
  if (['M', 'MALE', 'MALES', 'MUZI', 'MUZ'].includes(code)) return 'male';
  if (['F', 'FEMALE', 'FEMALES', 'ZENY', 'ZENA', 'Z'].includes(code)) return 'female';
  if (['T', 'TOTAL', 'SPOLU'].includes(code)) return 'total';
  return null;
}

/**
 * Numeric value of a cell (handles ':' for missing values, decimal comma and spaces).
 * Inputs:  cell (string)
 * Output:  number (NaN when missing)
 * Example: parseNumber('1 234,5')  // -> 1234.5
 */
function parseNumber(cell) {
  const text = String(cell ?? '').trim().replace(/\s+/g, '');
  if (text === '' || text === ':') return NaN;
  return Number(/^-?\d+,\d+$/.test(text) ? text.replace(',', '.') : text);
}

const KNOWN_COLUMNS = new Set([
  'dataflow', 'last update', 'freq', 'sex', 'age', 'geo', 'time_period', 'time', 'obs_value', 'value',
  'obs_flag', 'conf_status', 'structure', 'structure_id', 'structure_name', 'action', 'obs_status'
]);

/**
 * Keep the rows of one Eurostat extract that belong to the wanted slice. Every extra dimension with
 * more than one value must have a preferred value (e.g. citizen=TOTAL); otherwise the file is ambiguous.
 * Inputs:  rows (object[] from parseDelimited), preferences ({ [dimension]: string[] }), fileName (string)
 * Output:  object[] (filtered rows)
 * Example: applyDimensionPreferences(rows, { citizen: ['TOTAL'], agedef: ['COMPLET'] }, 'migr_emi2.csv')
 */
function applyDimensionPreferences(rows, preferences, fileName) {
  if (!rows.length) return rows;
  let filtered = rows;
  const geoValues = [...new Set(filtered.map(row => codeOf(row.geo)).filter(Boolean))];
  if (geoValues.length > 1) filtered = filtered.filter(row => codeOf(row.geo) === 'SK');
  for (const column of Object.keys(filtered[0])) {
    if (KNOWN_COLUMNS.has(column)) continue;
    const values = [...new Set(filtered.map(row => codeOf(row[column])))];
    if (values.length <= 1) continue;
    const preferred = (preferences[column] || []).find(code => values.includes(code));
    if (!preferred) {
      throw new Error(`${fileName}: stĺpec "${column}" má viac hodnôt (${values.join(', ')}). Vyfiltrujte jednu hodnotu.`);
    }
    filtered = filtered.filter(row => codeOf(row[column]) === preferred);
  }
  return filtered;
}

/**
 * Time and value accessors that work for SDMX-CSV (TIME_PERIOD, OBS_VALUE) and tidy files (time, value).
 * Inputs:  row (object)
 * Output:  number
 * Example: rowYear({ time_period: '2024' })  // -> 2024
 */
function rowYear(row) { return Number(codeOf(row.time_period ?? row.time)); }
function rowValue(row) { return parseNumber(row.obs_value ?? row.value); }

/**
 * Latest year available in the rows that is not after the preferred year (else the earliest year).
 * Inputs:  rows (object[]), preferredYear (number)
 * Output:  number (year)
 * Example: pickYear(rows, 2024)
 */
function pickYear(rows, preferredYear) {
  const years = [...new Set(rows.map(rowYear).filter(Number.isFinite))].sort((left, right) => left - right);
  if (!years.length) throw new Error('V súbore chýba stĺpec s rokom (TIME_PERIOD).');
  const notAfter = years.filter(year => year <= preferredYear);
  return notAfter.length ? notAfter[notAfter.length - 1] : years[0];
}

/**
 * Single-age values by sex for one year (single ages + one open interval mapped to age 100).
 * Inputs:  rows (object[]), year (number), scale (number, multiplier applied to values)
 * Output:  { male: number[101], female: number[101], openStart: { male, female } }
 * Example: singleAgeBySex(pjanRows, 2024, 0.001)  // persons -> thousands
 */
function singleAgeBySex(rows, year, scale) {
  const result = { male: new Array(AGE_COUNT).fill(NaN), female: new Array(AGE_COUNT).fill(NaN), openStart: {} };
  const openRows = [];
  for (const row of rows) {
    if (rowYear(row) !== year) continue;
    const sexKey = parseSexCode(row.sex);
    const age = parseAgeCode(row.age);
    if (!age || (sexKey !== 'male' && sexKey !== 'female')) continue;
    if (age.open) { openRows.push({ sexKey, age, value: rowValue(row) * scale }); continue; }
    if (age.start !== age.end || age.start > OPEN_AGE) continue;
    result[sexKey][age.start] = rowValue(row) * scale;
  }
  for (const sexKey of SEX_KEYS) {
    let lastSingle = -1;
    for (let age = 0; age < AGE_COUNT; age++) if (Number.isFinite(result[sexKey][age])) lastSingle = age;
    const open = openRows.find(row => row.sexKey === sexKey);
    result.openStart[sexKey] = open ? (open.age.start ?? lastSingle + 1) : lastSingle + 1;
    if (open && result.openStart[sexKey] <= OPEN_AGE) result[sexKey][result.openStart[sexKey]] = open.value;
  }
  return result;
}

/**
 * Non-overlapping age groups by sex from an extract with (possibly overlapping) age groups, picking the
 * finest partition, plus the aggregate value for the preferred total group.
 * Inputs:  rows (object[]), year (number), totalGroups (string[], e.g. ['Y15-74', 'Y15-64']), scale (number)
 * Output:  { male: {start,end,value}[], female: [...], total: number|NaN }
 * Example: ageGroupsBySex(lfsRows, 2024, ['Y15-74'], 0.01)
 */
function ageGroupsBySex(rows, year, totalGroups, scale) {
  const result = { male: [], female: [], total: NaN };
  const candidates = { male: [], female: [] };
  for (const row of rows) {
    if (rowYear(row) !== year) continue;
    const sexKey = parseSexCode(row.sex);
    const value = rowValue(row) * scale;
    if (!Number.isFinite(value)) continue;
    if (sexKey === 'total' && Number.isNaN(result.total)) {
      const totalIndex = totalGroups.indexOf(codeOf(row.age));
      if (totalIndex >= 0) result.totalRank = Math.min(result.totalRank ?? Infinity, totalIndex);
    }
    const age = parseAgeCode(row.age);
    if (!age || age.start === null || (sexKey !== 'male' && sexKey !== 'female')) continue;
    candidates[sexKey].push({ start: age.start, end: Math.min(age.end, OPEN_AGE), value });
  }
  if (result.totalRank !== undefined) {
    const totalCode = totalGroups[result.totalRank];
    const totalRow = rows.find(row => rowYear(row) === year && parseSexCode(row.sex) === 'total' && codeOf(row.age) === totalCode);
    result.total = rowValue(totalRow) * scale;
  }
  delete result.totalRank;
  for (const sexKey of SEX_KEYS) {
    const sorted = candidates[sexKey].sort((left, right) => (left.end - left.start) - (right.end - right.start) || left.start - right.start);
    const chosen = [];
    for (const group of sorted) {
      if (chosen.every(other => group.end < other.start || group.start > other.end)) chosen.push(group);
    }
    result[sexKey] = chosen.sort((left, right) => left.start - right.start);
  }
  return result;
}

/**
 * Single-age profile from age-group values: linear interpolation between group mid-points, flat
 * between a boundary group's edge and its mid-point, fill values outside the covered ages.
 * Inputs:  groups ({ start, end, value }[] sorted by start), fillBelow, fillAbove (number)
 * Output:  number[] (101 values)
 * Example: groupsToSingleAge([{ start: 15, end: 19, value: 0.2 }, { start: 20, end: 24, value: 0.6 }], 0, 0)
 */
export function groupsToSingleAge(groups, fillBelow, fillAbove) {
  if (!groups.length) return new Array(AGE_COUNT).fill(fillBelow);
  const points = groups.map(group => ({ midpoint: (group.start + group.end) / 2, value: group.value }));
  const firstStart = groups[0].start;
  const lastEnd = groups[groups.length - 1].end;
  return ageArray(age => {
    if (age < firstStart) return fillBelow;
    if (age > lastEnd) return fillAbove;
    if (age <= points[0].midpoint) return points[0].value;
    if (age >= points[points.length - 1].midpoint) return points[points.length - 1].value;
    const upperIndex = points.findIndex(point => point.midpoint >= age);
    const lower = points[upperIndex - 1];
    const upper = points[upperIndex];
    const weight = (age - lower.midpoint) / (upper.midpoint - lower.midpoint);
    return lower.value + (upper.value - lower.value) * weight;
  });
}

// ─── Provisional (parametric) components ───────────────────────────────────

/**
 * PROVISIONAL one-year death probabilities (Gompertz from age 40; e0 approx. 74 / 81 years).
 * Inputs:  sexKey ('male' | 'female')
 * Output:  number[] (101 values; qx[100] = annual death probability in 100+)
 * Example: provisionalQx('female')
 */
function provisionalQx(sexKey) {
  const isMale = sexKey === 'male';
  return ageArray(age => {
    let deathProbability;
    if (age === 0) deathProbability = isMale ? 0.005 : 0.004;
    else if (age < 5) deathProbability = (isMale ? 0.0004 : 0.0003) + 0.0001 * (5 - age);
    else if (age < 15) deathProbability = (isMale ? 0.0002 : 0.0001) + 0.00001 * age;
    else if (age < 40) deathProbability = isMale ? 0.0005 + 0.00004 * (age - 15) : 0.0002 + 0.00002 * (age - 15);
    else deathProbability = isMale ? 0.0020 * Math.exp(0.095 * (age - 40)) : 0.0012 * Math.exp(0.092 * (age - 40));
    return Math.min(deathProbability, 0.95);
  });
}

/**
 * Lee-Carter age sensitivity used when no mortality history is available: equal relative improvement
 * at all ages, tapered linearly above 85 (to 25 % at 100).
 * Inputs:  none
 * Output:  number[] (101 values, sum 1)
 * Example: taperedSensitivity()[100] / taperedSensitivity()[50]  // -> 0.25
 */
function taperedSensitivity() {
  const { startAge, endAge, endFactor } = ASSUMPTIONS.sensitivityTaper;
  const weights = ageArray(age => age <= startAge ? 1 : 1 - (1 - endFactor) * (age - startAge) / (endAge - startAge));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map(weight => weight / total);
}

/**
 * PROVISIONAL fertility shape: x^2 (1-x)^3 with x = (age-15)/34 on ages 15-49 (peak ~29, mean ~29.6).
 * Inputs:  none
 * Output:  number[] (101 values, sum 1)
 * Example: provisionalFertilityShape()[29]
 */
function provisionalFertilityShape() {
  const shape = ageArray(age => {
    if (age < 15 || age > 49) return 0;
    const relativeAge = (age - 15) / 34;
    return relativeAge ** 2 * (1 - relativeAge) ** 3;
  });
  const total = shape.reduce((sum, value) => sum + value, 0);
  return shape.map(value => value / total);
}

/**
 * PROVISIONAL migration age profile: Gaussian (mean 27, sd 12) on ages 0-60, half male, half female.
 * Inputs:  none
 * Output:  { male, female } (number[101], both together sum to 1)
 * Example: provisionalMigrationProfile().male[27]
 */
function provisionalMigrationProfile() {
  const weights = ageArray(age => age <= 60 ? Math.exp(-0.5 * ((age - 27) / 12) ** 2) : 0);
  return normaliseSexProfile({ male: weights, female: weights.slice() });
}

/**
 * PROVISIONAL labour-market age profiles (parametric shapes; NOT official data).
 * Shares refer to the model's conditional waterfall (see allocateLabourStates in model.js).
 * Inputs:  retireAgeRef ({ male, female }: number, statutory retirement age of the base year)
 * Output:  { retired, disabled, student, activity, unemployment, partTime, sick } ({ male, female } number[101])
 * Example: provisionalLabourProfiles({ male: 63, female: 63 }).disabled.male[55]
 */
function provisionalLabourProfiles(retireAgeRef) {
  const studentTable = { 15: 0.98, 16: 0.96, 17: 0.94, 18: 0.85, 19: 0.6, 20: 0.5, 21: 0.46, 22: 0.4, 23: 0.3, 24: 0.2, 25: 0.12, 26: 0.07, 27: 0.04, 28: 0.02, 29: 0.01 };
  const activityMale = age => {
    if (age < 15) return 0;
    if (age < 25) return [0.3, 0.35, 0.45, 0.6, 0.75, 0.82, 0.86, 0.88, 0.9, 0.92][age - 15];
    if (age < 50) return 0.96;
    if (age < 55) return 0.95;
    if (age < 60) return 0.92;
    if (age < 63) return 0.85;
    if (age < 65) return 0.6;
    if (age < 70) return 0.4;
    if (age < 75) return 0.2;
    return 0.05;
  };
  // Women who are neither pensioners, students nor mothers of children under 3 (parental leave is a separate
  // state, so the former dip at 26-33 would count it twice)
  const activityFemale = age => {
    if (age < 20) return Math.max(0, activityMale(age) - 0.05);
    if (age < 25) return [0.80, 0.84, 0.87, 0.89, 0.90][age - 20];
    if (age < 45) return 0.95;
    if (age < 50) return 0.94;
    if (age < 55) return 0.93;
    if (age < 60) return 0.88;
    if (age < 63) return 0.75;
    return activityMale(age);
  };
  const unemploymentByAge = age => age < 15 ? 0 : age < 20 ? 0.2 : age < 25 ? 0.13 : age < 30 ? 0.07 : age < 50 ? 0.05 : age < 55 ? 0.045 : age < 65 ? 0.05 : 0.03;
  const partTimeMale = age => age < 15 ? 0 : age < 25 ? 0.07 : age < 55 ? 0.02 : age < 65 ? 0.04 : 0.2;
  const partTimeFemale = age => age < 15 ? 0 : age < 25 ? 0.09 : age < 55 ? 0.045 : age < 65 ? 0.06 : 0.25;
  const earlyRetirement = { male: [0.02, 0.04, 0.06, 0.08], female: [0.06, 0.12, 0.22, 0.35] };

  const bySex = valueAtAge => ({ male: ageArray(age => valueAtAge(age, 'male')), female: ageArray(age => valueAtAge(age, 'female')) });
  return {
    retired: bySex((age, sexKey) => {
      const reference = Math.round(retireAgeRef[sexKey]);
      if (age >= reference) return 0.98;
      if (age >= reference - 4) return earlyRetirement[sexKey][age - (reference - 4)];
      return 0;
    }),
    disabled: bySex((age, sexKey) => age >= 18 && age < Math.round(retireAgeRef[sexKey]) ? 0.015 + 0.008 * Math.exp(0.07 * (age - 18)) : 0),
    student: bySex((age, sexKey) => {
      if (age < 15) return 1;
      const base = studentTable[age] ?? 0;
      return sexKey === 'female' && age >= 19 && age <= 24 ? Math.min(1, base + 0.04) : base;
    }),
    activity: bySex((age, sexKey) => sexKey === 'male' ? activityMale(age) : activityFemale(age)),
    unemployment: bySex(age => unemploymentByAge(age)),
    partTime: bySex((age, sexKey) => sexKey === 'male' ? partTimeMale(age) : partTimeFemale(age)),
    sick: bySex(age => age < 15 ? 0 : 0.035 + 0.0003 * Math.max(0, age - 20))
  };
}

// ─── Components from CSV ────────────────────────────────────────────────────

/**
 * Population on 1 January by single age and sex (Eurostat demo_pjan), in thousands.
 * Inputs:  rows (object[] from parseDelimited), preferredYear (number)
 * Output:  { year, population: { male, female } number[101] }
 * Example: populationFromEurostat(parseDelimited(text), 2024)
 */
function populationFromEurostat(rows, preferredYear) {
  const filtered = applyDimensionPreferences(rows, { unit: ['NR'] }, 'demo_pjan.csv');
  const year = pickYear(filtered, preferredYear);
  const values = singleAgeBySex(filtered, year, 0.001);
  for (const sexKey of SEX_KEYS) {
    if (values.openStart[sexKey] !== OPEN_AGE) {
      throw new Error(`demo_pjan.csv: očakávané jednotlivé roky veku 0-99 a skupina 100+ (otvorený interval začína ${values.openStart[sexKey]}).`);
    }
    const missing = values[sexKey].findIndex(value => !Number.isFinite(value));
    if (missing >= 0) throw new Error(`demo_pjan.csv: chýba vek ${missing} (${sexKey}, ${year}).`);
  }
  return { year, population: { male: values.male, female: values.female } };
}

/**
 * Base-year death probabilities and Lee-Carter age sensitivity from Eurostat life tables (demo_mlifetable).
 * Ages above the last single age are extrapolated with a Gompertz fit of ln m_x on the 20 preceding ages;
 * b_x is the first singular vector of the centred ln m_x matrix (window and excluded years: ASSUMPTIONS).
 * Inputs:  rows (object[]), preferredYear (number)
 * Output:  { year, male: { qx, ageSensitivity, historyYears }, female: {...} }
 * Example: mortalityFromEurostat(parseDelimited(text), 2024).male.qx
 */
function mortalityFromEurostat(rows, preferredYear) {
  const indicatorColumn = rows.length && 'indic_de' in rows[0] ? 'indic_de' : null;
  const probabilityRows = indicatorColumn ? rows.filter(row => codeOf(row.indic_de) === 'PROBDEATH') : rows;
  const lifeExpectancyRows = indicatorColumn ? rows.filter(row => codeOf(row.indic_de) === 'LIFEXP') : [];
  const filtered = applyDimensionPreferences(probabilityRows.map(row => { const copy = { ...row }; delete copy.indic_de; return copy; }), {}, 'demo_mlifetable.csv');
  const year = pickYear(filtered, preferredYear);
  const scaleOf = values => {
    const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
    return finite.length && finite[Math.floor(finite.length / 2)] > 1 ? 0.001 : 1;   // per mille -> probability
  };

  const qxForYear = (targetYear, sexKey) => {
    const values = singleAgeBySex(filtered, targetYear, 1);
    const raw = values[sexKey];
    const scale = scaleOf(raw);
    const openStart = values.openStart[sexKey];
    const lastSingle = openStart - 1;
    if (lastSingle < 60 || raw.slice(0, lastSingle + 1).some(value => !Number.isFinite(value))) return null;
    const hazards = raw.slice(0, lastSingle + 1).map(value => hazardFromProbability(value * scale));
    // Gompertz fit ln m = alpha + beta * age on the last 20 single ages
    const fitAges = [];
    for (let age = Math.max(40, lastSingle - 19); age <= lastSingle; age++) fitAges.push(age);
    const meanAge = fitAges.reduce((sum, age) => sum + age, 0) / fitAges.length;
    const meanLog = fitAges.reduce((sum, age) => sum + Math.log(hazards[age]), 0) / fitAges.length;
    let covariance = 0, variance = 0;
    for (const age of fitAges) {
      covariance += (age - meanAge) * (Math.log(hazards[age]) - meanLog);
      variance += (age - meanAge) ** 2;
    }
    const slope = covariance / variance;
    const intercept = meanLog - slope * meanAge;
    const qx = ageArray(age => age <= lastSingle ? clamp(raw[age] * scale, 0, 0.999) : probabilityFromHazard(Math.exp(intercept + slope * age)));
    // open interval 100+: constant hazard m_100 = 1 / e_100 when the life table provides it
    const openLifeExpectancy = lifeExpectancyRows.find(row => rowYear(row) === targetYear && parseSexCode(row.sex) === sexKey && parseAgeCode(row.age)?.open);
    if (openStart === OPEN_AGE && openLifeExpectancy && rowValue(openLifeExpectancy) > 0) {
      qx[OPEN_AGE] = probabilityFromHazard(1 / rowValue(openLifeExpectancy));
    }
    return { qx, lastSingle };
  };

  const result = { year };
  for (const sexKey of SEX_KEYS) {
    const base = qxForYear(year, sexKey);
    if (!base) throw new Error(`demo_mlifetable.csv: neúplná tabuľka pre ${sexKey} ${year}.`);
    const historyYears = [];
    const historyLogHazards = [];
    for (let historyYear = year - ASSUMPTIONS.leeCarterWindowYears; historyYear <= year; historyYear++) {
      if (ASSUMPTIONS.leeCarterExcludedYears.includes(historyYear)) continue;
      const history = qxForYear(historyYear, sexKey);
      if (!history) continue;
      historyYears.push(historyYear);
      historyLogHazards.push(history.qx.map(value => Math.log(Math.max(hazardFromProbability(value), 1e-12))));
    }
    let ageSensitivity = taperedSensitivity();
    let sensitivitySource = 'provisional';
    if (historyYears.length >= 10) {
      ageSensitivity = leeCarterSensitivity(historyLogHazards, Math.min(base.lastSingle, 95));
      sensitivitySource = 'official';
    }
    result[sexKey] = { qx: base.qx, ageSensitivity, historyYears, sensitivitySource };
  }
  return result;
}

/**
 * Lee-Carter b_x: first left singular vector of the age x year matrix of centred ln m_x (power
 * iteration), negative values set to 0, ages above fitMaxAge continued with the tapered shape, sum 1.
 * Inputs:  logHazards (number[years][101]), fitMaxAge (integer, last age used in the fit)
 * Output:  number[] (101 values, sum 1)
 * Example: leeCarterSensitivity(historyLogHazards, 95)
 */
function leeCarterSensitivity(logHazards, fitMaxAge) {
  const yearCount = logHazards.length;
  const ageCount = fitMaxAge + 1;
  const centred = [];
  for (let age = 0; age < ageCount; age++) {
    const mean = logHazards.reduce((sum, row) => sum + row[age], 0) / yearCount;
    centred.push(logHazards.map(row => row[age] - mean));
  }
  let vector = new Array(ageCount).fill(1 / Math.sqrt(ageCount));
  for (let iteration = 0; iteration < 500; iteration++) {
    const projected = new Array(yearCount).fill(0);
    for (let age = 0; age < ageCount; age++) for (let year = 0; year < yearCount; year++) projected[year] += centred[age][year] * vector[age];
    const next = centred.map(row => row.reduce((sum, value, year) => sum + value * projected[year], 0));
    const norm = Math.hypot(...next) || 1;
    vector = next.map(value => value / norm);
  }
  if (vector.reduce((sum, value) => sum + value, 0) < 0) vector = vector.map(value => -value);
  const fitted = vector.map(value => Math.max(0, value));
  const taper = taperedSensitivity();
  const tail = fitted[fitMaxAge] / taper[fitMaxAge];
  const sensitivity = ageArray(age => age <= fitMaxAge ? fitted[age] : tail * taper[age]);
  const total = sensitivity.reduce((sum, value) => sum + value, 0);
  return total > 0 ? sensitivity.map(value => value / total) : taperedSensitivity();
}

/**
 * Fertility shape and TFR from Eurostat age-specific fertility rates (demo_fasfr, ages 15-49).
 * Inputs:  rows (object[]), preferredYear (number)
 * Output:  { year, tfr, shape: number[101] (sum 1) }
 * Example: fertilityFromEurostat(parseDelimited(text), 2024).tfr
 */
function fertilityFromEurostat(rows, preferredYear) {
  const filtered = applyDimensionPreferences(rows, {}, 'demo_fasfr.csv');
  const year = pickYear(filtered, preferredYear);
  const rates = new Array(AGE_COUNT).fill(0);
  for (const row of filtered) {
    if (rowYear(row) !== year) continue;
    const age = parseAgeCode(row.age);
    if (!age || age.open || age.start !== age.end || age.start < 15 || age.start > 49) continue;
    const value = rowValue(row);
    if (Number.isFinite(value)) rates[age.start] = value;
  }
  let total = rates.reduce((sum, value) => sum + value, 0);
  if (total > 20) { for (let age = 0; age < AGE_COUNT; age++) rates[age] /= 1000; total /= 1000; }
  if (!(total > 0.3 && total < 8)) throw new Error(`demo_fasfr.csv: nevierohodná TFR ${total} (${year}).`);
  return { year, tfr: total, shape: rates.map(value => value / total) };
}

/**
 * Immigration and emigration age profiles and levels (Eurostat migr_imm1ctz and migr_emi2).
 * Inputs:  immigrationRows, emigrationRows (object[]), preferredYear (number)
 * Output:  { year, netBase, emigrationBase (thousands), immigrationProfile, emigrationProfile ({ male, female }) }
 * Example: migrationFromEurostat(immRows, emiRows, 2024).netBase
 */
function migrationFromEurostat(immigrationRows, emigrationRows, preferredYear) {
  const preferences = { citizen: ['TOTAL'], agedef: ['COMPLET', 'REACH'], unit: ['NR'] };
  const immigration = applyDimensionPreferences(immigrationRows, preferences, 'migr_imm1ctz.csv');
  const emigration = applyDimensionPreferences(emigrationRows, preferences, 'migr_emi2.csv');
  const year = Math.min(pickYear(immigration, preferredYear), pickYear(emigration, preferredYear));
  const toThousands = rows => {
    const values = singleAgeBySex(rows, year, 0.001);
    return { male: values.male.map(value => Number.isFinite(value) ? value : 0), female: values.female.map(value => Number.isFinite(value) ? value : 0) };
  };
  const immigrants = toThousands(immigration);
  const emigrants = toThousands(emigration);
  const sumOf = profile => SEX_KEYS.reduce((sum, sexKey) => sum + profile[sexKey].reduce((inner, value) => inner + value, 0), 0);
  const immigrationTotal = sumOf(immigrants);
  const emigrationTotal = sumOf(emigrants);
  return {
    year,
    netBase: immigrationTotal - emigrationTotal,
    emigrationBase: emigrationTotal,
    immigrationProfile: normaliseSexProfile(immigrants),
    emigrationProfile: normaliseSexProfile(emigrants)
  };
}

/**
 * LFS rate profiles by single age (activity, unemployment, part-time) from Eurostat lfsa_* extracts (%).
 * Inputs:  rows (object[]), preferredYear (number), fileName (string), totalGroups (string[]),
 *          fillAbove (number, value above the oldest group)
 * Output:  { year, profile: { male, female } number[101] (shares 0-1), groups: { male, female } { start, end, value }[],
 *            total (share or NaN) }
 * Example: lfsProfileFromEurostat(rows, 2024, 'lfsa_urgan.csv', ['Y15-74'], 0)
 */
function lfsProfileFromEurostat(rows, preferredYear, fileName, totalGroups, fillAbove) {
  const filtered = applyDimensionPreferences(rows, { citizen: ['TOTAL'], unit: ['PC'], wstatus: ['EMP'], worktime: ['PT'] }, fileName);
  const year = pickYear(filtered, preferredYear);
  const groups = ageGroupsBySex(filtered, year, totalGroups, 0.01);
  const profile = {};
  for (const sexKey of SEX_KEYS) {
    if (!groups[sexKey].length) throw new Error(`${fileName}: chýbajú vekové skupiny pre ${sexKey} (${year}).`);
    profile[sexKey] = groupsToSingleAge(groups[sexKey], 0, fillAbove).map((value, age) => age < 15 ? 0 : clamp(value, 0, 1));
  }
  return { year, profile, groups: { male: groups.male, female: groups.female }, total: groups.total };
}

/**
 * Pension recipients by age and sex (tidy CSV from Socialna poistovna) converted to population shares.
 * Columns: age (single age, range like 60-64 or 85+), sex (M/F), old_age, early, disability (persons).
 * Counts of an age range are spread over its ages in proportion to the population.
 * Inputs:  rows (object[]), population ({ male, female } number[101], thousands)
 * Output:  { retired: { male, female }, disabled: { male, female } } (number[101], shares 0-1)
 * Example: pensionSharesFromTidy(rows, basePopulation).disabled.female[55]
 */
function pensionSharesFromTidy(rows, population) {
  const counts = { retired: { male: new Array(AGE_COUNT).fill(0), female: new Array(AGE_COUNT).fill(0) }, disabled: { male: new Array(AGE_COUNT).fill(0), female: new Array(AGE_COUNT).fill(0) } };
  for (const row of rows) {
    const sexKey = parseSexCode(row.sex);
    const age = parseAgeCode(row.age);
    if (!age || age.start === null || (sexKey !== 'male' && sexKey !== 'female')) continue;
    const retiredCount = (parseNumber(row.old_age) || 0) + (parseNumber(row.early) || 0);
    const disabledCount = parseNumber(row.disability) || 0;
    const ages = [];
    for (let single = age.start; single <= Math.min(age.end, OPEN_AGE); single++) ages.push(single);
    const populationInRange = ages.reduce((sum, single) => sum + population[sexKey][single], 0);
    for (const single of ages) {
      const weight = populationInRange > 0 ? population[sexKey][single] / populationInRange : 1 / ages.length;
      counts.retired[sexKey][single] += retiredCount * weight / 1000;
      counts.disabled[sexKey][single] += disabledCount * weight / 1000;
    }
  }
  const toShares = byAge => ({
    male: byAge.male.map((value, age) => population.male[age] > 0 ? clamp(value / population.male[age], 0, 1) : 0),
    female: byAge.female.map((value, age) => population.female[age] > 0 ? clamp(value / population.female[age], 0, 1) : 0)
  });
  return { retired: toShares(counts.retired), disabled: toShares(counts.disabled) };
}

/**
 * Share profile by single age and sex from a tidy CSV (columns age, sex, share; share in 0-1 or %).
 * Ages that are not listed get 0 (or 1 below 15 for the student profile when childrenAreOne is true).
 * Inputs:  rows (object[]), childrenAreOne (boolean)
 * Output:  { male, female } (number[101])
 * Example: shareProfileFromTidy(parseDelimited(text), true)
 */
function shareProfileFromTidy(rows, childrenAreOne) {
  const profile = {
    male: ageArray(age => childrenAreOne && age < 15 ? 1 : 0),
    female: ageArray(age => childrenAreOne && age < 15 ? 1 : 0)
  };
  for (const row of rows) {
    const sexKey = parseSexCode(row.sex);
    const age = parseAgeCode(row.age);
    let share = parseNumber(row.share);
    if (!age || age.start === null || !Number.isFinite(share)) continue;
    if (share > 1) share /= 100;
    const targets = sexKey === 'male' || sexKey === 'female' ? [sexKey] : SEX_KEYS;
    for (const target of targets) for (let single = age.start; single <= Math.min(age.end, OPEN_AGE); single++) profile[target][single] = clamp(share, 0, 1);
  }
  return profile;
}

/**
 * Root of a non-decreasing function by bisection (saturates at the bracket ends).
 * Inputs:  valueAt (function(number) -> number), target (number), lower, upper (number), iterations (integer)
 * Output:  number
 * Example: bisectRoot(theta => parentalAt(theta), 105, 0, 1, 50)
 */
function bisectRoot(valueAt, target, lower, upper, iterations = 60) {
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
 * Round a default (model units) to the grid of its page slider in config.js, so that the page's default
 * scenario equals calibration.defaults exactly. Keys without a slider are returned unchanged.
 * Inputs:  key (string, SLIDERS key), modelValue (number, model units)
 * Output:  number (model units, on the slider grid)
 * Example: snapToSliderGrid('parentalHomeShare', 0.783)  // -> 0.78
 */
function snapToSliderGrid(key, modelValue) {
  const slider = SLIDERS.find(item => item.key === key);
  if (!slider || !Number.isFinite(modelValue)) return modelValue;
  const decimals = (String(slider.step).split('.')[1] || '').length;
  const sliderValue = modelValue / slider.scale;
  const snapped = Number((Math.round((sliderValue - slider.min) / slider.step) * slider.step + slider.min).toFixed(decimals));
  return Number((snapped * slider.scale).toFixed(decimals + 4));
}

/**
 * Convert a student share of the whole population (students.csv) to the model's share among persons who
 * are not pensioners: s = s_pop / (1 - r - d), only where 1 - r - d > 0.05; clamped to [0, 1]; ages < 15 stay 1.
 * Inputs:  populationShare, retired, disabled ({ male, female } number[101]), log (function)
 * Output:  { male, female } (number[101])
 * Example: studentShareConditional(shareProfileFromTidy(rows, true), profiles.retired, profiles.disabled, console.log)
 */
function studentShareConditional(populationShare, retired, disabled, log) {
  let clampedAges = 0;
  const result = {};
  for (const sexKey of SEX_KEYS) {
    result[sexKey] = ageArray(age => {
      if (age < 15) return 1;
      const available = 1 - retired[sexKey][age] - disabled[sexKey][age];
      if (!(available > 0.05)) return 0;
      const share = populationShare[sexKey][age] / available;
      if (share > 1) clampedAges++;
      return clamp(share, 0, 1);
    });
  }
  if (clampedAges) log(`  upozornenie: students.csv – podiel študentov orezaný na 1 v ${clampedAges} vekoch`);
  return result;
}

/**
 * Conditional activity profiles (persons who are neither pensioners, students nor mothers of children aged
 * 34 weeks-3 years) that reproduce the LFS activity of the whole population in the model's own allocation.
 * 1. Each LFS age group is inverted with a constant conditional rate (sums over the ages of the group):
 *    below the reference retirement age  a_g = sum N (aV - (1 - theta) mu_T - w_s S/N - w_d d) / sum N (q - mu_T - mu_N min(0.95, u lambda_U)),
 *    from it on                          a_g = sum N (aV (1 - r) - w_s S/N - w_d d) / sum N q   (working pensioners are not modelled),
 *    with q = (1 - r - d)(1 - s) and a fixed point for lambda_U.
 * 2. The group rates are interpolated between group mid-points (the conditional profile is smooth, unlike the LFS
 *    rate, which has the parental-leave dip) and corrected per group so that the forward model reproduces the
 *    LFS group means below the retirement age exactly (3 passes).
 * Inputs:  lfs ({ profile: { male, female } number[101], groups: { male, female } { start, end, value }[] })
 *          context ({ population, labour (with profiles), defaults (model units), motherShares, parentalHomeShare })
 * Output:  { profile: { male, female } number[101], maxGroupGap (p.p.), clampedAges (integer), unemploymentScale }
 * Example: conditionalActivityFromLfs(lfsActivity, { population, labour, defaults, motherShares, parentalHomeShare: 0.8 })
 */
function conditionalActivityFromLfs(lfs, context) {
  const { population, labour, defaults, motherShares, parentalHomeShare } = context;
  const profiles = labour.profiles;
  const shares = labour.lfsActivityShares;
  const referenceAge = labour.retireAgeRef;
  const composition = {};
  for (const sexKey of SEX_KEYS) {
    composition[sexKey] = ageArray(age => {
      const retiredShare = clamp(interpolateProfile(profiles.retired[sexKey], age), 0, 1);
      const disabledShare = Math.max(0, Math.min(1 - retiredShare, clamp(interpolateProfile(profiles.disabled[sexKey], age), 0, 1)));
      const studentShare = clamp(interpolateProfile(profiles.student[sexKey], age), 0, 1);
      return {
        retiredShare, disabledShare,
        studentsOfPopulation: (1 - retiredShare - disabledShare) * studentShare,
        pool: (1 - retiredShare - disabledShare) * (1 - studentShare)
      };
    });
  }
  const motherShare = (sexKey, kind, age) => (sexKey === 'female' ? motherShares[kind][age] : 0);
  const unemploymentAt = (sexKey, age) => clamp(interpolateProfile(profiles.unemployment[sexKey], age), 0, 1);
  const effectivePool = (sexKey, age, scale) => composition[sexKey][age].pool - motherShare(sexKey, 'toddler', age)
    - motherShare(sexKey, 'newborn', age) * Math.min(0.95, unemploymentAt(sexKey, age) * scale);
  const groupRate = (sexKey, group, scale) => {
    let numerator = 0;
    let denominator = 0;
    for (let age = Math.max(15, group.start); age <= group.end; age++) {
      const persons = population[sexKey][age];
      const { retiredShare, disabledShare, studentsOfPopulation, pool } = composition[sexKey][age];
      if (age < referenceAge[sexKey]) {
        numerator += persons * (group.value - (1 - parentalHomeShare) * motherShare(sexKey, 'toddler', age)
          - shares.student * studentsOfPopulation - shares.disabled * disabledShare);
        denominator += persons * Math.max(0, effectivePool(sexKey, age, scale));
      } else {
        numerator += persons * (group.value * (1 - retiredShare) - shares.student * studentsOfPopulation - shares.disabled * disabledShare);
        denominator += persons * pool;
      }
    }
    return denominator > 1e-9 ? clamp(numerator / denominator, 0, 0.995) : 0;
  };
  const interpolatedProfile = (sexKey, scale) => {
    const rates = lfs.groups[sexKey].map(group => ({ start: group.start, end: group.end, value: groupRate(sexKey, group, scale) }));
    const lastRate = rates.length ? rates[rates.length - 1].value : 0;
    return groupsToSingleAge(rates, 0, lastRate).map((value, age) => (age < 15 ? 0 : clamp(value, 0, 0.995)));
  };
  const profile = {};
  const forward = () => allocateLabourStates(population,
    buildLabourInputs(defaults, labour, [referenceAge.male, referenceAge.female], 0, parentalHomeShare),
    { ...profiles, activity: profile }, motherShares);

  let unemploymentScale = 1;
  for (let pass = 0; pass < 2; pass++) {
    for (const sexKey of SEX_KEYS) profile[sexKey] = interpolatedProfile(sexKey, unemploymentScale);
    unemploymentScale = forward().unemploymentScale || 1;
  }

  let maxGroupGap = 0;
  for (let pass = 0; pass < 4; pass++) {
    const result = forward();
    maxGroupGap = 0;
    for (const sexKey of SEX_KEYS) {
      const sex = sexKey === 'male' ? 0 : 1;
      for (const group of lfs.groups[sexKey]) {
        if (group.start < 15 || group.end >= Math.floor(referenceAge[sexKey])) continue;
        let persons = 0;
        let active = 0;
        let pool = 0;
        for (let age = group.start; age <= group.end; age++) {
          const persons_ = population[sexKey][age];
          const offset = (age * 2 + sex) * STATE_COUNT;
          active += result.states[offset + STATE.EMP_FULL] + result.states[offset + STATE.EMP_PART] + result.states[offset + STATE.SICK]
            + result.states[offset + STATE.MATERNITY] + result.states[offset + STATE.UNEMP]
            + shares.student * result.states[offset + STATE.STUDENT] + shares.disabled * result.states[offset + STATE.DISAB];
          persons += persons_;
          pool += persons_ * Math.max(0, effectivePool(sexKey, age, result.unemploymentScale));
        }
        if (!(persons > 0)) continue;
        const gap = group.value - active / persons;
        maxGroupGap = Math.max(maxGroupGap, Math.abs(gap));
        const derivative = pool / persons;
        if (pass < 3 && derivative > 0.05) {
          for (let age = group.start; age <= group.end; age++) profile[sexKey][age] = clamp(profile[sexKey][age] + gap / derivative, 0, 0.995);
        }
      }
    }
    unemploymentScale = result.unemploymentScale;
  }

  let clampedAges = 0;
  for (const sexKey of SEX_KEYS) {
    for (let age = 15; age < referenceAge[sexKey]; age++) if (profile[sexKey][age] >= 0.995 - 1e-12) clampedAges++;
  }
  return { profile, maxGroupGap: 100 * maxGroupGap, clampedAges, unemploymentScale };
}

/**
 * Share of mothers at home (theta) at which the model's parental-leave stock in the base year equals a target
 * (for example non-working recipients of rodičovský príspevok from ÚPSVaR); bisection on [0, 1].
 * Inputs:  population ({ male, female }), labour (calibration.labour), defaults (model units),
 *          motherShares (computeMotherShares output), targetThousands (number)
 * Output:  number (theta in [0, 1])
 * Example: solveParentalHomeShare(basePopulation, labour, labourDefaults, motherShares, 105.2)
 */
function solveParentalHomeShare(population, labour, defaults, motherShares, targetThousands) {
  const parentalAt = theta => allocateLabourStates(population,
    buildLabourInputs(defaults, labour, [labour.retireAgeRef.male, labour.retireAgeRef.female], 0, theta),
    labour.profiles, motherShares).totals[STATE.PARENTAL];
  return bisectRoot(parentalAt, targetThousands, 0, 1, 50);
}

/**
 * EUROPOP2023 baseline population by single age and sex for every projection year (proj_23np).
 * Inputs:  rows (object[]), fromYear, toYear (number)
 * Output:  { source, years: number[], male: { [year]: number[101] }, female: { [year]: number[101] } } (thousands)
 * Example: benchmarkFromEurostat(rows, 2024, 2100).years
 */
function benchmarkFromEurostat(rows, fromYear, toYear) {
  const filtered = applyDimensionPreferences(rows, { projection: ['BSL'], unit: ['PER', 'NR'] }, 'proj_23np.csv');
  const years = [...new Set(filtered.map(rowYear))].filter(year => year >= fromYear && year <= toYear).sort((a, b) => a - b);
  const benchmark = { source: 'Eurostat EUROPOP2023, proj_23np (baseline)', years: [], male: {}, female: {} };
  for (const year of years) {
    const values = singleAgeBySex(filtered, year, 0.001);
    if (SEX_KEYS.some(sexKey => values.openStart[sexKey] !== OPEN_AGE || values[sexKey].some(value => !Number.isFinite(value)))) continue;
    benchmark.years.push(year);
    benchmark.male[year] = values.male;
    benchmark.female[year] = values.female;
  }
  if (!benchmark.years.length) throw new Error('proj_23np.csv: nenašli sa úplné roky (vek 0-99 a 100+).');
  return benchmark;
}

/**
 * Key-value overrides (tidy CSV with columns key, value[, source]).
 * Inputs:  rows (object[])
 * Output:  { [key]: { value: number, source: string } }
 * Example: parametersFromTidy(rows).e0_male_target.value
 */
function parametersFromTidy(rows) {
  const parameters = {};
  for (const row of rows) {
    const key = String(row.key || '').trim().toLowerCase();
    const value = parseNumber(row.value);
    if (key && Number.isFinite(value)) parameters[key] = { value, source: row.source || 'data/raw/parameters.csv' };
  }
  return parameters;
}

// ─── Build ──────────────────────────────────────────────────────────────────

/**
 * Build calibration (and optionally anchors and benchmark) from the CSV files in rawDir.
 * Inputs:  options ({ rawDir: string, outDir: string, write: boolean (default true),
 *                     log: function (default console.log) })
 * Output:  { calibration, anchors, benchmark|null, summary } (objects; files written when write = true)
 * Example: buildCalibration({ rawDir: 'data/raw', outDir: 'data' })
 */
export function buildCalibration({ rawDir, outDir, write = true, log = console.log }) {
  const components = {};
  const readRaw = fileName => {
    const filePath = path.join(rawDir, fileName);
    return fs.existsSync(filePath) ? parseDelimited(fs.readFileSync(filePath, 'utf8')) : null;
  };
  const official = (source, year, extra = {}) => ({ status: 'official', source, year, ...extra });
  const provisional = note => ({ status: 'provisional', source: note });

  // Population (anchors)
  let anchors;
  let baseYear = DEFAULT_BASE_YEAR;
  const populationRows = readRaw('demo_pjan.csv');
  if (populationRows) {
    const population = populationFromEurostat(populationRows, DEFAULT_BASE_YEAR);
    baseYear = population.year;
    anchors = { [baseYear]: population.population };
    components.population = official('Eurostat demo_pjan (obyvateľstvo k 1. 1., jednotlivé roky veku)', baseYear);
  } else {
    anchors = JSON.parse(fs.readFileSync(path.join(outDir, 'anchors.json'), 'utf8'));
    baseYear = Number(Object.keys(anchors)[0]);
    components.population = provisional('Pôvodné dáta projektu: 5-ročné vekové skupiny rozdelené rovnomerne na jednotlivé roky (súčet 5,51 mil. vs. ŠÚ SR ≈ 5,42 mil.).');
  }
  const basePopulation = anchors[String(baseYear)];

  const parameterRows = readRaw('parameters.csv');
  const parameters = parameterRows ? parametersFromTidy(parameterRows) : {};
  const parameter = (key, fallback) => parameters[key] ? parameters[key].value : fallback;

  // Mortality
  const mortalityRows = readRaw('demo_mlifetable.csv');
  let mortality;
  if (mortalityRows) {
    const estimated = mortalityFromEurostat(mortalityRows, baseYear);
    mortality = {
      targetYear: MORTALITY_TARGET_YEAR,
      male: { qx: estimated.male.qx, ageSensitivity: estimated.male.ageSensitivity },
      female: { qx: estimated.female.qx, ageSensitivity: estimated.female.ageSensitivity }
    };
    components.mortality = official('Eurostat demo_mlifetable (q_x)', estimated.year);
    components.mortalityImprovement = estimated.male.sensitivitySource === 'official'
      ? official(`Lee-Carter b_x odhadnuté z rokov ${estimated.male.historyYears[0]}–${estimated.male.historyYears.at(-1)} (bez ${ASSUMPTIONS.leeCarterExcludedYears.join(', ')})`, estimated.year)
      : provisional('Rovnomerné b_x so zoslabením nad 85 rokov (málo historických rokov na odhad).');
  } else {
    mortality = {
      targetYear: MORTALITY_TARGET_YEAR,
      male: { qx: provisionalQx('male'), ageSensitivity: taperedSensitivity() },
      female: { qx: provisionalQx('female'), ageSensitivity: taperedSensitivity() }
    };
    components.mortality = provisional('Parametrická aproximácia (Gompertz od 40 rokov), e0 ≈ 74 / 81 rokov.');
    components.mortalityImprovement = provisional('Rovnomerné b_x so zoslabením nad 85 rokov.');
  }

  // Fertility
  const fertilityRows = readRaw('demo_fasfr.csv');
  let fertility;
  if (fertilityRows) {
    const estimated = fertilityFromEurostat(fertilityRows, baseYear);
    fertility = { tfrBase: estimated.tfr, shape: estimated.shape };
    components.fertility = official('Eurostat demo_fasfr (plodnosť podľa veku matky)', estimated.year);
  } else {
    fertility = { tfrBase: PROVISIONAL.tfrBase, shape: provisionalFertilityShape() };
    components.fertility = provisional('TFR 1,5 a parametrický profil x²(1−x)³ na veku 15–49.');
  }

  // Migration
  const immigrationRows = readRaw('migr_imm1ctz.csv');
  const emigrationRows = readRaw('migr_emi2.csv');
  let migration;
  if (immigrationRows && emigrationRows) {
    const estimated = migrationFromEurostat(immigrationRows, emigrationRows, baseYear);
    migration = {
      netBase: estimated.netBase, emigrationBase: estimated.emigrationBase,
      immigrationProfile: estimated.immigrationProfile, emigrationProfile: estimated.emigrationProfile
    };
    components.migration = official('Eurostat migr_imm1ctz − migr_emi2 (vek, pohlavie)', estimated.year);
  } else {
    const profile = provisionalMigrationProfile();
    migration = { netBase: PROVISIONAL.netMigrationBase, emigrationBase: 0, immigrationProfile: profile, emigrationProfile: profile };
    components.migration = provisional('Čistá migrácia 1 tis./rok, gaussovský vekový profil (priemer 27, sd 12).');
  }

  // Labour market (defaults are rounded to the page sliders' grid so the page reproduces the calibration)
  const retireAgeRef = {
    male: snapToSliderGrid('retireAgeMale', parameter('retire_age_ref_male', PROVISIONAL.retireAgeRef)),
    female: snapToSliderGrid('retireAgeFemale', parameter('retire_age_ref_female', PROVISIONAL.retireAgeRef))
  };
  components.retirementAge = parameters.retire_age_ref_male
    ? official(parameters.retire_age_ref_male.source, baseYear)
    : provisional('Dôchodkový vek 63 rokov pre mužov aj ženy (zjednodušenie).');
  const profiles = provisionalLabourProfiles(retireAgeRef);

  const pensionRows = readRaw('sp_poberatelia.csv');
  if (pensionRows) {
    const shares = pensionSharesFromTidy(pensionRows, basePopulation);
    profiles.retired = shares.retired;
    profiles.disabled = shares.disabled;
    components.pensions = official('Sociálna poisťovňa: poberatelia starobného, predčasného a invalidného dôchodku', baseYear);
  } else {
    components.pensions = provisional('Parametrické profily: invalidita ≈ 1,5 % + 0,8 %·e^{0,07(x−18)}; predčasné dôchodky pred dôch. vekom.');
  }
  const studentRows = readRaw('students.csv');
  if (studentRows) {
    profiles.student = studentShareConditional(shareProfileFromTidy(studentRows, true), profiles.retired, profiles.disabled, log);
    components.students = official('data/raw/students.csv (podiel na obyvateľstve, prepočítaný na osoby mimo dôchodcov)', baseYear);
  } else {
    components.students = provisional('Parametrický profil podielu študentov 15–29 rokov.');
  }
  const sickRows = readRaw('sick.csv');
  if (sickRows) {
    profiles.sick = shareProfileFromTidy(sickRows, false);
    components.sickLeave = official('data/raw/sick.csv', baseYear);
  } else {
    components.sickLeave = provisional('PN 3,5 % zamestnaných + 0,03 p. b. za každý rok veku nad 20.');
  }

  let unemploymentDefault = PROVISIONAL.unemploymentRate;
  let partTimeDefault = PROVISIONAL.partTimeRate;
  const unemploymentRows = readRaw('lfsa_urgan.csv');
  if (unemploymentRows) {
    const lfs = lfsProfileFromEurostat(unemploymentRows, baseYear, 'lfsa_urgan.csv', ['Y15-74', 'Y15-64', 'Y20-64'], 0.03);
    profiles.unemployment = lfs.profile;
    if (Number.isFinite(lfs.total)) unemploymentDefault = 100 * lfs.total;
    components.unemployment = official('Eurostat lfsa_urgan (miera nezamestnanosti, VZPS)', lfs.year);
  } else {
    components.unemployment = provisional('Vekový profil nezamestnanosti (20 % 15–19 r. … 5 % 30–64 r.), agregát 5,3 %.');
  }
  const partTimeRows = readRaw('lfsa_eppgan.csv');
  if (partTimeRows) {
    const lfs = lfsProfileFromEurostat(partTimeRows, baseYear, 'lfsa_eppgan.csv', ['Y15-74', 'Y15-64', 'Y20-64'], 0.2);
    profiles.partTime = lfs.profile;
    if (Number.isFinite(lfs.total)) partTimeDefault = 100 * lfs.total;
    components.partTime = official('Eurostat lfsa_eppgan (podiel čiastočných úväzkov, VZPS)', lfs.year);
  } else {
    components.partTime = provisional('Vekový profil čiastočných úväzkov, agregát 3,5 %.');
  }
  unemploymentDefault = snapToSliderGrid('unemploymentRate', parameter('unemployment_rate', unemploymentDefault));
  partTimeDefault = snapToSliderGrid('partTimeRate', parameter('part_time_rate', partTimeDefault));

  const maternityLeaveYears = parameter('maternity_leave_weeks', ASSUMPTIONS.maternityLeaveWeeks) / 52;
  const lfsActivityShares = { student: ASSUMPTIONS.studentActivityShare, disabled: ASSUMPTIONS.disabledActivityShare };
  const labour = { retireAgeRef, pivotAge: PIVOT_AGE, maternityLeaveYears, lfsActivityShares, profiles };
  const baseMotherShares = computeMotherShares(basePopulation, fertility.shape, maternityLeaveYears);
  const labourDefaults = { unemploymentRate: unemploymentDefault, partTimeRate: partTimeDefault, disabilityMultiplier: 1, studyShift: 0 };

  // Share of mothers at home (theta): parameter, or solved from ÚPSVaR non-working recipients, or provisional
  let parentalHomeShare = PROVISIONAL.parentalHomeShare;
  let parentalSource = null;
  if (parameters.parental_home_share) {
    const value = parameters.parental_home_share.value;
    parentalHomeShare = clamp(value > 1 ? value / 100 : value, 0, 1);
    parentalSource = parameters.parental_home_share.source;
  }
  parentalHomeShare = snapToSliderGrid('parentalHomeShare', parentalHomeShare);
  const recipientsNotWorking = parameters.parental_recipients_not_working ? parameters.parental_recipients_not_working.value / 1000 : NaN;

  // Activity: LFS conversion depends on theta, theta from ÚPSVaR depends on activity -> short fixed point
  const activityRows = readRaw('lfsa_argan.csv');
  const lfsActivity = activityRows ? lfsProfileFromEurostat(activityRows, baseYear, 'lfsa_argan.csv', ['Y15-74', 'Y15-64'], 0.02) : null;
  let conversion = null;
  for (let iteration = 0; iteration < 4; iteration++) {
    if (lfsActivity) {
      conversion = conditionalActivityFromLfs(lfsActivity, { population: basePopulation, labour, defaults: labourDefaults, motherShares: baseMotherShares, parentalHomeShare });
      profiles.activity = conversion.profile;
    }
    if (!Number.isFinite(recipientsNotWorking)) break;
    const solved = snapToSliderGrid('parentalHomeShare', solveParentalHomeShare(basePopulation, labour, labourDefaults, baseMotherShares, recipientsNotWorking));
    parentalSource = parameters.parental_recipients_not_working.source;
    const converged = Math.abs(solved - parentalHomeShare) < 0.005;
    parentalHomeShare = solved;
    if (converged) break;
  }
  if (lfsActivity) {
    components.activity = official('Eurostat lfsa_argan (miera aktivity, VZPS) prepočítaná na podmienenú aktivitu', lfsActivity.year);
    if (conversion.maxGroupGap > 0.5) log(`  upozornenie: model nereprodukuje VZPS – najväčšia odchýlka vekovej skupiny ${conversion.maxGroupGap.toFixed(2)} p. b.`);
    if (conversion.clampedAges) log(`  upozornenie: podmienená aktivita narazila na hranicu 0,995 v ${conversion.clampedAges} vekoch (skontrolujte podiel matiek doma)`);
  } else {
    components.activity = provisional('Parametrické krivky aktivity osôb mimo dôchodcov, študentov a matiek malých detí (muži ≈ 96 %, ženy 25–44 ≈ 95 %).');
  }
  components.parentalLeave = parentalSource
    ? official(parentalSource, baseYear)
    : provisional('Podiel matiek doma s dieťaťom od 34. týždňa do 3 rokov 80 % (odhad; nahradiť dátami ÚPSVaR).');

  // Women 25-45: activity at the default settings (shift 0) -> default level and attainable maximum
  const womenActivityAtDefaults = solveWomenActivityShift(basePopulation,
    buildLabourInputs(labourDefaults, labour, [retireAgeRef.male, retireAgeRef.female], 0, parentalHomeShare),
    profiles, baseMotherShares, NaN);
  const womenActivityLevel = snapToSliderGrid('womenActivityLevel', 100 * womenActivityAtDefaults.achieved);
  const womenActivityMax = 100 * womenActivityAtDefaults.maximum;
  if (womenActivityMax - womenActivityLevel < 1) log(`  upozornenie: aktivitu žien 25–45 možno zvýšiť len o ${(womenActivityMax - womenActivityLevel).toFixed(2)} p. b. (maximum ${womenActivityMax.toFixed(1)} %)`);

  // Targets of the base scenario
  const e0MaleTarget = snapToSliderGrid('e0MaleTarget', parameter('e0_male_target', PROVISIONAL.e0MaleTarget));
  const e0FemaleTarget = snapToSliderGrid('e0FemaleTarget', parameter('e0_female_target', PROVISIONAL.e0FemaleTarget));
  components.targets = parameters.e0_male_target
    ? official(parameters.e0_male_target.source, MORTALITY_TARGET_YEAR)
    : provisional(`Cieľové e0 v roku ${MORTALITY_TARGET_YEAR}: muži ${e0MaleTarget}, ženy ${e0FemaleTarget} (odhad; nahradiť predpokladmi EUROPOP2023).`);

  // Benchmark
  const benchmarkRows = readRaw('proj_23np.csv');
  let benchmark = null;
  if (benchmarkRows) {
    benchmark = benchmarkFromEurostat(benchmarkRows, baseYear, MORTALITY_TARGET_YEAR);
    components.benchmark = official(benchmark.source, `${benchmark.years[0]}–${benchmark.years.at(-1)}`);
  } else {
    components.benchmark = { status: 'missing', source: 'EUROPOP2023 (proj_23np) zatiaľ nebolo nahrané.' };
  }

  const calibration = {
    meta: {
      schemaVersion: CALIBRATION_SCHEMA_VERSION,
      status: 'provisional',
      generatedAt: new Date().toISOString().slice(0, 10),
      generator: 'tools/build_data.mjs',
      components,
      assumptions: ASSUMPTIONS
    },
    baseYear,
    sexRatioMaleShare: parameter('sex_ratio_male_share', ASSUMPTIONS.sexRatioMaleShare),
    mortality,
    fertility,
    migration,
    labour,
    defaults: {
      tfrTarget: snapToSliderGrid('tfrTarget', parameter('tfr_target', fertility.tfrBase)),
      migrationTarget: snapToSliderGrid('migrationTarget', parameter('migration_target', migration.netBase)),
      targetYear: snapToSliderGrid('targetYear', parameter('target_year', DEFAULT_TARGET_YEAR)),
      e0MaleTarget,
      e0FemaleTarget,
      retireAgeMale: retireAgeRef.male,
      retireAgeFemale: retireAgeRef.female,
      retireAgeLinkShare: 0,
      unemploymentRate: unemploymentDefault,
      womenActivityLevel,
      parentalHomeShare,
      partTimeRate: partTimeDefault,
      disabilityMultiplier: 1,
      studyShift: 0,
      womenActivityChange: 0
    },
    baseValues: {}
  };
  const coreComponents = ['population', 'mortality', 'fertility', 'pensions', 'activity', 'unemployment', 'parentalLeave'];
  const coreStatuses = coreComponents.map(name => components[name].status);
  calibration.meta.status = coreStatuses.every(status => status === 'official') ? 'official'
    : coreStatuses.some(status => status === 'official') ? 'partial' : 'provisional';

  // Base-year values: exactly what the page shows for the default scenario (shown in tooltips and docs)
  const lifeTableMale = buildLifeTable(mortality.male.qx);
  const lifeTableFemale = buildLifeTable(mortality.female.qx);
  const baseRun = runSimulation(basePopulation, calibration.defaults, calibration, baseYear, baseYear);
  const baseSeries = baseRun.series;
  const baseTotals = baseSeries.stateTotals[0];
  calibration.baseValues = {
    population: baseSeries.total[0],
    e0Male: lifeTableMale.ex[0],
    e0Female: lifeTableFemale.ex[0],
    e65Male: lifeTableMale.ex[65],
    e65Female: lifeTableFemale.ex[65],
    tfr: fertility.tfrBase,
    netMigration: migration.netBase,
    womenActivity25to45: baseSeries.womenActivity25to45[0],
    womenActivityMax25to45: womenActivityMax,
    stateTotals: Object.fromEntries(STATE_KEYS.map((key, index) => [key, baseTotals[index]])),
    payers: baseSeries.payers[0],
    recipients: baseSeries.recipients[0],
    recipientsPer100Payers: baseSeries.recipientsPer100Payers[0],
    oldAgeDependency: baseSeries.oldAgeDependency[0],
    economicOldAgeDependency: baseSeries.economicOldAgeDependency[0],
    economicDependency: baseSeries.economicDependency[0],
    maternity: baseSeries.maternity[0],
    parental: baseSeries.parental[0]
  };

  if (write) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'calibration.json'), formatJson(calibration) + '\n');
    if (populationRows) fs.writeFileSync(path.join(outDir, 'anchors.json'), formatJson(anchors) + '\n');
    if (benchmark) fs.writeFileSync(path.join(outDir, 'benchmark.json'), formatJson(benchmark) + '\n');
  }

  const summary = Object.entries(components).map(([name, info]) => `${info.status.padEnd(11)} ${name.padEnd(21)} ${info.source}${info.year ? ' [' + info.year + ']' : ''}`);
  log(`Kalibrácia: ${calibration.meta.status} (základný rok ${baseYear})`);
  for (const line of summary) log('  ' + line);
  const values = calibration.baseValues;
  log(`  e0 ${values.e0Male.toFixed(2)} / ${values.e0Female.toFixed(2)}, TFR ${fertility.tfrBase.toFixed(2)}, ` +
    `aktivita žien 25–45 ${values.womenActivity25to45.toFixed(1)} % (max. ${values.womenActivityMax25to45.toFixed(1)} %), matky doma ${(100 * calibration.defaults.parentalHomeShare).toFixed(0)} %`);
  log(`  materská ${values.maternity.toFixed(1)} tis., rodičovská ${values.parental.toFixed(1)} tis.; na 100 platiteľov: poberatelia ${values.recipientsPer100Payers.toFixed(1)}, ` +
    `starobní dôchodcovia ${values.economicOldAgeDependency.toFixed(1)}, neplatitelia ${values.economicDependency.toFixed(1)}; 65+/20–64 ${values.oldAgeDependency.toFixed(1)}`);
  return { calibration, anchors, benchmark, summary };
}

/**
 * Command-line entry point: parse --raw / --out and run buildCalibration.
 * Inputs:  argv (string[], process arguments after the script name)
 * Output:  none (writes files, sets process.exitCode on error)
 * Example: node tools/build_data.mjs --raw data/raw --out data
 */
function main(argv) {
  const optionValue = (name, fallback) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const rawDir = path.resolve(optionValue('--raw', path.join(REPO_ROOT, 'data', 'raw')));
  const outDir = path.resolve(optionValue('--out', path.join(REPO_ROOT, 'data')));
  try {
    buildCalibration({ rawDir, outDir });
  } catch (error) {
    console.error('Chyba: ' + error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
