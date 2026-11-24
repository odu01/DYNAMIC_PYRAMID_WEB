// config.js -- Page configuration: controls, scenarios, labour states and time-series metrics
//
// Slider values are kept in slider units; `scale` converts them to the scenario units used by model.js
// (scenarioValue = sliderValue * scale). Tooltips are functions of the loaded calibration.

import { formatNumber, formatSigned, formatPercent } from './format.js';

export const END_YEAR = 2100;

export const STATE_META = Object.freeze([
  { key: 'EMP_FULL', label: 'Zamestnaný (plný úväzok)', color: '#13B5EA' },
  { key: 'EMP_PART', label: 'Čiastočný úväzok', color: '#3657A7' },
  { key: 'STUDENT', label: 'Deti a študenti', color: '#DCB47B' },
  { key: 'INACTIVE', label: 'Neaktívny', color: '#58595B' },
  { key: 'UNEMP', label: 'Nezamestnaný', color: '#9C479B' },
  { key: 'SICK_MAT', label: 'PN / materská', color: '#37B268' },
  { key: 'DISAB', label: 'Invalidný dôchodca', color: '#997468' },
  { key: 'RETIRED', label: 'Starobný dôchodca', color: '#D82727' }
]);

export const SECTIONS = Object.freeze([
  { id: 'demography', title: 'Plodnosť a migrácia' },
  { id: 'mortality', title: 'Úmrtnosť' },
  { id: 'pensions', title: 'Dôchodkový vek' },
  { id: 'labour', title: 'Trh práce' }
]);

/**
 * Base-year value of the calibration formatted for tooltips.
 * Inputs:  calibration (object), key (string in calibration.baseValues), digits (integer)
 * Output:  string
 * Example: baseValue(calibration, 'tfr', 2)  // -> '1,50'
 */
function baseValue(calibration, key, digits) {
  return formatNumber(calibration.baseValues[key], digits);
}

