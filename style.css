/* style.css — RRZ Populačný simulátor */

@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

:root {
  --sidebar-width: 272px;
  --stats-width: 216px;
  --bg: #152343;
  --surface: #1e293b;
  --surface-light: #273548;
  --text: #cbd5e1;
  --text-primary: #f1f5f9;
  --text-secondary: #64748b;
  --border: #334155;
  --accent: #DCB47B;
  --accent-gold: #e2a553;
  --header-h: 44px;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}

::-webkit-scrollbar { width: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: #475569; }

/* ─── Layout ──────────────────────────────────────────────────────────── */

.app-layout {
  display: grid;
  grid-template-columns: var(--sidebar-width) 1fr var(--stats-width);
  grid-template-rows: var(--header-h) 1fr;
  height: 100vh;
  overflow: hidden;
  max-width: 1800px;
  margin: 0 auto;
}

/* ─── Header ──────────────────────────────────────────────────────────── */

.app-header {
  grid-column: 1 / -1;
  background: #203564;
  border-bottom: 1px solid var(--border);
  padding: 0 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--header-h);
  z-index: 10;
}

.header-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  overflow: hidden;
}

.header-logo {
  height: 34px;
  width: auto;
  flex-shrink: 0;
}

.app-header h1 {
  font-size: 1.05rem;
  font-weight: 800;
  color: var(--text-primary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  white-space: nowrap;
}

.year-display {
  font-size: 1.1rem;
  font-weight: 800;
  color: var(--accent);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

/* ─── Toggle buttons (shared base) ────────────────────────────────────── */

.slider-toggle,
.stats-toggle {
  display: none;
  padding: 6px 14px;
  font-size: 0.74rem;
  font-weight: 600;
  background: var(--surface-light);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-primary);
  white-space: nowrap;
}

.stats-toggle {
  width: 100%;
  text-align: center;
}

.reset-btn {
  display: inline-block;
  padding: 6px 14px;
  font-size: 0.74rem;
  font-weight: 600;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-secondary);
  white-space: nowrap;
  transition: color 0.15s, border-color 0.15s;
}

.reset-btn:hover {
  color: var(--text-primary);
  border-color: var(--accent);
}

/* ─── Slider Panel (left) ─────────────────────────────────────────────── */

.slider-panel {
  background: var(--surface);
  border-right: 1px solid var(--border);
  padding: 8px 10px;
  overflow-y: auto;
  min-height: 0;
  height: 100%;
}

.slider-section {
  margin-bottom: 2px;
}

.slider-section h3 {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--accent-gold);
  margin-bottom: 3px;
  padding: 4px 0 3px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.slider-section h3::after {
  content: '▾';
  font-size: 0.7rem;
  color: var(--text-secondary);
  transition: transform 0.2s;
}

.slider-section.collapsed h3::after {
  transform: rotate(-90deg);
}

.slider-section.collapsed .slider-section-body {
  display: none;
}

.slider-section + .slider-section {
  margin-top: 2px;
  padding-top: 2px;
  border-top: 1px solid rgba(51, 65, 85, 0.5);
}

.slider-section-body {
  padding-top: 1px;
}

.slider-group {
  margin-bottom: 3px;
}

.slider-pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 8px;
}

.slider-pair .slider-group {
  margin-bottom: 3px;
}

.slider-pair .slider-label .name {
  font-size: 0.65rem;
}

.slider-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.72rem;
  margin-bottom: 1px;
  color: var(--text);
  line-height: 1.3;
}

.slider-label .name {
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 4px;
}

.slider-label .value {
  font-weight: 600;
  color: var(--accent);
  min-width: 44px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* ─── Range inputs (sidebar sliders) ─────────────────────────────────── */

input[type="range"] {
  width: 100%;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: var(--border);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}

input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--accent);
  cursor: pointer;
  border: 2px solid var(--surface);
  box-shadow: 0 1px 4px rgba(0,0,0,0.4);
  transition: transform 0.1s;
}

input[type="range"]::-webkit-slider-thumb:hover {
  transform: scale(1.15);
}

