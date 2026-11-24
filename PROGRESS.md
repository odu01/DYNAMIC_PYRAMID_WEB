# RRZ Interaktívny populačný edukátor — Aktuálny stav

Stav k 11/2026 (po audite, oprave chýb a prechode na svetlý vizuál RRZ). Podrobná metodika je v `metodika.html`.

## Architektúra

```
index.html        — stránka simulátora (bez inline skriptu)
style.css         — svetlý vizuál RRZ + metodická stránka, responzívny layout
app.js            — ovládač: načítanie dát, posuvníky, scenáre, URL hash, export, vykresľovanie
config.js         — posuvníky, scenáre, stavy trhu práce, metriky časových radov
model.js          — kohortno-komponentný model + Lee-Carter + alokácia trhu práce (čisté funkcie)
worker.js         — Web Worker (init s kalibráciou, simulate → result)
plot.js           — pyramída, časový rad, skladanie SVG na export (Observable Plot 0.6.17)
format.js         — formátovanie čísel sk-SK
metodika.html/.js — metodika so vzorcami (KaTeX) a tabuľkou stavu kalibrácie
data/anchors.json — obyvateľstvo k 1. 1. 2024 (predbežné: 5-ročné skupiny rozdelené rovnomerne)
data/calibration.json — vstupy modelu + meta (stav a zdroj každej zložky)
data/raw/         — vstupné CSV + README so špecifikáciou
tools/            — build_data.mjs, audit.mjs, test_pipeline.mjs, e2e.mjs
vendor/           — d3 7.9.0, Observable Plot 0.6.17, KaTeX 0.18.11 (bez CDN)
```

Worker API: `{type:'init', calibration}`, potom `{type:'simulate', requestId, startPopulation, scenario, startYear, endYear}`
→ `{type:'result', requestId, result:{years, snapshots, states, series}}`. Staršie odpovede (nižšie `requestId`) sa ignorujú.

## Simulačný model

### Demografia (ročný krok, vek 0–99 + 100+)
- Prežívanie z úmrtnostnej tabuľky: `L_{x+1}/L_x`, otvorený interval `T_100/T_99`, novorodenci `L_0/l_0` (a₀ = 0,1).
- Pôrody z priemernej expozície žien `(F_x(t) + F_x(t+1))/2`, podiel chlapcov 0,512.
- Úmrtnosť: Lee-Carter `ln m_{x,t} = a_x + b_x k_t`, `k_t` lineárne, `k_2100` nájdené bisekciou podľa cieľového e0.
- Plodnosť a čistá migrácia: lineárne k cieľu do zvoleného roka, potom konštantné.
- Migrácia: `M_x = (N + E)·ι_x − E·ε_x` (vysťahovanie fixné, zmena cez prisťahovanie).
- Horizont 2024–2100.

### Trh práce (8 stavov, podmienené členenie)
Deti < 15 → dôchodcovia `r(x')` → invalidní `d(x')·násobok` → študenti `s(x − posun)` → aktívni `a(x')`
(+ posun žien 25–45) / neaktívni → nezamestnaní `u(x)·λ_U` → PN + materská (PN + ASFR × 34/52) → čiastočné
úväzky `π(x)·λ_P` / plné. `λ_U`, `λ_P` sa v každom roku nastavia tak, aby agregáty zodpovedali posuvníkom.
Zmena dôchodkového veku: posun profilov v pásme 5 rokov pred dôchodkovým vekom, natiahnutie medzi 50 rokmi a týmto pásmom.

| Stav | Kód | Farba |
|------|-----|-------|
| Zamestnaný (plný úväzok) | EMP_FULL | #13B5EA |
| Čiastočný úväzok | EMP_PART | #3657A7 |
| Deti a študenti | STUDENT | #DCB47B |
| Neaktívny | INACTIVE | #58595B |
| Nezamestnaný | UNEMP | #9C479B |
| PN / materská | SICK_MAT | #37B268 |
| Invalidný dôchodca | DISAB | #997468 |
| Starobný dôchodca | RETIRED | #D82727 |

Platitelia = EMP_FULL + 0,5 × EMP_PART; poberatelia = UNEMP + SICK_MAT + DISAB + RETIRED.

## UI

- Desktop: hlavička (logo RRZ, názov, odznak kalibrácie, Metodika) | ľavý panel predpokladov | stred (upozornenie,
  rok + prehrávanie + posuvník rokov, Zdieľať, Export, EUROPOP2023, 3 KPI, pyramída s legendou, časový vývoj) | pravý panel štatistík.
- ≤ 1100 px: jeden stĺpec, predpoklady a štatistiky cez tlačidlá; ≤ 640 px: kratší názov, 2-stĺpcové KPI.
- KPI: poberatelia na 100 platiteľov (farba voči roku 2024 pri predvolených predpokladoch), starobná závislosť, obyvateľstvo.
- Pyramída: 5-ročné skupiny, pevná os x pre celý horizont, tooltip so stavom a podielom vo vekovej skupine,
  legenda ako prepínače (aria-pressed), voliteľne značky EUROPOP2023.
