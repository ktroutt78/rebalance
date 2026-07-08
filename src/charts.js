// Lightweight hand-rolled SVG charts — no charting lib, no bundle bloat.
// Both reinforce the surplus=blue / deficit=red encoding rather than competing
// with it (that signal must stay the clearest thing on screen).

import { COLOR } from './config.js';

const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const SURPLUS = rgb(COLOR.surplus);
const DEFICIT = rgb(COLOR.deficit);
const NEUTRAL = 'rgba(150,150,150,0.5)';

const HOUR_TICKS = { 0: '12a', 6: '6a', 12: '12p', 18: '6p' };

// Load chart geometry — shared with panel.js so the scrubber can map x→index.
export const LOAD_CHART = { W: 280, H: 124, padL: 4, padR: 4, padTop: 16, padBot: 14 };

// Per-stop load profile for the focused truck. x = visit sequence
// (depot → stops → depot); y = fixed 0..C with the capacity ceiling drawn as a
// reference line, so a bar touching the top literally means a full truck. Bar
// height = the truck's running inventory the solver already tracked; color =
// what happened at that stop (pickup=blue surplus, dropoff=red deficit).
export function loadChartSVG(seq, capacity, { currentIndex = -1, selectedIndex = -1 } = {}) {
  const { W, H, padL, padR, padTop, padBot } = LOAD_CHART;
  const chartW = W - padL - padR;
  const chartH = H - padTop - padBot;
  const top = padTop;
  const bottom = padTop + chartH;
  const n = Math.max(1, seq.length);
  const slot = chartW / n;
  // Pack bars tight (minimal inter-bar gap) so a long route stays a readable
  // profile instead of a hair-thin picket fence. Past ~70 stops it's still dense,
  // but the at-capacity amber markers below keep the capacity-pressure moments
  // legible regardless of density.
  const barW = Math.max(1.5, slot - (slot > 6 ? 1.2 : slot * 0.12));
  const cap = Math.max(1, capacity);
  const yFor = (load) => bottom - (Math.min(load, cap) / cap) * chartH;

  let bars = '';
  let caps = ''; // amber ticks atop full-capacity bars (drawn over the bars)
  let maxLoad = 0;
  for (let i = 0; i < seq.length; i++) {
    const { load, sign } = seq[i];
    maxLoad = Math.max(maxLoad, load);
    const x = padL + i * slot + (slot - barW) / 2;
    const y = yFor(load);
    const h = Math.max(0, bottom - y);
    const fill = sign > 0 ? SURPLUS : sign < 0 ? DEFICIT : NEUTRAL;
    const atCap = load >= cap; // truck full — capacity pressure, make it pop
    const cls = `load-bar${atCap ? ' at-cap' : ''}${i === currentIndex ? ' current' : ''}${
      i === selectedIndex ? ' selected' : ''
    }`;
    // zero-height (depot) points still get a 1px nub so the sequence ends read.
    bars += `<rect class="${cls}" data-index="${i}" x="${f(x)}" y="${f(load === 0 ? bottom - 1 : y)}" width="${f(barW)}" height="${f(load === 0 ? 1 : h)}" rx="0.6" fill="${fill}"/>`;
    if (atCap && load > 0) {
      // a bright amber cap sitting on the ceiling line — at-capacity stops read
      // as a row of markers along the top, not just "another tall bar".
      const mw = Math.max(2.6, barW + 1.4);
      const cx = padL + i * slot + slot / 2;
      caps += `<rect class="cap-mark" x="${f(cx - mw / 2)}" y="${f(top - 1.6)}" width="${f(mw)}" height="3.2" rx="0.8"/>`;
    }
  }

  const ceilY = top; // load === cap
  // Playhead band (Stage 3 moves it); hidden when currentIndex < 0.
  const phX = currentIndex >= 0 ? padL + currentIndex * slot : -100;
  const playhead = `<rect class="load-playhead" x="${f(phX)}" y="${top}" width="${f(slot)}" height="${f(chartH)}"/>`;

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" data-n="${seq.length}">
    ${playhead}
    <line class="cap-line" x1="${padL}" y1="${f(ceilY)}" x2="${W - padR}" y2="${f(ceilY)}"/>
    <text class="chart-caption" x="${padL}" y="11">full = ${cap}</text>
    <text class="chart-caption" x="${W - padR}" y="11" text-anchor="end">peak ${maxLoad}/${cap}</text>
    <line class="axis-line" x1="${padL}" y1="${f(bottom)}" x2="${W - padR}" y2="${f(bottom)}"/>
    ${bars}
    ${caps}
    <text class="hour-label" x="${padL}" y="${H - 3}">depot</text>
    <text class="hour-label" x="${W - padR}" y="${H - 3}" text-anchor="end">depot</text>
  </svg>`;
}

// Signed net-flow-by-hour: 24 bars above/below a zero baseline. Positive
// (arrivals > departures → accumulating → surplus) rises blue; negative dips red.
export function hourlyChartSVG(values) {
  const W = 280, H = 116, padX = 6, padTop = 12, padBot = 16;
  const chartW = W - 2 * padX;
  const chartH = H - padTop - padBot;
  const midY = padTop + chartH / 2;
  const maxAbs = Math.max(1, ...values.map((v) => Math.abs(v)));
  const slot = chartW / 24;
  const barW = slot * 0.66;

  // peak hour annotation
  let peakI = 0;
  for (let i = 1; i < 24; i++) if (Math.abs(values[i]) > Math.abs(values[peakI])) peakI = i;
  const peakV = values[peakI];
  const peakLabel = peakV === 0 ? 'flat across the day' : `peak ${peakV > 0 ? '+' : ''}${round1(peakV)} @ ${hourName(peakI)}`;

  let bars = '';
  for (let i = 0; i < 24; i++) {
    const v = values[i];
    const bh = (Math.abs(v) / maxAbs) * (chartH / 2 - 1);
    const x = padX + i * slot + (slot - barW) / 2;
    const y = v >= 0 ? midY - bh : midY;
    const fill = v > 0 ? SURPLUS : v < 0 ? DEFICIT : NEUTRAL;
    bars += `<rect x="${f(x)}" y="${f(y)}" width="${f(barW)}" height="${f(Math.max(0.4, bh))}" rx="0.8" fill="${fill}"/>`;
  }

  let ticks = '';
  for (const h of Object.keys(HOUR_TICKS)) {
    const x = padX + Number(h) * slot + slot / 2;
    ticks += `<text class="hour-label" x="${f(x)}" y="${H - 5}" text-anchor="middle">${HOUR_TICKS[h]}</text>`;
  }

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">
    <line class="axis-line" x1="${padX}" y1="${f(midY)}" x2="${W - padX}" y2="${f(midY)}"/>
    ${bars}
    ${ticks}
    <text class="chart-caption" x="${padX}" y="9">${peakLabel}</text>
    <text class="chart-caption" x="${W - padX}" y="9" text-anchor="end">avg net bikes/hr</text>
  </svg>`;
}