export const SLIDERS = Object.freeze([
  {
    key: 'tfrTarget', hashKey: 'tfr', section: 'demography', label: 'Plodnosť (TFR) v cieľovom roku',
    min: 0.8, max: 2.5, step: 0.01, scale: 1, format: value => formatNumber(value, 2),
    tooltip: calibration => `Úhrnná plodnosť – priemerný počet živonarodených detí na jednu ženu. V základnom roku ${baseValue(calibration, 'tfr', 2)}; hranica jednoduchej reprodukcie je približne 2,1. Hodnota sa mení lineárne od základného do cieľového roku.`
  },
  {
    key: 'migrationTarget', hashKey: 'mig', section: 'demography', label: 'Čistá migrácia v cieľovom roku (tis./rok)',
    min: -20, max: 40, step: 0.1, scale: 1, format: value => formatSigned(value, 1),
    tooltip: calibration => `Prisťahovaní mínus vysťahovaní za rok. V základnom roku ${formatSigned(calibration.baseValues.netMigration, 1)} tis. Mení sa lineárne do cieľového roku; vekový profil migrantov je fixný.`
  },
  {
    key: 'targetYear', hashKey: 'ty', section: 'demography', label: 'Rok dosiahnutia cieľov',
    min: 2025, max: 2100, step: 1, scale: 1, format: value => String(value),
    tooltip: () => 'Rok, v ktorom plodnosť a čistá migrácia dosiahnu nastavené cieľové hodnoty. Potom zostávajú konštantné.'
  },
  {
    key: 'e0MaleTarget', hashKey: 'e0m', section: 'mortality', label: 'Stredná dĺžka života mužov v r. 2100',
    min: 70, max: 92, step: 0.1, scale: 1, format: value => formatNumber(value, 1) + ' r.',
    tooltip: calibration => `Stredná dĺžka života pri narodení v roku 2100. V základnom roku ${baseValue(calibration, 'e0Male', 1)} roka. Úmrtnosť klesá podľa modelu Lee-Carter s lineárnym časovým indexom.`
  },
  {
    key: 'e0FemaleTarget', hashKey: 'e0f', section: 'mortality', label: 'Stredná dĺžka života žien v r. 2100',
    min: 76, max: 96, step: 0.1, scale: 1, format: value => formatNumber(value, 1) + ' r.',
    tooltip: calibration => `Stredná dĺžka života pri narodení v roku 2100. V základnom roku ${baseValue(calibration, 'e0Female', 1)} roka. Úmrtnosť klesá podľa modelu Lee-Carter s lineárnym časovým indexom.`
  },
  {
    key: 'retireAgeMale', hashKey: 'ram', section: 'pensions', label: 'Dôchodkový vek mužov',
    min: 58, max: 70, step: 0.5, scale: 1, format: value => formatNumber(value, 1) + ' r.',
    tooltip: calibration => `Dôchodkový vek v základnom roku. Predvolených ${formatNumber(calibration.labour.retireAgeRef.male, 1)} roka je zjednodušenie – skutočný vek závisí od roku narodenia (zákon č. 461/2003 Z. z.). Zmena posúva vekové profily odchodu do dôchodku a ekonomickej aktivity.`
  },
  {
    key: 'retireAgeFemale', hashKey: 'raf', section: 'pensions', label: 'Dôchodkový vek žien',
    min: 58, max: 70, step: 0.5, scale: 1, format: value => formatNumber(value, 1) + ' r.',
    tooltip: calibration => `Dôchodkový vek v základnom roku. Predvolených ${formatNumber(calibration.labour.retireAgeRef.female, 1)} roka je zjednodušenie – u žien závisí aj od počtu vychovaných detí (zákon č. 461/2003 Z. z.).`
  },
  {
    key: 'retireAgeLinkShare', hashKey: 'ral', section: 'pensions', label: 'Naviazanie na e65 (%)',
    min: 0, max: 100, step: 10, scale: 0.01, format: value => formatPercent(value, 0),
    tooltip: () => 'Podiel nárastu strednej dĺžky života v 65 rokoch (priemer mužov a žien), ktorý sa premietne do dôchodkového veku. 0 % = bez naviazania; 100 % = rok navyše v e65 zvýši dôchodkový vek o rok.'
  },
  {
    key: 'unemploymentRate', hashKey: 'u', section: 'labour', label: 'Miera nezamestnanosti (%)',
    min: 2, max: 20, step: 0.1, scale: 1, format: value => formatPercent(value, 1),
    tooltip: calibration => `Podiel nezamestnaných na ekonomicky aktívnych. Vekový profil z VZPS sa v každom roku škáluje tak, aby celková miera zodpovedala nastaveniu. Predvolené ${formatPercent(calibration.defaults.unemploymentRate, 1)}.`
  },
  {
    key: 'womenActivityChange', hashKey: 'wa', section: 'labour', label: 'Aktivita žien 25–45 (zmena, p. b.)',
    min: -20, max: 15, step: 1, scale: 1, format: value => formatSigned(value, 0) + ' p. b.',
    tooltip: calibration => `Posun miery ekonomickej aktivity žien vo veku 25–45 rokov oproti základnému roku (vtedy ${formatPercent(calibration.baseValues.womenActivity25to45, 1)}). Ovplyvňuje ju napr. dostupnosť škôlok a dĺžka rodičovskej.`
  },
  {
    key: 'partTimeRate', hashKey: 'pt', section: 'labour', label: 'Čiastočné úväzky (% pracujúcich)',
    min: 0, max: 30, step: 0.5, scale: 1, format: value => formatPercent(value, 1),
    tooltip: calibration => `Podiel čiastočných úväzkov na pracujúcich (predvolené ${formatPercent(calibration.defaults.partTimeRate, 1)}). V ukazovateli platiteľov sa čiastočný úväzok počíta ako polovica plného – zjednodušenie, nie odvodové pravidlo.`
  },
  {
    key: 'disabilityMultiplier', hashKey: 'dis', section: 'labour', label: 'Invalidita (násobok)',
    min: 0.5, max: 2, step: 0.05, scale: 1, format: value => formatNumber(value, 2) + '×',
    tooltip: () => 'Násobok vekového profilu poberateľov invalidného dôchodku. 1,00 = základný rok.'
  },
  {
    key: 'studyShift', hashKey: 'st', section: 'labour', label: 'Dĺžka štúdia (posun v rokoch)',
    min: -2, max: 2, step: 0.5, scale: 1, format: value => formatSigned(value, 1) + ' r.',
    tooltip: () => 'Posun vekového profilu študentov. +1 = študuje sa o rok dlhšie, −1 = skorší vstup na trh práce.'
  }
]);

