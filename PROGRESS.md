# RRZ Interaktívny populačný edukátor — Aktuálny stav

Stav k 11/2026: po audite, oprave chýb a prechode na svetlý vizuál RRZ; v druhom kole úroveň aktivity žien,
oddelená materská a nová rodičovská a indexy ekonomickej závislosti. Podrobná metodika je v `metodika.html`.

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
data/calibration.json — vstupy modelu + meta (stav a zdroj každej zložky, schemaVersion 2)
data/raw/         — vstupné CSV + README so špecifikáciou
tools/            — build_data.mjs, audit.mjs, test_pipeline.mjs, e2e.mjs
vendor/           — d3 7.9.0, Observable Plot 0.6.17, KaTeX 0.18.11 (bez CDN)
```

Worker API: `{type:'init', calibration}`, potom `{type:'simulate', requestId, startPopulation, scenario, startYear, endYear}`
→ `{type:'result', requestId, result:{years, snapshots, states, series, womenActivityFit}}`. `womenActivityFit`
= `{target, achieved, minimum, maximum, shift, attainable}` (úroveň aktivity žien v %). Staršie odpovede
(nižšie `requestId`) sa ignorujú. Pri štarte stránka overí `calibration.meta.schemaVersion` a zhodu stavov;
pri nesúlade (stará kalibrácia v cache) vyzve na obnovenie stránky.

## Simulačný model

### Demografia (ročný krok, vek 0–99 + 100+)
- Prežívanie z úmrtnostnej tabuľky: `L_{x+1}/L_x`, otvorený interval `T_100/T_99`, novorodenci `L_0/l_0` (a₀ = 0,1).
- Pôrody z priemernej expozície žien `(F_x(t) + F_x(t+1))/2`, podiel chlapcov 0,512.
- Úmrtnosť: Lee-Carter `ln m_{x,t} = a_x + b_x k_t`, `k_t` lineárne, `k_2100` nájdené bisekciou podľa cieľového e0.
- Plodnosť a čistá migrácia: lineárne k cieľu do zvoleného roka, potom konštantné.
- Migrácia: `M_x = (N + E)·ι_x − E·ε_x` (vysťahovanie fixné, zmena cez prisťahovanie).
- Horizont 2024–2100.

### Trh práce (10 stavov, podmienené členenie)
Deti < 15 → dôchodcovia `r(x')` → invalidní `d(x')·násobok` → študenti `s(x − posun)` → matky malých detí →
aktívni `a(x')` (+ posun žien 25–45) / neaktívni → nezamestnaní `u(x)·λ_U` → materská → PN `p(x)` →
čiastočné úväzky `π(x)·λ_P` / plné.

- **Matky** sú ukotvené na deti vo veku 0–2 v pyramíde: deti sa priradia matkám podľa vekového profilu
  plodnosti. Matky detí do 34 týždňov: zamestnané → materská, nezamestnané a neaktívne → rodičovská.
  Matky detí od 34 týždňov do 3 rokov: podiel θ je doma (rodičovská), ostatné pracujú.
- `λ_U`, `λ_P` sa v každom roku nájdu bisekciou, takže agregátna nezamestnanosť a podiel čiastočných úväzkov
  presne zodpovedajú posuvníkom aj pri stropoch (0,95 a 1).
- **Aktivita žien 25–45** sa počíta v koncepte VZPS (pracujúce vrátane PN a materskej + nezamestnané
  + 10 % študentiek + 30 % invalidných dôchodkýň; rodičovská je neaktivita). Posuvník nastaví úroveň v roku 2024:
  posun `Δ_w` sa nájde bisekciou raz na populácii 2024 s predvolenými ostatnými posuvníkmi a drží sa vo všetkých rokoch.
- Zmena dôchodkového veku: posun profilov v pásme 5 rokov pred dôchodkovým vekom, natiahnutie medzi 50 rokmi a týmto pásmom.

| Stav | Kód v modeli | Kód v URL | Stĺpec CSV | Farba |
|------|-----|-----|-----|-------|
| Zamestnaný (plný úväzok) | EMP_FULL | `plny` | `zam_plny_tis` | #13B5EA |
| Čiastočný úväzok | EMP_PART | `ciast` | `zam_ciastocny_tis` | #3657A7 |
| Deti a študenti | STUDENT | `stud` | `deti_studenti_tis` | #DCB47B |
| Neaktívny (ostatní) | INACTIVE | `neakt` | `neaktivni_tis` | #58595B |
| Nezamestnaný | UNEMP | `nezam` | `nezamestnani_tis` | #9C479B |
| PN | SICK | `pn` | `pn_tis` | #37B268 |
| Materská | MATERNITY | `mat` | `materska_tis` | #A5DCBB |
| Rodičovská (doma) | PARENTAL | `rod` | `rodicovska_tis` | #BF87BE |
| Invalidný dôchodca | DISAB | `inv` | `invalidni_tis` | #997468 |
| Starobný dôchodca | RETIRED | `star` | `starobni_dochodcovia_tis` | #D82727 |

### Ukazovatele
- Platitelia = EMP_FULL + 0,5 × EMP_PART (prepočet); poberatelia = UNEMP + SICK + MATERNITY + PARENTAL + DISAB + RETIRED.
- Poberatelia na 100 platiteľov; demografická závislosť starších = 100 · 65+ / 20–64;
  ekonomická závislosť starších = 100 · RETIRED / platitelia (nie ukazovateľ EK, ktorý delí neaktívnych 65+
  zamestnanými 20–64); celková ekonomická závislosť = 100 · (obyvateľstvo − platitelia) / platitelia.

## UI

- Desktop: hlavička (logo RRZ, názov, odznak kalibrácie, Metodika) | ľavý panel predpokladov | stred (upozornenie,
  rok + prehrávanie + posuvník rokov, Zdieľať, Export, EUROPOP2023, 4 KPI, pyramída s popisom a legendou,
  časový vývoj) | pravý panel štatistík.
- ≤ 1320 px: KPI 2 × 2; ≤ 1100 px: jeden stĺpec, predpoklady a štatistiky cez tlačidlá; ≤ 640 px: kratší názov.
- KPI: poberatelia na 100 platiteľov (farba voči roku 2024 pri predvolených predpokladoch), demografická
  závislosť starších, ekonomická závislosť starších, celková ekonomická závislosť; pri každom hodnota roka 2024
  a tlačidlo „i“ s definíciou.
- Nad pyramídou obyvateľstvo zvoleného roka a zmena oproti 2024.
- Pod posuvníkom aktivity žien poznámka so skutočnou hodnotou 2024, ak ju iné posuvníky zmenia.
- Pravý panel: obyvateľstvo, platitelia (prepočítaní), poberatelia, materská, rodičovská, aktivita žien 25–45,
  pohyb v roku, predpoklady.
- Pyramída: 5-ročné skupiny, pevná os x pre celý horizont, tooltip so stavom a podielom vo vekovej skupine,
  legenda ako prepínače (aria-pressed), voliteľne značky EUROPOP2023.
- Časový vývoj: poberatelia na 100 platiteľov, indexy závislosti (3 čiary + EUROPOP2023), obyvateľstvo,
  platitelia a poberatelia, pôrody a úmrtia, aktivita žien 25–45 (s úrovňou 2024), materská a rodičovská.
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
| | Aktivita žien 25–45 v r. 2024 (%) | `wl` | 80,3 | 60–83,9 (maximum z kalibrácie) | 0,1 |
| | Rodičovská: matky doma (%) | `rod` | 80 | 0–100 | 1 |
| | Čiastočné úväzky (%) | `pt` | 3,5 | 0–30 | 0,5 |
| | Invalidita (násobok) | `dis` | 1,00 | 0,5–2 | 0,05 |
| | Dĺžka štúdia (posun v rokoch) | `st` | 0 | −2–2 | 0,5 |

Ďalšie kľúče v URL: `y` (rok), `m` (metrika časového radu), `b=1` (EUROPOP2023), `h` (skryté stavy, kódy
oddelené bodkou, napr. `h=inv.star`). Staré odkazy: číselné `h` sa prevedú podľa pôvodných 8 stavov
(PN/materská → PN aj materská, neaktívny → neaktívny aj rodičovská); `wa` sa ignoruje s upozornením.
Scenáre: Základný, Nízka plodnosť (1,2), Vyššia plodnosť (1,8), Vysoká migrácia (+15 tis.), Dôchodkový vek +2,
Naviazanie na e65 (100 %), Viac pracujúcich matiek (40 % doma), Bez zlepšovania úmrtnosti.

## Export

PNG (2×) a SVG pyramídy s názvom, scenárom, legendou a zdrojom; CSV časových radov (ASCII hlavičky, desatinná
bodka, 10 stavov, stĺpce `starobna_zavislost`, `ekonomicka_zavislost_starsich`, `celkova_ekonomicka_zavislost`,
parametre scenára ako stĺpce `param_*`) a CSV pyramídy zvoleného roka podľa jednotlivých rokov veku a stavov.

## Kalibrácia (stav)

Všetky zložky sú zatiaľ **predbežné** (parametrické), vrátane podielu matiek doma (80 %). Po nahratí CSV do
`data/raw/` a spustení `node tools/build_data.mjs` sa nahradia; stránka a metodika zobrazia zdroj a rok každej zložky.
Audit základného roka 2024 (predbežné dáta, úrovne sú ilustračné):
- e0 73,9 / 80,6; zomretí 61,9 tis. (vyššie než skutočnosť); zamestnanosť 15–64 v koncepte VZPS ≈ 70,5 %;
- invalidní ≈ 235 tis.; starobní dôchodcovia ≈ 1,17 mil.; PN 99,9 tis.; materská 31,2 tis.; rodičovská 107,5 tis.;
- aktivita žien 25–45: 80,3 % (maximum pri predvolených predpokladoch 83,9 %);
- poberatelia na 100 platiteľov 78,8 (predtým 73, bez rodičovskej); demografická závislosť starších 30,6;
  ekonomická závislosť starších 51,8; celková ekonomická závislosť 143,9.

## Overenie

- `tools/audit.mjs`: 24 invariantov – súčet 10 stavov = populácia, materská a rodičovská len u žien, matky = deti 0–2,
  presná nezamestnanosť a čiastočné úväzky (aj pri extrémoch a strmom profile mladých), bilancia populácie,
  cieľové e0, presné dosiahnutie úrovne aktivity žien, reprodukcia `baseValues`, zložkové identity indexov,
  29 behov s extrémami posuvníkov a smery účinkov.
- `tools/test_pipeline.mjs`: syntetické SDMX-CSV → `build_data` → porovnanie (Lee-Carter b_x, reprodukcia skupín
  VZPS s rodičovskou, prepočet študentov, dopočet θ z počtu nepracujúcich poberateľov).
- `tools/e2e.mjs`: Playwright (desktop 1440×900, iPhone 13, metodika) – 14 posuvníkov, 10 položiek legendy,
  4 KPI, úroveň aktivity a rodičovská v odkaze, staré odkazy, 3 indexy v grafe, exporty, konzola bez chýb.

## Zmeny

### Druhé kolo
- „Aktivita žien 25–45“ nastavuje úroveň v % (koncept VZPS) namiesto zmeny v p. b.
- Materská oddelená od PN; nová rodičovská (matky doma) s posuvníkom a scenárom; matky ukotvené na deti 0–2.
- Nové indexy: ekonomická závislosť starších a celková ekonomická závislosť; 4 KPI; nové grafy.
- Presná normalizácia nezamestnanosti a čiastočných úväzkov bisekciou (predtým napr. 29,9 % pri nastavení 30 %).
- Kalibrácia: prevod VZPS na úrovni vekových skupín s korekciou priemerov, prepočet `students.csv`,
  predvolené hodnoty na krokoch posuvníkov, θ z parametra alebo z počtu poberateľov (ÚPSVaR).

### Prvé kolo
- Opravené poprehadzované súbory; doplnený `worker.js` a `data/anchors.json`.
- Opravené: NaN v PN/materskej, vymieranie 100+, konštantná úmrtnosť, dvojité odčítanie aktivity, aktivita žien
  aplikovaná na všetky veky, podhodnotená invalidita, rovnaká nezamestnanosť vo všetkých vekových skupinách,
  priemerný vek bez +0,5, farebné prahy pomeru, desatinná bodka, chýbajúce prekreslenie pri zmene okna.
- Vizuál: tmavá téma nahradená svetlou podľa rrz.sk, plné logo RRZ.
- Nové: Lee-Carter, trajektórie TFR a migrácie, naviazanie dôchodkového veku na e65, scenáre, URL hash, export,
  časový vývoj, benchmark EUROPOP2023 (čaká na dáta), metodická stránka, dátový pipeline a testy.
- Horizont skrátený z 2150 na 2100; multiplikátory úmrtnosti nahradené cieľovým e0 v roku 2100.

## Ďalšie kroky (mimo aktuálneho rozsahu)

- Nahrať oficiálne CSV (vrátane jednotlivých rokov veku 0–4 a údajov ÚPSVaR) a prekalibrovať (blokuje úrovne výsledkov).
- Overiť s ŠÚ SR zaradenie poberateľov rodičovského príspevku vo VZPS.
- Fiškálny modul (odvody a výdavky na dôchodky v % HDP), stochastické projekcie (intervaly neistoty), regionálne členenie.
