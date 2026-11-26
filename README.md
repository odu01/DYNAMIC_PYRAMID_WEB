# DYNAMIC_PYRAMID — Interaktívny populačný edukátor RRZ

Dynamická populačná pyramída Slovenska s rozdelením obyvateľstva podľa stavu na trhu práce a s projekciou
do roku 2100. Statická webová stránka bez build kroku, určená na GitHub Pages.

- **Web:** https://odu01.github.io/DYNAMIC_PYRAMID_WEB/
- **Metodika, zdroje a obmedzenia:** `metodika.html` (na webe odkaz „Metodika“)
- **Stav kalibrácie:** predbežná – vstupy sú parametrické odhady, kým sa do `data/raw/` nenahrajú oficiálne
  dáta (pozri [`data/raw/README.md`](data/raw/README.md)). Stránka stav zobrazuje v hlavičke.

## Čo nástroj robí

- Kohortno-komponentná projekcia (vek 0–99 a 100+, muži a ženy, ročný krok) so zlepšovaním úmrtnosti
  podľa Lee-Cartera, trajektóriami plodnosti a migrácie a voliteľným naviazaním dôchodkového veku na e65.
- Rozdelenie každej kohorty do 10 stavov na trhu práce vrátane PN, materskej a rodičovskej (matky malých
  detí sú ukotvené na počet detí vo veku 0–2 v pyramíde).
- Ukazovatele: *poberatelia na 100 platiteľov*, *demografická závislosť starších* (65+ na 100 osôb 20–64),
  *ekonomická závislosť starších* (starobní dôchodcovia na 100 platiteľov) a *celková ekonomická závislosť*
  (všetci okrem platiteľov vrátane detí na 100 platiteľov). Platitelia = plné úväzky + polovica čiastočných.
- 14 posuvníkov (aj úroveň aktivity žien 25–45 a podiel matiek doma na rodičovskej) a 8 scenárov, zdieľateľný
  odkaz (stav v URL), prehrávanie rokov, export PNG/SVG/CSV, porovnanie s projekciou Eurostatu EUROPOP2023
  (po nahratí dát).

## Spustenie lokálne

ES moduly a Web Worker nefungujú pri otvorení súboru cez `file://`, stránku treba spustiť cez webový server:

```bash
python3 -m http.server 8000
```

Potom otvoriť http://localhost:8000.

## Štruktúra

| Súbor | Obsah |
|---|---|
| `index.html`, `style.css` | stránka simulátora, svetlý vizuál RRZ |
| `app.js` | ovládanie stránky: dáta, posuvníky, scenáre, URL hash, export, vykresľovanie |
| `config.js` | definície posuvníkov, scenárov, stavov trhu práce a grafov |
| `model.js` | demografický model a trh práce (čisté funkcie, beží v prehliadači aj v Node) |
| `worker.js` | Web Worker, ktorý spúšťa simuláciu mimo hlavného vlákna |
| `plot.js`, `format.js` | grafy (Observable Plot) a formátovanie čísel sk-SK |
| `metodika.html`, `metodika.js` | metodika so vzorcami (KaTeX) a živou tabuľkou stavu kalibrácie |
| `data/anchors.json` | obyvateľstvo v základnom roku |
| `data/calibration.json` | úmrtnosť, plodnosť, migrácia, profily trhu práce, predvolené hodnoty, stav zdrojov |
| `data/raw/` | vstupné CSV na kalibráciu a ich špecifikácia |
| `tools/` | `build_data.mjs` (CSV → JSON), `audit.mjs`, `test_pipeline.mjs`, `e2e.mjs` |
| `vendor/` | fixné verzie knižníc d3 7.9.0, Observable Plot 0.6.17, KaTeX 0.18.11 |
| `assets/logo-rrz.svg` | orezaná kópia `Logo.svg` pre hlavičku |

## Dáta a kalibrácia

Oficiálne CSV (Eurostat, Sociálna poisťovňa, prípadne parametre z ÚPSVaR) sa uložia do `data/raw/` podľa [`data/raw/README.md`](data/raw/README.md)
a skript vygeneruje nové JSON súbory:

```bash
node tools/build_data.mjs
```

## Overenie

Numerický audit (invarianty modelu a porovnanie základného roka so štatistikami):

```bash
node tools/audit.mjs
```

Test spracovania CSV na syntetických dátach:

```bash
node tools/test_pipeline.mjs
```

Test stránky v prehliadači (Playwright, desktop aj mobil):

```bash
node tools/e2e.mjs
```

## Zverejnenie na GitHub Pages

Settings → Pages → *Deploy from a branch* → vetva `main`, priečinok `/ (root)`. Súbor `.nojekyll` vypína
spracovanie Jekyllom, takže sa súbory zverejnia bez zmeny.
