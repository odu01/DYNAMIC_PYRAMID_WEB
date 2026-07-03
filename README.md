# RRZ Interaktívny populačný simulátor — Aktuálny stav

## Architektúra

```
index.html        — App shell, UI, event handling (inline <script type="module">)
model.js          — Cohort-component Leslie matrix model + waterfall labor allocation
worker.js         — Web Worker: off-thread simulation + labor state computation
plot.js           — Observable Plot 0.6.x pyramid rendering + legend
style.css         — RRZ korporátna dark téma, responsive layout
data/anchors.json — SK 2024 reálne demografické dáta (Eurostat/UN)
```

### Závislosti (CDN)
- D3 v7 — `cdn.jsdelivr.net/npm/d3@7`
- Observable Plot 0.6.x — `cdn.jsdelivr.net/npm/@observablehq/plot@0.6`
- Inter font — Google Fonts

### Kľúčové exporty
- `model.js` → `buildFertilityProfile`, `buildMigrationProfile`, `stepPopulation`, `runSimulation`, `allocateCohort`, `computeAllStates`
- `plot.js` → `renderPyramid`, `formatPopulation`, `buildLegendHTML`
- `worker.js` → Web Worker (postMessage API: `{type:'simulate', params, laborParams, startPop, startYear, endYear}`)

## Simulačný model

### Demografická projekcia
- **Metóda:** Cohort-component Leslie matrix: P(t+1) = L(θ)·P(t) + M
- **Kohorty:** 101 (vek 0–100), muži + ženy, jednotky: tisíce
- **Fertilita:** Beta(3,4) ASFR profil, peak ~28 rokov, škálovanie podľa TFR
- **Mortalita:** Gompertz-Makeham po veku 40, kalibrovaná na SK 2024 life tables
  - Muži: `qx = 0.0020 × exp(0.095 × (vek − 40))`, e0 ≈ 74.4
  - Ženy: `qx = 0.0012 × exp(0.092 × (vek − 40))`, e0 ≈ 81.0
  - Kojenecká úmrtnosť: muži 5‰, ženy 4‰ (SK 2024)
- **Migrácia:** Gaussovský profil (peak 27 rokov, rozpätie 0–60)
- **Horizont:** 2024–2150
- **Výpočet:** Web Worker (off-thread, neblokuje UI)

### Trh práce (waterfall alokácia)
8 interných stavov vizualizovaných v pyramíde:

| Stav | Kód | Farba | Hex |
|------|-----|-------|-----|
| Zamestnaný (plný) | EMP_FULL | Korporátna modrá | #13B5EA |
| Čiastočný úväzok | EMP_PART | Tmavo modrá | #3657A7 |
| Nezaopatrené deti | STUDENT | Korporátna zlatá | #DCB47B |
| Neaktívny | INACTIVE | Korporátna sivá | #58595B |
| Nezamestnaný | UNEMP | Fialová | #9C479B |
| PN / Materská | SICK_MAT | Zelená | #37B268 |
| Invalidný | DISAB | Hnedá | #997468 |
| Dôchodca | RETIRED | Červená | #D82727 |

**Waterfall poradie:** Deti (0–14) → Dôchodcovia → Študenti (15–26) → Invalidní → Neaktívni → Nezamestnaní → PN/Materská → Čiastočný/Plný úväzok

**Support Ratio** = (EMP_FULL + 0.5 × EMP_PART) / (UNEMP + SICK_MAT + DISAB + RETIRED)

**Kategória "Nezaopatrené deti"** = zlúčené deti (0–14, 100 % STUDENT) + študenti (15–26, klesajúca miera)

## Vizualizácia

- Stacked horizontal bar pyramída (Observable Plot 0.6.x)
- ♂ Muži / ♀ Ženy piktogramy v grafe
- 5-ročné vekové biny (0–4, 5–9, ..., 100+)
- Os X: label `tis. osôb` (bez šípky, `labelArrow: 'none'`)
- Tooltips: počet + % kohorty z celku
- Interaktívna legenda — klik skryje/zobrazí kategóriu
- Osi: semi-bold 13px, tick format `tis.` / `m` (milióny)

## UI/UX

### Desktop layout (>1024px)
- 3-stĺpcový CSS Grid: sidebar 272px | main 1fr | stats 216px
- Header: `RRZ | INTERAKTÍVNY POPULAČNÝ SIMULÁTOR` (bold 1.05rem), bez roku v headeri
- Ľavý panel: compact view — párové slidre (Úmrtnosť ♂/♀, Dôch. vek ♂/♀) vedľa seba v `.slider-pair` gride
- Vizuálne oddelenie sekcií (Demografia / Pracovný trh) tenkou border čiarou
- Minimalizované vertikálne medzery pre zobrazenie bez skrolovania
- Pravý panel: 9 stat kariet (grid layout: label | value | detail)
- Top-bar: rok display + Reset button + support ratio KPI + year slider
- Year slider: luxusný dizajn — zlatý kovový gradient track (16px), 32px thumb s tmavým vnútrom a zlatým okrajom

### Tablet layout (≤1200px)
- Sidebar 244px, stats 196px

### Mobile layout (≤1024px)
- Jednostĺpcový grid (`grid-template-rows: auto`, `height: auto`)
- Slider panel skrytý (`display: none`), otvorenie cez "Nastavenia" toggle
- Slider content: 2-stĺpcový grid
- Stats collapsible cez "Štatistiky" toggle, grid layout
- Year slider: 14px track, 28px thumb
- Kompaktné medzery (main padding 4px 10px, top-bar gap 3px)

