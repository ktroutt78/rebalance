// deck.gl layers: stations (diverging demand), route arcs (one colour per
// truck), and animated trucks (TripsLayer trail + a moving marker whose size
// encodes current load). Rendering only — no optimization happens here.
//
// Every layer reads a `focus` context = { focusedTruck, selectedStation,
// stationToTruck }. When a truck is focused: its route + stops render full,
// stops brought forward; everything else ghosts to ~0.15 (never hidden) but
// keeps animating. The selected station is highlighted distinctly on top.

import { ScatterplotLayer, PathLayer, TextLayer, IconLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import { COLOR, TRUCK_COLORS, ANIM, MARKER, ROUTE_ARC, TRUCK_MARKER_RADIUS } from './config.js';

const truckColor = (i) => TRUCK_COLORS[i % TRUCK_COLORS.length];
const EMPTY_SET = new Set();
const NO_FOCUS = {
  focusedTruck: null,
  activeTrucks: null, // Set of emphasized truck indices: single focus OR a whole highlighted type
  typeHighlight: null,
  selectedStation: null,
  stationToTruck: new Map(),
  hoveredStation: null,
  unservedStations: EMPTY_SET,
};

// The emphasis set: a focused vehicle is a set of one; a highlighted TYPE
// (click "Box truck" in the fleet panel) is a set of several. Layers treat
// both identically — members render full, the rest ghost.
const activeSetOf = (focus) => {
  const s = focus.activeTrucks;
  return s && s.size > 0 ? s : null;
};
// Stable updateTriggers key for accessors that depend on the emphasis set.
const focusKeyOf = (focus) =>
  focus.focusedTruck != null ? `t${focus.focusedTruck}` : focus.typeHighlight || '';

function haversine(aLng, aLat, bLng, bLat) {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la = (aLat * Math.PI) / 180;
  const lb = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

// Bézier control point that bows a leg A→B to a consistent side (left of travel,
// so out-and-back legs separate). Offset is perpendicular to the chord, scaled
// by leg length; cos(lat) keeps the bow visually perpendicular in lng/lat space.
function arcControl(a, b) {
  const midLng = (a.lng + b.lng) / 2;
  const midLat = (a.lat + b.lat) / 2;
  const cosLat = Math.cos((midLat * Math.PI) / 180) || 1e-6;
  const ax = (b.lng - a.lng) * cosLat;
  const ay = b.lat - a.lat;
  const len = Math.hypot(ax, ay) || 1e-9;
  const px = -ay / len; // perpendicular (rotate chord 90°)
  const py = ax / len;
  const off = ROUTE_ARC.bow * len;
  return [midLng + (px * off) / cosLat, midLat + py * off];
}

// Tessellate leg A→B into a quadratic Bézier bow. Includes A, excludes B so
// concatenated legs don't duplicate shared stop vertices.
function arcLeg(a, b) {
  const c = arcControl(a, b);
  const pts = [];
  for (let s = 0; s < ROUTE_ARC.steps; s++) {
    const t = s / ROUTE_ARC.steps;
    const u = 1 - t;
    pts.push([
      u * u * a.lng + 2 * u * t * c[0] + t * t * b.lng,
      u * u * a.lat + 2 * u * t * c[1] + t * t * b.lat,
    ]);
  }
  return pts;
}

// Precompute, per truck, the curved geometry + timestamps + per-point load that
// both the static route line and the animation share, so they stay aligned.
// Each straight leg becomes a gentle arc; timestamps run by cumulative ARC
// length, normalized PER TRUCK to [0, tripLength] so trucks depart/return together.
export function buildAnimationModel(routes) {
  const model = [];
  for (const r of routes) {
    const wp = r.waypoints;
    if (wp.length < 2 || r.distance <= 0) continue;

    const path = [];
    const loads = []; // load carried while driving the segment STARTING at each point
    for (let i = 0; i < wp.length - 1; i++) {
      const legLoad = wp[i].load; // load carried along this leg (after servicing stop i)
      for (const p of arcLeg(wp[i], wp[i + 1])) {
        path.push(p);
        loads.push(legLoad);
      }
    }
    const last = wp[wp.length - 1];
    path.push([last.lng, last.lat]);
    loads.push(last.load);

    const cum = [0];
    for (let i = 1; i < path.length; i++) {
      cum[i] = cum[i - 1] + haversine(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    }
    const total = cum[cum.length - 1] || 1;
    const timestamps = cum.map((c) => (c / total) * ANIM.tripLength);

    // Timestamp at each ORIGINAL waypoint (stop): waypoint i sits at curved-path
    // index i·steps. Lets the load chart's playhead track the animation by stop.
    const stopTimes = [];
    for (let i = 0; i < wp.length; i++) {
      stopTimes.push(timestamps[Math.min(i * ROUTE_ARC.steps, timestamps.length - 1)]);
    }

    model.push({
      truckIndex: r.truckIndex,
      color: truckColor(r.truckIndex),
      path,
      timestamps,
      loads,
      stopTimes,
      stopLoads: wp.map((w) => w.load), // per-stop running load (matches the load chart bars)
      // main.js annotates each entry with `vehicle` (its VEHICLE_TYPES record)
      // after building — marker/route/trail sizes encode the type visually.
    });
  }
  return model;
}

const baseDemandColor = (s) =>
  s.demand > 0 ? COLOR.surplus : s.demand < 0 ? COLOR.deficit : COLOR.neutral;

// --- Stations: diverging color (surplus blue / deficit red), tamed size + alpha,
// focus-aware emphasis. The selected station gets a bold white ring. ---
export function stationLayer(stations, focus = NO_FOCUS) {
  const { selectedStation, stationToTruck, hoveredStation } = focus;
  const unserved = focus.unservedStations || EMPTY_SET;
  const active = activeSetOf(focus);
  const hasFocus = active != null;
  // A TYPE spotlight can cover most of the map — boosting its stations to full
  // alpha turns midtown into a blob that buries the routes. So: single-vehicle
  // focus BOOSTS that route's stops; a type spotlight leaves member stations at
  // their normal look and only GHOSTS the rest — the brightened, thickened
  // routes carry the emphasis.
  const isTypeSpotlight = focus.typeHighlight != null;
  const isFocusedStop = (s) => hasFocus && active.has(stationToTruck.get(s.idx));
  const isUnserved = (s) => unserved.has(s.idx);
  const trig = focusKeyOf(focus);

  const radiusOf = (s) => {
    let r = MARKER.base + MARKER.scale * Math.pow(Math.abs(s.demand), MARKER.exp);
    if (s.idx === selectedStation) r *= MARKER.selectGrow;
    else if (s.idx === hoveredStation) r *= MARKER.focusGrow;
    else if (isUnserved(s)) r *= MARKER.focusGrow; // missed stations stay noticeable
    else if (isFocusedStop(s) && !isTypeSpotlight) r *= MARKER.focusGrow;
    return r;
  };

  const fillOf = (s) => {
    const col = baseDemandColor(s);
    let a = MARKER.fillAlpha;
    if (hasFocus) {
      a = isFocusedStop(s)
        ? isTypeSpotlight
          ? MARKER.fillAlpha // spotlight members keep the normal look
          : MARKER.focusAlpha // a single focused route's stops boost
        : MARKER.ghostAlpha;
    }
    // Unserved: hollow/muted fill so it reads as an outlined "miss", but never
    // fully hidden by focus ghosting — these are the stations the story is about.
    if (isUnserved(s)) a = Math.max(a, 45);
    if (s.idx === hoveredStation) a = 255; // a hovered chart bar lights its stop
    if (s.idx === selectedStation) a = 255;
    return [col[0], col[1], col[2], a];
  };

  const lineOf = (s) => {
    if (s.idx === selectedStation) return [255, 255, 255, 255];
    if (s.idx === hoveredStation) return [255, 255, 255, 210];
    // Warn-orange ring marks an unserved station (ties to the ⚠ status text).
    if (isUnserved(s)) return [...COLOR.unserved, 240];
    if (hasFocus) {
      if (!isFocusedStop(s)) return [255, 255, 255, 18];
      return [255, 255, 255, isTypeSpotlight ? 55 : 150];
    }
    return [255, 255, 255, 55];
  };

  const lineWidthOf = (s) =>
    s.idx === selectedStation ? 2.4 : isUnserved(s) ? 2.2 : s.idx === hoveredStation ? 1.8 : 0.6;

  return new ScatterplotLayer({
    id: 'stations',
    data: stations,
    getPosition: (s) => [s.lng, s.lat],
    getFillColor: fillOf,
    getRadius: radiusOf,
    getLineColor: lineOf,
    getLineWidth: lineWidthOf,
    radiusUnits: 'pixels',
    radiusMinPixels: 2,
    lineWidthUnits: 'pixels',
    stroked: true,
    pickable: true,
    updateTriggers: {
      getFillColor: [trig, selectedStation, hoveredStation, unserved],
      getRadius: [trig, selectedStation, hoveredStation, unserved],
      getLineColor: [trig, selectedStation, hoveredStation, unserved],
      getLineWidth: [selectedStation, hoveredStation, unserved],
    },
  });
}

// --- Route lines: one gentle curved PathLayer per truck, over the SAME bowed
// geometry the trail animates along (so line + trail + truck stay aligned). The
// arcs are a drawing choice; the optimizer still solves on straight-line distance. ---
export function routeLineLayer(model, focus = NO_FOCUS) {
  const active = activeSetOf(focus);
  const hasFocus = active != null;
  const trig = focusKeyOf(focus);
  // Skinnier + slightly muted: ease each channel toward mid-grey and lower alpha
  // so routes stay traceable and per-truck distinguishable, but recede behind the
  // saturated blue/red station dots (truck identity now lives in the numbered marker).
  const mute = (c) => Math.round(c * 0.82 + 150 * 0.18);
  const colorOf = (d) => {
    const a = !hasFocus ? 125 : active.has(d.truckIndex) ? 205 : 30;
    return [mute(d.color[0]), mute(d.color[1]), mute(d.color[2]), a];
  };
  // Line weight encodes vehicle type (box truck heavy → trailer hairline), but
  // stays deliberately thin throughout: the line is only the visit ORDER — the
  // stations and the moving vehicle are the story, the line just connects them.
  const baseWidth = (d) => d.vehicle?.routeWidth ?? 0.7;
  return new PathLayer({
    id: 'routes',
    data: model,
    getPath: (d) => d.path,
    getColor: colorOf,
    // Emphasized routes get a hard FLOOR: a focused trailer's hairline must
    // still be traceable across long hops between stops. Type-scaled thinness
    // is for the background fleet only.
    getWidth: (d) => (hasFocus && active.has(d.truckIndex) ? Math.max(2.2, baseWidth(d) * 1.6) : baseWidth(d)),
    widthUnits: 'pixels',
    widthMinPixels: 0.4,
    capRounded: true,
    jointRounded: true,
    parameters: { depthTest: false },
    updateTriggers: {
      getColor: [trig],
      getWidth: [trig],
    },
  });
}

// --- Animated trail behind each truck (non-focused ghosted but still moving) ---
export function tripsLayer(model, currentTime, focus = NO_FOCUS) {
  const active = activeSetOf(focus);
  const hasFocus = active != null;
  const trig = focusKeyOf(focus);
  const colorOf = (d) => {
    const a = !hasFocus ? 230 : active.has(d.truckIndex) ? 255 : 38;
    return [d.color[0], d.color[1], d.color[2], a];
  };
  return new TripsLayer({
    id: 'trips',
    data: model,
    getPath: (d) => d.path,
    getTimestamps: (d) => d.timestamps,
    getColor: colorOf,
    opacity: 1,
    // Trail weight encodes vehicle type, matching the route line underneath.
    getWidth: (d) => d.vehicle?.trailWidth ?? 3,
    widthUnits: 'pixels',
    widthMinPixels: 1.5,
    jointRounded: true,
    capRounded: true,
    trailLength: ANIM.trailLength,
    currentTime,
    updateTriggers: { getColor: [trig] },
  });
}

// Sample each truck's interpolated position + the load it's carrying right now.
export function sampleTrucks(model, currentTime) {
  const out = [];
  for (const t of model) {
    const ts = t.timestamps;
    const last = ts.length - 1;
    let seg = 0;
    while (seg < last && currentTime > ts[seg + 1]) seg++;
    const span = ts[seg + 1] - ts[seg] || 1;
    const f = Math.min(1, Math.max(0, (currentTime - ts[seg]) / span));
    const a = t.path[seg];
    const b = t.path[seg + 1];
    out.push({
      position: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f],
      load: t.loads[seg], // carrying the load it left waypoint `seg` with
      color: t.color,
      truckIndex: t.truckIndex,
      vehicle: t.vehicle, // type record → marker radius + number size
    });
  }
  return out;
}

// --- Moving vehicle marker: a WHITE rounded SQUARE with a colored ring (route
// color) and the vehicle number inside (truckNumberLayer). Shape separates the
// moving fleet from the circular stations at a glance; size encodes the
// VEHICLE TYPE (box truck > van > trailer), fixed per vehicle at all times —
// it carries identity + type, never load. Non-focused vehicles dim but keep
// moving. The ring is the color tie-back to the route. ---
const markerRadiusOf = (d) => d.vehicle?.radius ?? TRUCK_MARKER_RADIUS;

// Rounded-square badge as an inline SVG data URL, cached per route color.
const iconCache = new Map();
function vehicleIcon(color) {
  const key = color.join(',');
  let icon = iconCache.get(key);
  if (!icon) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">` +
      `<rect x="5" y="5" width="54" height="54" rx="15" fill="#ffffff" stroke="rgb(${key})" stroke-width="8"/>` +
      `</svg>`;
    icon = { url: `data:image/svg+xml;base64,${btoa(svg)}`, width: 64, height: 64, id: `veh-${key}` };
    iconCache.set(key, icon);
  }
  return icon;
}

export function truckMarkerLayer(model, currentTime, focus = NO_FOCUS) {
  const active = activeSetOf(focus);
  const hasFocus = active != null;
  const dim = (d) => hasFocus && !active.has(d.truckIndex);
  const trucks = sampleTrucks(model, currentTime);
  return new IconLayer({
    id: 'trucks',
    data: trucks,
    getPosition: (d) => d.position,
    getIcon: (d) => vehicleIcon(d.color),
    getSize: (d) => markerRadiusOf(d) * 2,
    sizeUnits: 'pixels',
    // Non-masked icons keep their own colors; only alpha applies (dims the
    // non-focused fleet without repainting the badge).
    getColor: (d) => [255, 255, 255, dim(d) ? 80 : 255],
    parameters: { depthTest: false },
    updateTriggers: { getColor: [focusKeyOf(focus)] },
  });
}

// --- Truck number sitting inside the white marker (1, 2, 3…). Dark text on the
// white dot; dims with the marker when another truck is focused. ---
export function truckNumberLayer(model, currentTime, focus = NO_FOCUS) {
  const active = activeSetOf(focus);
  const hasFocus = active != null;
  const dim = (d) => hasFocus && !active.has(d.truckIndex);
  const trucks = sampleTrucks(model, currentTime);
  return new TextLayer({
    id: 'truck-numbers',
    data: trucks,
    getPosition: (d) => d.position,
    getText: (d) => String(d.truckIndex + 1),
    getColor: (d) => [12, 18, 24, dim(d) ? 90 : 255],
    // Digit scales with the marker so it fills a box truck and fits a trailer.
    getSize: (d) => Math.round(markerRadiusOf(d) * 1.3),
    sizeUnits: 'pixels',
    getTextAnchor: 'middle',
    getAlignmentBaseline: 'center',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontWeight: 700,
    parameters: { depthTest: false },
    updateTriggers: { getColor: [focusKeyOf(focus)] },
  });
}

// --- On-map load readout: "23/30" floating just above the FOCUSED truck, so its
// current inventory is followable on the map without glancing up at the load chart.
// Position follows the smooth interpolated marker, but the LOAD VALUE snaps to the
// current stop's running load (`stopLoads[stopIndex]`, the same number the load
// chart bar shows) — so scrubbing reads clean discrete per-stop values, not a
// flickering interpolated in-between number. Focused truck only. ---
export function truckLoadLabelLayer(model, currentTime, capacity, focus = NO_FOCUS, stopIndex = -1) {
  const { focusedTruck } = focus;
  if (focusedTruck == null) return null;
  const tModel = model.find((m) => m.truckIndex === focusedTruck);
  const truck = sampleTrucks(model, currentTime).find((t) => t.truckIndex === focusedTruck);
  if (!truck || !tModel) return null;
  const sl = tModel.stopLoads;
  const load = sl && stopIndex >= 0 && stopIndex < sl.length ? sl[stopIndex] : truck.load;
  // Sit the chip just clear of this vehicle's own marker size. Naming the type
  // on the chip answers "what's servicing this?" without leaving the map.
  const radius = markerRadiusOf(truck);
  const typeTag = tModel.vehicle ? ` · ${tModel.vehicle.short}` : '';
  return new TextLayer({
    id: 'truck-load',
    data: [truck],
    getPosition: (d) => d.position,
    getText: () => `${load}/${capacity}${typeTag}`,
    characterSet: 'auto', // the '·' separator sits outside the default ASCII set
    getColor: [255, 255, 255, 255],
    getSize: 13,
    sizeUnits: 'pixels',
    getPixelOffset: [0, -(radius + 12)],
    getTextAnchor: 'middle',
    getAlignmentBaseline: 'bottom',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontWeight: 700,
    background: true,
    getBackgroundColor: [12, 18, 24, 235],
    backgroundPadding: [5, 2, 5, 2],
    getBorderColor: [255, 255, 255, 65],
    getBorderWidth: 1,
    parameters: { depthTest: false },
    updateTriggers: {
      getText: [focusedTruck, capacity, load],
    },
  });
}

// --- Depot: amber diamond-ish marker (rendered as a bold dot). ---
export function depotLayer(depot) {
  return new ScatterplotLayer({
    id: 'depot',
    data: [depot],
    getPosition: (d) => [d.lng, d.lat],
    getFillColor: COLOR.depot,
    getRadius: 9,
    radiusUnits: 'pixels',
    radiusMinPixels: 7,
    stroked: true,
    getLineColor: [20, 20, 20, 255],
    lineWidthMinPixels: 2,
    pickable: true,
  });
}
