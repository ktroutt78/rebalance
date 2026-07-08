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

// --- Fleet: real rebalancing runs a MIX of vehicles, not one truck size. ---
// Capacities bracket the real demand data (|demand| tops out at 24 bikes, and
// 103 of the 250 stations need 3 or fewer — small vehicles have real work).
// Costs are rough per-shift estimates (dispatch/driver fixed + running $/mi);
// invented but plausible, and only their RATIOS steer the fleet finder.
// Declaration order is big → small so vehicle 1 is always the biggest.
// radius/routeWidth/trailWidth encode TYPE visually on the map: a box truck is
// literally bigger than a trailer — marker, route line, and trail all scale.
// Fixed per vehicle at all times, so size never reads as load (that stays the
// load chart's job).
// overtimePerHour: hours past the SHIFT window bill at time-and-a-half of a
// plausible NYC crew wage (truck driver ~$28/h, van driver ~$22/h, trailer
// rider ~$17/h, near the city's standard wage). Regular-shift wages are
// treated as committed payroll (the crew is paid for the night either way),
// so only the overtime premium is an incremental dollar. Overtime is a SOFT
// penalty: long routes are allowed, they just price themselves out (one box
// truck doing the whole city carries ~15 hours of overtime and loses every
// cost comparison).
export const VEHICLE_TYPES = [
  { id: 'truck', name: 'Box truck', short: 'Truck', capacity: 30, fixedCost: 110, costPerMile: 2.2, overtimePerHour: 42, max: 4, radius: 11.5, routeWidth: 1.35, trailWidth: 4.5 },
  { id: 'van', name: 'Cargo van', short: 'Van', capacity: 12, fixedCost: 60, costPerMile: 1.25, overtimePerHour: 33, max: 4, radius: 9, routeWidth: 0.85, trailWidth: 3 },
  { id: 'trailer', name: 'Bike trailer', short: 'Trailer', capacity: 3, fixedCost: 20, costPerMile: 0.5, overtimePerHour: 26, max: 4, radius: 6.5, routeWidth: 0.5, trailWidth: 1.8 },
];
export const FLEET_MAX_TOTAL = 8; // one TRUCK_COLORS entry per vehicle
// Landing state = the fleet finder's own recommendation at the default depot
// (cheapest full-coverage mix with overtime priced in), so the app opens on
// the optimizer's answer.
export const DEFAULT_FLEET = { truck: 2, van: 1, trailer: 4 };

// --- Shift realism: overnight hours are limited, and going over costs money. ---
// Route time = driving at Manhattan crawl speeds + service time per stop and
// per bike handled. Hours past the shift bill as overtime (fleetCost below).
// Without this, one box truck "wins" every cost comparison by driving a 20+
// hour route that would be free on paper. This lives OUTSIDE the solver
// (which minimizes distance for a given fleet); it's a pricing judgment on
// the solved plan.
export const SHIFT = {
  hours: 8, // overnight window, roughly 22:00–06:00
  mph: { truck: 9, van: 10, trailer: 8 }, // stop-and-go city speeds
  minPerStop: 1, // pull over, position, paperwork
  minPerBike: 0.5, // load or unload one bike
};

// Hours a vehicle of `type` needs to run one solved route.
export function routeHours(type, distanceMeters, stops, bikesMoved) {
  const mph = SHIFT.mph[type.id] ?? 9;
  const driveH = distanceMeters / METERS_PER_MILE / mph;
  return driveH + (stops * SHIFT.minPerStop + bikesMoved * SHIFT.minPerBike) / 60;
}

// Longest single route in a plan, in hours (0 for an all-idle plan).
export function planMaxHours(fleet, perTruck) {
  let h = 0;
  for (const t of perTruck) {
    if (t.stops === 0) continue;
    const type = fleet[t.truckIndex];
    if (!type) continue;
    h = Math.max(h, routeHours(type, t.distance, t.stops, t.bikesMoved));
  }
  return h;
}

// Expand per-type counts ({truck:2, van:1, …}) into the per-vehicle list the
// solver and UI consume, in VEHICLE_TYPES order (big → small).
export function buildFleet(counts) {
  const fleet = [];
  for (const t of VEHICLE_TYPES) {
    for (let i = 0; i < (counts[t.id] || 0); i++) fleet.push(t);
  }
  return fleet;
}

// Dollar cost of a solved plan: every vehicle that actually rolls pays its
// fixed dispatch cost, per-mile running cost, and overtime for any hours its
// route runs past the shift; idle vehicles cost nothing. The SOLVER stays
// cost-blind (it minimizes distance within a given fleet) — dollars live up
// here so the optimization core keeps a single clean objective.
export function fleetCost(fleet, perTruck) {
  let cost = 0;
  for (const t of perTruck) {
    if (t.stops === 0) continue;
    const type = fleet[t.truckIndex];
    if (!type) continue;
    const overtime = Math.max(0, routeHours(type, t.distance, t.stops, t.bikesMoved) - SHIFT.hours);
    cost += type.fixedCost + (t.distance / METERS_PER_MILE) * type.costPerMile + overtime * type.overtimePerHour;
  }
  return cost;
}

// Total overtime hours a plan bills (Σ over vehicles of hours past the shift).
export function planOvertimeHours(fleet, perTruck) {
  let ot = 0;
  for (const t of perTruck) {
    if (t.stops === 0) continue;
    const type = fleet[t.truckIndex];
    if (!type) continue;
    ot += Math.max(0, routeHours(type, t.distance, t.stops, t.bikesMoved) - SHIFT.hours);
  }
  return ot;
}

export const formatMoney = (v) => `$${Math.round(v).toLocaleString('en-US')}`;

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

// Fallback moving-marker radius (pixels) when a vehicle has no type (shouldn't
// happen in practice — VEHICLE_TYPES[].radius is the real source). Marker size
// encodes VEHICLE TYPE, fixed per vehicle at all times; load is shown by the
// load profile chart and the on-map text chip, never by marker size.
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