/**
 * Scenario presets. `overrides` returns scenario values (model units) given the defaults and calibration.
 */
export const SCENARIOS = Object.freeze([
  { id: 'base', label: 'Základný', description: 'Predvolené predpoklady kalibrácie.', overrides: () => ({}) },
  { id: 'lowFertility', label: 'Nízka plodnosť (TFR 1,2)', description: 'Plodnosť klesne na 1,2 dieťaťa na ženu.', overrides: () => ({ tfrTarget: 1.2 }) },
  { id: 'higherFertility', label: 'Vyššia plodnosť (TFR 1,8)', description: 'Plodnosť stúpne na 1,8 dieťaťa na ženu.', overrides: () => ({ tfrTarget: 1.8 }) },
  { id: 'highMigration', label: 'Vysoká migrácia (+15 tis./rok)', description: 'Čistá migrácia 15 tisíc osôb ročne.', overrides: () => ({ migrationTarget: 15 }) },
  {
    id: 'retirementPlus2', label: 'Dôchodkový vek +2 roky', description: 'Dôchodkový vek mužov aj žien vyšší o 2 roky.',
    overrides: defaults => ({ retireAgeMale: defaults.retireAgeMale + 2, retireAgeFemale: defaults.retireAgeFemale + 2 })
  },
  { id: 'retirementLinked', label: 'Dôchodkový vek naviazaný na e65', description: 'Každý rok navyše v e65 zvýši dôchodkový vek o rok.', overrides: () => ({ retireAgeLinkShare: 1 }) },
  {
    id: 'noImprovement', label: 'Bez zlepšovania úmrtnosti', description: 'Stredná dĺžka života zostane na úrovni základného roka (zaokrúhlené na 0,1 roka).',
    overrides: (defaults, calibration) => ({
      e0MaleTarget: Math.round(calibration.baseValues.e0Male * 10) / 10,
      e0FemaleTarget: Math.round(calibration.baseValues.e0Female * 10) / 10
    })
  }
]);

/**
 * Time-series chart metrics. Each line reads `key` from the simulation series; `factor` rescales it.
 */
export const SERIES_METRICS = Object.freeze([
  {
    id: 'ratio', label: 'Poberatelia na 100 platiteľov', digits: 0, zero: true,
    lines: [{ key: 'recipientsPer100Payers', label: 'Poberatelia na 100 platiteľov', color: '#203564' }]
  },
  {
    id: 'dependency', label: 'Starobná závislosť (65+ na 100 osôb 20–64)', digits: 1, zero: true, benchmarkKey: 'oldAgeDependency',
    lines: [{ key: 'oldAgeDependency', label: 'Model', color: '#D82727' }]
  },
  {
    id: 'population', label: 'Obyvateľstvo (mil.)', digits: 2, zero: false, benchmarkKey: 'total', benchmarkFactor: 0.001,
    lines: [{ key: 'total', label: 'Model', color: '#13B5EA', factor: 0.001 }]
  },
  {
    id: 'payers', label: 'Platitelia a poberatelia (tis.)', digits: 0, zero: true,
    lines: [
      { key: 'payers', label: 'Platitelia', color: '#13B5EA' },
      { key: 'recipients', label: 'Poberatelia', color: '#D82727' }
    ]
  },
  {
    id: 'vital', label: 'Živonarodení a zomretí (tis./rok)', digits: 1, zero: true,
    lines: [
      { key: 'births', label: 'Živonarodení', color: '#37B268' },
      { key: 'deaths', label: 'Zomretí', color: '#58595B' }
    ]
  }
]);