- Časový vývoj: poberatelia na 100 platiteľov, starobná závislosť, obyvateľstvo, platitelia a poberatelia, pôrody a úmrtia.
- Prístupnosť: labely posuvníkov, aria-valuetext, tooltipy cez aria-describedby, kontrast textu WCAG AA, skip link.

## Posuvníky (predvolené hodnoty z `data/calibration.json`)

| Sekcia | Posuvník | Kľúč v URL | Predvolené | Rozsah | Krok |
|---|---|---|---|---|---|
| Plodnosť a migrácia | TFR v cieľovom roku | `tfr` | 1,50 | 0,8–2,5 | 0,01 |
| | Čistá migrácia v cieľovom roku (tis./rok) | `mig` | +1,0 | −20–40 | 0,1 |
| | Rok dosiahnutia cieľov | `ty` | 2050 | 2025–2100 | 1 |
| Úmrtnosť | e0 mužov v r. 2100 | `e0m` | 84,0 | 70–92 | 0,1 |
| | e0 žien v r. 2100 | `e0f` | 88,5 | 76–96 | 0,1 |
| Dôchodkový vek | muži / ženy | `ram` / `raf` | 63 / 63 | 58–70 | 0,5 |
| | Naviazanie na e65 (%) | `ral` | 0 | 0–100 | 10 |
| Trh práce | Miera nezamestnanosti (%) | `u` | 5,3 | 2–20 | 0,1 |
| | Aktivita žien 25–45 (zmena, p. b.) | `wa` | 0 | −20–15 | 1 |
| | Čiastočné úväzky (%) | `pt` | 3,5 | 0–30 | 0,5 |
| | Invalidita (násobok) | `dis` | 1,00 | 0,5–2 | 0,05 |
| | Dĺžka štúdia (posun v rokoch) | `st` | 0 | −2–2 | 0,5 |

Ďalšie kľúče v URL: `y` (rok), `m` (metrika časového radu), `b=1` (EUROPOP2023), `h` (skryté stavy, indexy oddelené bodkou).
Scenáre: Základný, Nízka plodnosť (1,2), Vyššia plodnosť (1,8), Vysoká migrácia (+15 tis.), Dôchodkový vek +2,
Naviazanie na e65 (100 %), Bez zlepšovania úmrtnosti.

## Export

PNG (2×) a SVG pyramídy s názvom, scenárom, legendou a zdrojom; CSV časových radov (ASCII hlavičky, desatinná
bodka, parametre scenára ako stĺpce `param_*`) a CSV pyramídy zvoleného roka podľa jednotlivých rokov veku a stavov.

## Kalibrácia (stav)

Všetky zložky sú zatiaľ **predbežné** (parametrické). Po nahratí CSV do `data/raw/` a spustení
`node tools/build_data.mjs` sa nahradia; stránka a metodika zobrazia zdroj a rok každej zložky.
Audit základného roka (predbežné dáta): e0 73,9 / 80,6; zamestnanosť 15–64 v koncepte VZPS ≈ 70,6 %;
invalidní ≈ 235 tis.; starobní dôchodcovia ≈ 1,17 mil.; zomretí 61,9 tis. (vyššie než skutočnosť) – úrovne sú ilustračné.

## Overenie

- `tools/audit.mjs`: súčet stavov = populácia, bilancia populácie, otvorený interval, cieľové e0, agregáty, smery účinkov.
- `tools/test_pipeline.mjs`: syntetické SDMX-CSV → `build_data` → porovnanie (vrátane odhadu Lee-Carter b_x).
- `tools/e2e.mjs`: Playwright (desktop 1440×900, iPhone 13, metodika), exporty, URL hash, konzola bez chýb.

## Zmeny oproti predchádzajúcej verzii

- Opravené poprehadzované súbory; doplnený `worker.js` a `data/anchors.json`.
- Opravené: NaN v PN/materskej, vymieranie 100+, konštantná úmrtnosť, dvojité odčítanie aktivity, aktivita žien
  aplikovaná na všetky veky, podhodnotená invalidita, rovnaká nezamestnanosť vo všetkých vekových skupinách,
  priemerný vek bez +0,5, farebné prahy pomeru, desatinná bodka, chýbajúce prekreslenie pri zmene okna.
- Vizuál: tmavá téma nahradená svetlou podľa rrz.sk, plné logo RRZ.
- Nové: Lee-Carter, trajektórie TFR a migrácie, naviazanie dôchodkového veku na e65, scenáre, URL hash, export,
  časový vývoj, benchmark EUROPOP2023 (čaká na dáta), metodická stránka, dátový pipeline a testy.
- Horizont skrátený z 2150 na 2100; multiplikátory úmrtnosti nahradené cieľovým e0 v roku 2100;
  „Aktivita žien 25–45“ je teraz zmena v p. b. oproti základnému roku.

## Ďalšie kroky (mimo aktuálneho rozsahu)

- Nahrať oficiálne CSV a prekalibrovať (blokuje úrovne výsledkov).
- Fiškálny modul (odvody a výdavky na dôchodky v % HDP), stochastické projekcie (intervaly neistoty), regionálne členenie.
