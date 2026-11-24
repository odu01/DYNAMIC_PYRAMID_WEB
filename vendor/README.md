# Vendored libraries

Pinned third-party libraries served with the page (no runtime CDN dependency).
Fetched with `npm pack <package>@<version>`; files copied unmodified from `dist/`.

| Library | Version | Files | License |
|---|---|---|---|
| d3 | 7.9.0 | `d3/d3.min.js` | ISC (`d3/LICENSE`) |
| @observablehq/plot | 0.6.17 | `plot/plot.umd.min.js` (expects global `d3`) | ISC (`plot/LICENSE`) |
| katex | 0.18.11 | `katex/katex.min.{js,css}`, `katex/contrib/auto-render.min.js`, `katex/fonts/*.woff2` | MIT (`katex/LICENSE`) |

KaTeX: only the `.woff2` fonts are kept; every current browser loads the first
(`woff2`) source in `katex.min.css`, so the `.woff`/`.ttf` fallbacks are not needed.

To upgrade: `npm pack <package>@<new-version>`, replace the files, update this table.