// Top imbalance ranking: most extreme surplus + most extreme deficit. Each row
// is a clickable bar that writes the shared selection (third entry point).
export function rankingHTML(stations, { selectedIdx = null, perSide = 5 } = {}) {
  const demanders = stations.filter((s) => s.demand !== 0);
  const surplus = demanders
    .filter((s) => s.demand > 0)
    .sort((a, b) => b.demand - a.demand)
    .slice(0, perSide);
  const deficit = demanders
    .filter((s) => s.demand < 0)
    .sort((a, b) => a.demand - b.demand)
    .slice(0, perSide);
  const maxMag = Math.max(1, ...demanders.map((s) => Math.abs(s.demand)));

  const row = (s) => {
    const pos = s.demand > 0;
    const w = (Math.abs(s.demand) / maxMag) * 100;
    const sel = s.idx === selectedIdx ? ' selected' : '';
    return `<div class="rank-row ${pos ? 'pos' : 'neg'}${sel}" data-idx="${s.idx}" role="button" tabindex="0" title="${escapeAttr(s.name)}">
        <span class="rank-val">${pos ? '+' : ''}${s.demand}</span>
        <span class="rank-track"><span class="rank-bar" style="width:${f(w)}%"></span><span class="rank-name">${escapeHtml(s.name)}</span></span>
      </div>`;
  };

  return surplus.map(row).join('') + deficit.map(row).join('');
}

