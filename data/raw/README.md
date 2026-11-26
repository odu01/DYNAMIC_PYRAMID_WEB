# Vstupné dáta na kalibráciu (`data/raw/`)

Sem patria CSV súbory, z ktorých skript `tools/build_data.mjs` vytvorí `data/calibration.json`,
`data/anchors.json` a `data/benchmark.json`. Ak niektorý súbor chýba, skript pre túto zložku ponechá
**predbežný** parametrický profil a označí ju v `calibration.meta.components`. Stav sa zobrazuje na stránke
(odznak v hlavičke) a v metodike (tabuľka „Kalibrácia a zdroje“).

```bash
node tools/build_data.mjs
```

```bash
node tools/audit.mjs
```

Postup: stiahnuť súbory → uložiť pod presnými názvami nižšie → spustiť `build_data` → skontrolovať výpis
a audit → commitnúť `data/*.json` aj CSV súbory (kvôli reprodukovateľnosti).

## Eurostat (formát SDMX-CSV)

V Eurostat Data Browser: otvoriť dataset → upraviť filtre podľa tabuľky → **Download → SDMX-CSV 1.0**
(stačia kódy, popisky nie sú potrebné). Na každú dimenziu nevymenovanú v tabuľke vybrať jednu hodnotu.
Ak má súbor dimenziu s viacerými hodnotami, skript vyberie predvolenú hodnotu (citizen=TOTAL, agedef=COMPLET,
projection=BSL, unit=NR/PC) alebo skončí chybou s názvom dimenzie.

| Súbor | Dataset | Filtre | Povinný |
|---|---|---|---|
| `demo_pjan.csv` | Population on 1 January by age and sex | geo=SK; sex=M,F; age=všetky jednotlivé roky `Y_LT1`…`Y99` a `Y_OPEN`; rok 2024 | áno |
| `demo_mlifetable.csv` | Life table | geo=SK; sex=M,F; indic_de=`PROBDEATH` (voliteľne aj `LIFEXP`); všetky vekové kategórie; roky 1998–2024 (história na odhad Lee-Carter) | áno |
| `demo_fasfr.csv` | Fertility rates by age | geo=SK; age=`Y15`…`Y49`; rok 2024 (alebo posledný dostupný) | áno |
| `lfsa_argan.csv` | Activity rates by sex, age and citizenship (%) | geo=SK; citizen=TOTAL; sex=T,M,F; age=`Y15-19`…`Y70-74` a `Y15-74`; rok 2024 | áno |
| `lfsa_urgan.csv` | Unemployment rates by sex, age and citizenship (%) | ako `lfsa_argan` | áno |
| `lfsa_eppgan.csv` | Part-time employment as percentage of the total employment, by sex, age and citizenship (%) | geo=SK; citizen=TOTAL; sex=T,M,F; dostupné vekové skupiny + `Y15-64`; rok 2024 | odporúčaný |
| `migr_imm1ctz.csv` | Immigration by age, sex and citizenship | geo=SK; citizen=TOTAL; agedef=COMPLET; sex=M,F; jednotlivé roky veku; posledný rok | odporúčaný |
| `migr_emi2.csv` | Emigration by age and sex | geo=SK; agedef=COMPLET; sex=M,F; jednotlivé roky veku; ten istý rok | odporúčaný |
| `proj_23np.csv` | EUROPOP2023: population on 1 January by age, sex and type of projection | geo=SK; projection=BSL; sex=M,F; jednotlivé roky veku; roky 2024–2100 | odporúčaný (porovnanie) |

Poznámky:
- Ak má životná tabuľka posledný jednotlivý vek nižší ako 99 (napr. `Y_GE85`), úmrtnosť sa nad ním
  extrapoluje Gompertzovou krivkou odhadnutou na 20 predchádzajúcich rokoch veku.
- Na odhad b_x (Lee-Carter) je potrebných aspoň 10 rokov histórie; roky 2020–2022 sa vynechávajú.
- Hodnoty `:` (nedostupné/dôverné) skript preskočí; vekové skupiny VZPS sa interpolujú medzi stredmi skupín.