input[type="range"]::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--accent);
  cursor: pointer;
  border: 2px solid var(--surface);
  box-shadow: 0 1px 4px rgba(0,0,0,0.4);
}

/* ─── Year slider (luxusný dizajn) ───────────────────────────────────── */

.year-slider-row input[type="range"] {
  height: 16px;
  background: linear-gradient(
    180deg,
    #c9983a 0%,
    #e2b85b 18%,
    #f5d98a 38%,
    #e2b85b 55%,
    #c9983a 75%,
    #a67c28 100%
  );
  border-radius: 8px;
  box-shadow:
    0 1px 3px rgba(0,0,0,0.4),
    inset 0 1px 0 rgba(255,255,255,0.15),
    inset 0 -1px 0 rgba(0,0,0,0.15);
  border: 1px solid #a67c28;
}

.year-slider-row input[type="range"]::-webkit-slider-thumb {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background:
    radial-gradient(circle at 50% 50%, transparent 6px, rgba(220,180,123,0.25) 6px, rgba(220,180,123,0.25) 7px, transparent 7px),
    radial-gradient(circle at 40% 35%, rgba(255,255,255,0.08) 0%, transparent 60%),
    radial-gradient(circle, var(--surface) 60%, #1a2d4a 100%);
  border: 3px solid #d4a44a;
  box-shadow:
    0 0 0 1px rgba(166,124,40,0.5),
    0 3px 8px rgba(0,0,0,0.5),
    0 1px 2px rgba(0,0,0,0.3),
    inset 0 2px 4px rgba(0,0,0,0.3),
    inset 0 -1px 2px rgba(255,255,255,0.05);
  cursor: grab;
  transition: transform 0.15s, box-shadow 0.15s;
}

.year-slider-row input[type="range"]::-webkit-slider-thumb:hover {
  transform: scale(1.1);
  border-color: #e2c06a;
  box-shadow:
    0 0 0 1px rgba(166,124,40,0.5),
    0 0 12px rgba(220,180,123,0.3),
    0 4px 10px rgba(0,0,0,0.5),
    inset 0 2px 4px rgba(0,0,0,0.3),
    inset 0 -1px 2px rgba(255,255,255,0.05);
}

.year-slider-row input[type="range"]::-webkit-slider-thumb:active {
  cursor: grabbing;
  transform: scale(1.05);
}

.year-slider-row input[type="range"]::-moz-range-thumb {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background:
    radial-gradient(circle at 50% 50%, transparent 6px, rgba(220,180,123,0.25) 6px, rgba(220,180,123,0.25) 7px, transparent 7px),
    radial-gradient(circle at 40% 35%, rgba(255,255,255,0.08) 0%, transparent 60%),
    radial-gradient(circle, var(--surface) 60%, #1a2d4a 100%);
  border: 3px solid #d4a44a;
  box-shadow:
    0 0 0 1px rgba(166,124,40,0.5),
    0 3px 8px rgba(0,0,0,0.5),
    0 1px 2px rgba(0,0,0,0.3),
    inset 0 2px 4px rgba(0,0,0,0.3),
    inset 0 -1px 2px rgba(255,255,255,0.05);
  cursor: grab;
}

.year-slider-row input[type="range"]::-moz-range-track {
  height: 16px;
  background: linear-gradient(
    180deg,
    #c9983a 0%,
    #e2b85b 18%,
    #f5d98a 38%,
    #e2b85b 55%,
    #c9983a 75%,
    #a67c28 100%
  );
  border-radius: 8px;
  border: 1px solid #a67c28;
}

/* ─── Tooltip ─────────────────────────────────────────────────────────── */

.slider-tooltip-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.62rem;
  font-weight: 600;
  font-style: italic;
  cursor: help;
  position: relative;
  flex-shrink: 0;
  opacity: 0.45;
  transition: opacity 0.15s;
  border: 1px solid var(--text-secondary);
}

.slider-tooltip-icon:hover { opacity: 0.85; }

.slider-tooltip-icon .tooltip-text {
  display: none;
  position: fixed;
  background: var(--surface-light);
  color: var(--text);
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 0.7rem;
  font-weight: 400;
  font-style: normal;
  white-space: normal;
  z-index: 200;
  max-width: 260px;
  min-width: 180px;
  line-height: 1.4;
  border: 1px solid var(--border);
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  pointer-events: none;
}

.slider-tooltip-icon:hover .tooltip-text,
.slider-tooltip-icon:focus .tooltip-text,
.slider-tooltip-icon:focus-within .tooltip-text { display: block; }

/* ─── Main content ────────────────────────────────────────────────────── */

.main-content {
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  min-height: 0;
  height: 100%;
}

.top-bar {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.top-bar-row1 {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.pyramid-container {
  background: var(--surface);
  border-radius: 8px;
  border: 1px solid var(--border);
  padding: 10px;
  flex: 1 1 0;
  min-height: 280px;
  max-height: 72vh;
  overflow: hidden;
}

.pyramid-container figure,
.pyramid-container svg {
  display: block;
  max-height: 100%;
}

/* ─── Year slider ─────────────────────────────────────────────────────── */

.year-slider-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 0 6px;
  flex-shrink: 0;
  position: relative;
  z-index: 5;
}

.year-slider-row input[type="range"] { flex: 1; }

/* ─── Support ratio KPI ──────────────────────────────────────────────── */

.support-ratio-display {
  padding: 3px 8px;
  background: var(--surface-light);
  border-radius: 6px;
  border: 1px solid var(--border);
  transition: border-color 0.3s;
  display: flex;
  align-items: center;
  gap: 8px;
}

.support-ratio-display:has(.ratio-red) {
  border-color: #D82727;
  background: rgba(216, 39, 39, 0.08);
}

.support-ratio-display:has(.ratio-orange) {
  border-color: #fbbf24;
  background: rgba(251, 191, 36, 0.08);
}

.support-ratio-display:has(.ratio-green) {
  border-color: #37B268;
  background: rgba(55, 178, 104, 0.06);
}

.support-ratio-display .ratio-value {
  font-size: 0.88rem;
  font-weight: 700;
  white-space: nowrap;
}

.ratio-green { color: #37B268; }
.ratio-orange { color: #fbbf24; }
.ratio-red { color: #D82727; }

.ratio-detail-text {
  font-size: 0.58rem;
  color: var(--text-secondary);
  white-space: nowrap;
}

/* ─── Legend ───────────────────────────────────────────────────────────── */

.legend-container {
  display: flex;
  flex-wrap: wrap;
  gap: 0 5px;
  padding: 8px 0 2px;
  justify-content: center;
  flex-shrink: 0;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 0.78rem;
  cursor: pointer;
  padding: 1px 4px;
  border-radius: 3px;
  transition: opacity 0.15s;
  user-select: none;
  color: var(--text);
}

.legend-item:hover { background: var(--surface-light); }

.legend-item.legend-hidden {
  opacity: 0.3;
  text-decoration: line-through;
}

.legend-swatch {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}

/* ─── Stats Panel (right) ─────────────────────────────────────────────── */

.stats-panel {
  background: var(--surface);
  border-left: 1px solid var(--border);
  padding: 8px;
  overflow-y: auto;
  min-height: 0;
  height: 100%;
}

.stat-card {
  margin-bottom: 2px;
  padding: 5px 8px;
  border-radius: 5px;
  background: var(--surface-light);
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 0 6px;
  min-height: 28px;
}

.stat-card.stat-payers,
.stat-card.stat-recipients {
  grid-template-columns: 1fr;
  grid-template-rows: auto auto;
  gap: 1px 0;
}

.stat-card.stat-payers { border-left: 3px solid var(--accent); }
.stat-card.stat-recipients { border-left: 3px solid var(--accent-gold); }

.stat-card.stat-payers .stat-label,
.stat-card.stat-recipients .stat-label {
  white-space: normal;
}

.stat-card.stat-payers .stat-value,
.stat-card.stat-recipients .stat-value {
  text-align: left;
}

.stat-card.stat-payers .stat-detail,
.stat-card.stat-recipients .stat-detail {
  text-align: left;
  grid-column: 1;
}

.stat-card .stat-label {
  font-size: 0.66rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stat-card .stat-value {
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  text-align: right;
}

.stat-card .stat-detail {
  font-size: 0.62rem;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  text-align: right;
}

/* ─── SVG / Plot ──────────────────────────────────────────────────────── */

figure { margin: 0; }
svg { max-width: 100%; height: auto; }
svg text { font-family: 'Inter', sans-serif; }

/* ─── Responsive: tablet ──────────────────────────────────────────────── */

@media (max-width: 1200px) {
  :root {
    --sidebar-width: 244px;
    --stats-width: 196px;
  }
}

/* ─── Responsive: mobile ──────────────────────────────────────────────── */

@media (max-width: 1024px) {
  body {
    overflow: auto;
    padding-bottom: env(safe-area-inset-bottom, 0);
  }

  .app-layout {
    grid-template-columns: 1fr;
    grid-template-rows: auto;
    height: auto;
  }

  .app-header h1 {
    font-size: 0.82rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .slider-toggle,
  .reset-btn { display: inline-block; }

  .stats-toggle {
    display: block;
    padding: 6px;
    font-size: 0.76rem;
  }

  .slider-panel {
    max-height: none;
    border: none;
    padding: 0;
    background: transparent;
    display: none;
  }

  .slider-panel.panel-open {
    display: block;
    padding: 8px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    animation: fadeIn 0.15s ease-out;
  }

  .slider-panel.panel-open .slider-content {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0 16px;
    max-height: 40vh;
    overflow-y: auto;
  }

  .stats-content { display: none; }

  .stats-content.open {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 3px;
    max-height: 35vh;
    overflow-y: auto;
    animation: fadeIn 0.15s ease-out;
  }

  .stats-panel {
    max-height: none;
    border: none;
    padding: 4px 8px 0;
    background: transparent;
  }

  .main-content {
    max-height: none;
    padding: 4px 10px;
    gap: 4px;
  }

  .top-bar {
    gap: 3px;
  }

  .year-slider-row {
    padding: 6px 0 4px;
  }

  .year-slider-row input[type="range"] {
    height: 14px;
    border-radius: 7px;
  }

  .year-slider-row input[type="range"]::-webkit-slider-thumb {
    width: 28px;
    height: 28px;
  }

  .year-slider-row input[type="range"]::-moz-range-thumb {
    width: 28px;
    height: 28px;
  }

  .pyramid-container {
    padding: 6px;
    border-radius: 6px;
  }

  .legend-container {
    padding: 4px 0 2px;
  }

  .legend-item {
    font-size: 0.74rem;
  }

}

/* ─── Responsive: small mobile ────────────────────────────────────────── */

@media (max-width: 640px) {
  .app-header { padding: 0 12px; }

  .slider-panel.panel-open .slider-content {
    grid-template-columns: 1fr;
  }

  .stats-content.open {
    grid-template-columns: 1fr 1fr;
  }

  .main-content {
    padding: 6px 8px;
    gap: 4px;
  }

  .pyramid-container {
    padding: 4px;
    height: 48vh;
    min-height: 240px;
    max-height: 440px;
  }

  .year-display { font-size: 1.1rem; }

  input[type="range"] { height: 6px; }

  input[type="range"]::-webkit-slider-thumb {
    width: 20px;
    height: 20px;
  }

  input[type="range"]::-moz-range-thumb {
    width: 20px;
    height: 20px;
  }

  .slider-group { margin-bottom: 12px; }

  .slider-tooltip-icon {
    width: 20px;
    height: 20px;
    font-size: 0.66rem;
  }


  .legend-container { gap: 1px 5px; }
  .legend-item { padding: 1px 4px; font-size: 0.72rem; }
}

/* ─── Touch devices ───────────────────────────────────────────────────── */

@media (hover: none) {
  .slider-tooltip-icon:focus .tooltip-text,
  .slider-tooltip-icon:focus-within .tooltip-text,
  .slider-tooltip-icon:active .tooltip-text {
    display: block;
  }

  .slider-tooltip-icon {
    -webkit-tap-highlight-color: transparent;
  }
}

/* ─── Animations ──────────────────────────────────────────────────────── */

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