// Sum every station's hourly profile into a system-level 24-array.
export function systemHourly(stations) {
  const acc = new Array(24).fill(0);
  for (const s of stations) {
    const h = s.hourly;
    if (!h) continue;
    for (let i = 0; i < 24; i++) acc[i] += h[i] || 0;
  }
  return acc.map((v) => round1(v));
}

// Fleet-finder chart: dual-axis line over an integer x (fleet size). Left axis
// = a cost-like series (solid teal line, round markers); right axis = stations
// unserved (dashed orange line, diamond markers) — distinguished by line style
// AND marker shape, not color alone. The recommended x gets a vertical guide +
// a haloed marker. Each x has a full-height transparent hit column (data-k) so
// a click anywhere in that band applies it.
// points: [{ x, left, right }] in ascending x; axes/titles come from opts so
// the chart stays agnostic about what it's plotting.
export function finderChartSVG(
  points,
  {
    recommendedX = null,
    leftTitle = '',
    rightTitle = '',
    xTitle = '',
    fmtLeft = (v) => String(Math.round(v)),
    rightGuide = null, // { value, label } — horizontal reference on the right axis
    rightMaxHint = null, // preferred right-axis top (e.g. 24 h = a full day); used when the data fits
  } = {}
) {
  const W = 560, H = 252; // short enough that the modal never scrolls at 900px
  const mT = 26, mR = 50, mB = 46, mL = 50;
  const plotW = W - mL - mR;
  const plotH = H - mT - mB;
  const xMin = points[0].x;
  const xMax = points[points.length - 1].x;

  const STEPS = 4; // shared gridlines; both axes tick at these four rows
  const lefts = points.map((p) => p.left);
  const rights = points.map((p) => p.right);
  const leftMax = niceMax(Math.max(1e-6, ...lefts));
  // Right axis: prefer the caller's semantic top (24 = a full day of hours)
  // whenever the data fits under it — the ticks then read as clean quarters
  // (6/12/18/24) and the labeled guide line marks the threshold itself.
  // Without a hint, a guide still forces a scale where it lands EXACTLY on a
  // gridline (steps of guide/4 doubled until the data fits) — otherwise the
  // shared gridlines tick the right axis at junk values (6.3, 12.5, …), the
  // classic dual-axis failure.
  const rightDataMax = Math.max(...rights, rightGuide ? rightGuide.value : 0);
  let rightMax = Math.max(1, niceMax(rightDataMax));
  if (rightMaxHint && rightDataMax <= rightMaxHint) {
    rightMax = rightMaxHint;
  } else if (rightGuide && rightGuide.value > 0) {
    let step = rightGuide.value / STEPS;
    while (step * STEPS < rightDataMax) step *= 2;
    rightMax = step * STEPS;
  }

  const xFor = (x) => mL + ((x - xMin) / Math.max(1, xMax - xMin)) * plotW;
  const yL = (v) => mT + plotH - (v / leftMax) * plotH;
  const yR = (v) => mT + plotH - (v / rightMax) * plotH;
  const bottom = mT + plotH;

  // Gridlines + left/right axis ticks.
  let grid = '';
  let leftTicks = '';
  let rightTicks = '';
  for (let i = 0; i <= STEPS; i++) {
    const y = mT + (i / STEPS) * plotH;
    grid += `<line class="finder-grid" x1="${f(mL)}" y1="${f(y)}" x2="${f(mL + plotW)}" y2="${f(y)}"/>`;
    const lv = leftMax * (1 - i / STEPS);
    leftTicks += `<text class="finder-axis-l" x="${f(mL - 8)}" y="${f(y + 3)}" text-anchor="end">${fmtLeft(lv)}</text>`;
    const rv = rightMax * (1 - i / STEPS);
    rightTicks += `<text class="finder-axis-r" x="${f(mL + plotW + 8)}" y="${f(y + 3)}" text-anchor="start">${round1(rv)}</text>`;
  }

  // X-axis labels + hit columns.
  let xLabels = '';
  let hits = '';
  const slot = plotW / Math.max(1, xMax - xMin);
  for (let x = xMin; x <= xMax; x++) {
    const px = xFor(x);
    const rec = x === recommendedX;
    xLabels += `<text class="finder-xlabel${rec ? ' rec' : ''}" x="${f(px)}" y="${f(bottom + 18)}" text-anchor="middle">${x}</text>`;
    hits += `<rect class="finder-hit" data-k="${x}" x="${f(px - slot / 2)}" y="${f(mT)}" width="${f(slot)}" height="${f(plotH)}"/>`;
  }

  // Recommended-x guide line behind the data.
  let recGuide = '';
  if (recommendedX != null) {
    const rx = xFor(recommendedX);
    recGuide = `<line class="finder-rec-guide" x1="${f(rx)}" y1="${f(mT)}" x2="${f(rx)}" y2="${f(bottom)}"/>`;
  }

  // Horizontal right-axis reference (e.g. the shift limit) behind the data.
  let hGuide = '';
  if (rightGuide) {
    const gy = yR(rightGuide.value);
    hGuide = `<line class="finder-right-guide" x1="${f(mL)}" y1="${f(gy)}" x2="${f(mL + plotW)}" y2="${f(gy)}"/>
    <text class="finder-right-guide-label" x="${f(mL + plotW - 4)}" y="${f(gy - 5)}" text-anchor="end">${rightGuide.label}</text>`;
  }

  const leftPts = points.map((p) => [xFor(p.x), yL(p.left)]);
  const rightPts = points.map((p) => [xFor(p.x), yR(p.right)]);
  const poly = (pts) => pts.map((p) => `${f(p[0])},${f(p[1])}`).join(' ');

  // Left-series markers (circles); halo the recommended one.
  let leftMarks = '';
  points.forEach((p, i) => {
    const [x, y] = leftPts[i];
    if (p.x === recommendedX) {
      leftMarks += `<circle class="finder-rec-halo" cx="${f(x)}" cy="${f(y)}" r="8"/>`;
    }
    leftMarks += `<circle class="finder-dot-dist" cx="${f(x)}" cy="${f(y)}" r="3.4"/>`;
  });

  // Right-series markers (diamonds) — shape distinguishes them from the left line.
  let rightMarks = '';
  rightPts.forEach(([x, y]) => {
    const s = 3.4;
    rightMarks += `<path class="finder-dot-uns" d="M${f(x)},${f(y - s)} L${f(x + s)},${f(y)} L${f(x)},${f(y + s)} L${f(x - s)},${f(y)} Z"/>`;
  });

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" class="finder-svg">
    ${grid}
    ${recGuide}
    ${hGuide}
    <text class="finder-axis-title l" x="${f(mL)}" y="14" text-anchor="start">${leftTitle}</text>
    <text class="finder-axis-title r" x="${f(mL + plotW)}" y="14" text-anchor="end">${rightTitle}</text>
    ${leftTicks}
    ${rightTicks}
    <polyline class="finder-line-dist" points="${poly(leftPts)}"/>
    <polyline class="finder-line-uns" points="${poly(rightPts)}"/>
    ${leftMarks}
    ${rightMarks}
    ${xLabels}
    <text class="finder-xaxis-title" x="${f(mL + plotW / 2)}" y="${f(H - 4)}" text-anchor="middle">${xTitle}</text>
    ${hits}
  </svg>`;
}

// Round a value up to a clean axis maximum (1/2/2.5/5/10 × power of ten).
function niceMax(v) {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * pow;
}
function hourName(h) {
  const ap = h < 12 ? 'a' : 'p';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${ap}`;
}
const round1 = (v) => Math.round(v * 10) / 10;
const f = (n) => (Number.isFinite(n) ? +n.toFixed(2) : 0);
const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const escapeAttr = escapeHtml;