### Malý mobile (≤640px)
- Slider content: 1-stĺpcový grid
- Pyramída: 48vh (min 240px, max 440px)
- Touch-friendly: 20px slider thumb, 20px tooltip ikony
- Tooltip: fixed sheet na spodku obrazovky
- iOS: `padding-bottom: env(safe-area-inset-bottom)`

## Korporátne farby RRZ

Celá aplikácia používa výhradne korporátnu paletu:

| Názov | Hex | Použitie |
|-------|-----|----------|
| Korporátna modrá | #13B5EA | EMP_FULL |
| Korporátna zlatá | #DCB47B | Akcent (slidre, hodnoty), STUDENT |
| Korporátna sivá | #58595B | INACTIVE |
| Tmavo modrá | #3657A7 | EMP_PART |
| Hnedá | #997468 | DISAB |
| Fialová | #9C479B | UNEMP |
| Červená | #D82727 | RETIRED, ratio-red |
| Zelená | #37B268 | SICK_MAT, ratio-green |

**Ďalšie farby UI:**
- Body pozadie: #152343
- Header pozadie: #203564
- Surface (panely): #1e293b
- Surface light: #273548
- Border: #334155
- Text: #cbd5e1 (primárny #f1f5f9, sekundárny #64748b)
- Accent gold: #e2a553

## Slidre s SK 2024 defaultmi

**Demografia:**
| Parameter | ID | Default | Rozsah | Krok |
|-----------|-----|---------|--------|------|
| TFR (plodnosť) | slTfr | 1.5 | 0.5–5.0 | 0.1 |
| Sex ratio | slSexRatio | 0.512 | 0.480–0.540 | 0.001 |
| Úmrtnosť ♂ (×) | slMortMale | 1.00 | 0.50–2.00 | 0.05 |
| Úmrtnosť ♀ (×) | slMortFemale | 1.00 | 0.50–2.00 | 0.05 |
| Migrácia (tis./rok) | slMigration | 1 | −50–50 | 1 |

**Pracovný trh:**
| Parameter | ID | Default | Rozsah | Krok |
|-----------|-----|---------|--------|------|
| Dôch. vek ♂ | slRetireMale | 63 | 60–70 | 1 |
| Dôch. vek ♀ | slRetireFemale | 63 | 57–70 | 1 |
| Nezamestnanosť | slUnemployment | 5.0% | 2–25 | 0.5 |
| Aktivita žien 25–45 | slWomenActivity | 75% | 50–95 | 1 |
| Čiastočné úväzky | slPartTime | 4% | 0–50 | 1 |
| Invalidita (×) | slDisability | 1.0 | 0.5–3.0 | 0.1 |
| Dĺžka štúdia | slStudyShift | 0 | −2–2 | 0.5 |

**Reset button** — viditeľný na desktop aj mobile, obnoví všetky slidre na SK 2024 default hodnoty.

## Štatistiky (pravý panel / collapsible na mobile)

| Stat | ID | Formát |
|------|----|--------|
| Celková populácia | statTotalPop | X tis. / X.XX mil. |
| Muži | statMalePop | X tis. |
| Ženy | statFemalePop | X tis. |
| Priemerný vek | statMedianAge | X.X rokov |
| Platitelia | statPayers + statPayersDetail | X tis. (X.X % populácie) |
| Prijímatelia | statRecipients + statRecipientsDetail | X tis. (X.X % populácie) |
| Deti (0–19) | statChildren | X tis. |
| Produktívny vek (20–64) | statWorking | X tis. |
| Seniori (65+) | statSeniors | X tis. |

Stat karty: CSS grid (3 stĺpce: label 1fr | value auto | detail auto), `min-height: 28px`.

## Optimalizácie

- **Web Worker:** simulácia + labor allocation off-thread
- **Pre-computed profily:** fertilita a migrácia vypočítané 1× na simuláciu (nie 126×)
- **Buffer reuse:** `allocateCohort` používa caller-provided Float64Array (0 alokácií v hot path)
- **Cached konštanty:** AGE_LABELS, STACK_ORDER ako module-level
- **DOM caching:** všetky stat elementy, slidre a value displeje cachované pri init
- **Year slider:** žiadna simulácia — len index do pre-computed snapshots (<16ms)
- **Param slidre:** debounce 100ms → worker recompute
- **computeAllStates:** loop-copy namiesto 8 individuálnych priradení
- **Dáta:** anchors.json obsahuje len rok 2024 (historické 1950/1980/2000 odstránené)

## Kódová štruktúra

| Súbor | Riadky | Popis |
|-------|--------|-------|
| style.css | ~796 | Kompletný styling + responsive (3 breakpointy) |
| index.html | ~460 | HTML + inline JS modul |
| plot.js | ~171 | Vizualizácia pyramídy + legenda |
| model.js | ~234 | Simulačný engine + labor alokácia |
| worker.js | ~47 | Worker wrapper |
| **Spolu** | **~1708** | |

## Odstránené funkcie
- Anchor tlačidlá (1950/1980/2000) — iba rok 2024
- M/F compare pohľad
- Populácia pohľad (toggle Populácia/Trh práce)
- Support ratio time-series graf
- Vývoj populácie time-series graf
- SVG logo (nahradené textovým nadpisom)
- Rok v headeri (yearDisplayHeader) — zobrazený len v main content
- header-controls div — odstránený (bol prázdny po odstránení roku)
- data/initial_1950.json — nikdy referencovaný v kóde
- Historické anchor dáta (1950, 1980, 2000) z anchors.json
- Redundantný `sl` alias pre `sliders` objekt
