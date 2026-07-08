// Central constants: K/C ranges, colors, map style, bbox, default load state.
// Tweak here, not inline — keeps the rest of the app declarative.

// --- Geography (Manhattan frames well: island shape, rivers, dense grid) ---
export const MANHATTAN_BBOX = {
  minLng: -74.02,
  minLat: 40.695,
  maxLng: -73.91,
  maxLat: 40.82,
};

export const INITIAL_VIEW = {
  longitude: -73.975,
  latitude: 40.758,
  zoom: 11.6,
  pitch: 0,
  bearing: 0,
};

// Default depot — a plausible central maintenance yard. Draggable at runtime.
export const DEFAULT_DEPOT = { lng: -73.993, lat: 40.735 };

// --- Solver control ranges + initial landing values (section 10 open items) ---
export const K_RANGE = { min: 1, max: 8, default: 4 }; // trucks
// Grounded in real fleet sizes: rebalancing runs 3-bike trailers up through box
// trucks carrying a few dozen. We model the larger trucks — 10–40, default 30.
export const C_RANGE = { min: 10, max: 40, default: 30 }; // bikes per truck

// --- Data ---
export const PARQUET_URL = `${import.meta.env.BASE_URL}stations_demand.parquet`;

// --- Distance display (US audience): route distances are stored in metres; show
// imperial — miles, dropping to feet for anything under ~0.1 mi. ---
const METERS_PER_MILE = 1609.344;
export function formatDistance(meters) {
  const miles = meters / METERS_PER_MILE;
  if (miles < 0.1) return `${Math.round(meters * 3.28084)} ft`;
  return `${miles.toFixed(1)} mi`;
}

// --- Colors ---
// Diverging scale for station demand: surplus (pick up) vs deficit (drop off).
export const COLOR = {
  surplus: [42, 157, 244], // blue — bikes accumulate, truck picks up
  deficit: [244, 91, 91], // red — bikes scarce, truck drops off
  neutral: [150, 150, 150],
  depot: [255, 209, 64], // amber
  unserved: [255, 180, 76], // warn-orange ring for stations the solver missed
};

// One distinct color per truck (up to K_RANGE.max). RGB.
// Deliberately NO saturated blue or red here — those hues are reserved for the
// surplus/deficit demand encoding, which must stay the clearest signal on screen.
export const TRUCK_COLORS = [
  [76, 201, 176], // teal
  [255, 159, 64], // orange
  [176, 124, 255], // violet
  [171, 222, 90], // lime
  [232, 124, 200], // magenta
  [58, 208, 224], // cyan
  [70, 200, 120], // emerald
  [176, 160, 208], // lavender
];

// Station marker tuning (Stage 3): tamed so dense midtown reads as depth, not a
// solid blob. radius = base + scale·|demand|^exp (pixels); alpha gives overlap depth.
export const MARKER = {
  base: 2.2,
  scale: 1.15,
  exp: 0.6, // sublinear so big stations stop dominating
  fillAlpha: 140, // base transparency
  focusAlpha: 255, // focused truck's stops
  ghostAlpha: 40, // ~0.15 — ghosted, never hidden
  focusGrow: 1.35, // radius × for focused stops
  selectGrow: 1.9, // radius × for the selected station
};

// Ghost opacity for non-focused routes/trails/trucks (Stage 3).
export const GHOST_OPACITY = 0.15;

// Moving truck marker radius (pixels). FIXED for every truck at all times — it
// encodes position + truck identity (white dot + number + colored ring) only.
// Load is shown by the load profile chart and the on-map text chip, never by
// marker size. Sized just large enough that a single digit stays legible inside.
export const TRUCK_MARKER_RADIUS = 9;

// Route leg curvature: each straight leg is drawn as a gentle Bézier bow so long
// legs lift off the chord (de-literalizing water crossings, separating parallel
// corridors) without reading as flight paths. `bow` = control-point lateral
// offset as a fraction of leg length (peak deviation ≈ bow/2). Drawing only —
// the optimizer still solves on straight-line distance.
export const ROUTE_ARC = { bow: 0.2, steps: 18 };

// --- MapLibre style: a clean dark basemap with strong water/land contrast. ---
// Uses CARTO's free raster-free vector demo style; falls back gracefully.
export const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

// --- Animation ---
export const ANIM = {
  // Trip duration is normalized to [0, TRIP_LENGTH]; loop period in ms at 1× speed.
  tripLength: 1000,
  loopMs: 9000,
  trailLength: 180,
  // Speed multiplier options. Default deliberately slow so a focused truck is
  // followable (1× completes the whole route in loopMs — too fast to track).
  // 0.1× is a crawl (full loop ≈ 90s) so the on-map load tooltip is readable.
  speeds: [1, 0.5, 0.25, 0.1],
  defaultSpeed: 0.5,
};