## Jednoduché tabuľky (vlastný export)

Oddeľovač čiarka alebo bodkočiarka, desatinná bodka alebo čiarka, prvý riadok hlavička. Vek: jednotlivý rok
(`63`), interval (`60-64`) alebo otvorený interval (`85+`); pohlavie `M`/`F` (alebo `Z`).

| Súbor | Stĺpce | Zdroj | Povinný |
|---|---|---|---|
| `sp_poberatelia.csv` | `age,sex,old_age,early,disability` – počty **osôb** poberajúcich starobný, predčasný a invalidný dôchodok (sólo aj v súbehe s pozostalostným), k 31. 12. predchádzajúceho alebo k 1. 1. základného roka | Sociálna poisťovňa – štatistiky dôchodkov podľa veku | áno |
| `students.csv` | `age,sex,share` – podiel študentov dennej formy na **celom** obyvateľstve daného veku (0–1 alebo %); skript ho prepočíta na podiel medzi osobami, ktoré nie sú starobní ani invalidní dôchodcovia | ŠÚ SR / CVTI SR (počet študentov podľa veku ÷ obyvateľstvo) | nie |
| `sick.csv` | `age,sex,share` – priemerný podiel zamestnaných na PN | Sociálna poisťovňa (priemerné percento PN podľa veku) | nie |
| `parameters.csv` | `key,value,source` – jednotlivé parametre (pozri nižšie) | podľa parametra | nie |

Kľúče v `parameters.csv` (každý je voliteľný a prepíše predvolenú hodnotu):

| key | význam | príklad |
|---|---|---|
| `retire_age_ref_male`, `retire_age_ref_female` | dôchodkový vek v základnom roku (pre ženy bez detí, resp. priemer) | `63.5` |
| `e0_male_target`, `e0_female_target` | stredná dĺžka života pri narodení v roku 2100 (napr. z predpokladov EUROPOP2023) | `84.6` |
| `tfr_target`, `migration_target`, `target_year` | predvolené ciele základného scenára | `1.6`, `5`, `2060` |
| `unemployment_rate`, `part_time_rate` | agregátna miera nezamestnanosti a podiel čiastočných úväzkov (%), ak sa nemajú brať z VZPS | `5.3` |
| `sex_ratio_male_share` | podiel chlapcov medzi živonarodenými | `0.514` |
| `maternity_leave_weeks` | dĺžka materskej v týždňoch | `34` |
| `parental_home_share` | podiel matiek detí od 34 týždňov do 3 rokov, ktoré sú doma a nepracujú (0–1 alebo %); predvolená hodnota posuvníka „Rodičovská: matky doma“ | `0.75` |
| `parental_recipients_not_working` | počet **osôb** poberajúcich rodičovský príspevok, ktoré nepracujú; skript z neho dopočíta podiel matiek doma tak, aby model mal rovnaký počet osôb na rodičovskej (má prednosť pred `parental_home_share`) | `95000` |

Rodičovský príspevok: zdroj je ÚPSVaR (štatistiky rodičovského príspevku). Ak sa počet poberateľov, ktorí nepracujú,
nepublikuje, treba ho vyžiadať alebo odhadnúť; celkový počet poberateľov zahŕňa aj pracujúcich a otcov. Model
predpokladá, že rodičovská je vo VZPS neaktivita (overiť s ŠÚ SR). Bez týchto údajov zostáva predbežných 80 % matiek doma.

## Kontrola

`node tools/test_pipeline.mjs` overí spracovanie na syntetických súboroch v rovnakých formátoch (bez potreby
skutočných dát). Po nahratí skutočných súborov vypíše `build_data` zdroj a rok každej zložky a `audit`
porovná základný rok so štatistikami (napr. materskú s počtom poberateľov materského zo Sociálnej poisťovne,
ktorý zahŕňa aj otcov, a rodičovskú s počtom poberateľov rodičovského príspevku z ÚPSVaR).
