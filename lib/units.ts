// Pure unit-conversion utility. Returns null when conversion isn't possible;
// never guesses. Cross-dimension (mass ↔ volume) requires density_g_per_ml.

const MASS_TO_G: Record<string, number> = {
  mg: 0.001,
  g: 1,
  gram: 1,
  grams: 1,
  kg: 1000,
  kilo: 1000,
  kilos: 1000,
  kilogram: 1000,
  kilograms: 1000,
  oz: 28.3495,
  ounce: 28.3495,
  ounces: 28.3495,
  lb: 453.592,
  lbs: 453.592,
  pound: 453.592,
  pounds: 453.592,
};

const VOL_TO_ML: Record<string, number> = {
  ml: 1,
  milliliter: 1,
  milliliters: 1,
  l: 1000,
  liter: 1000,
  liters: 1000,
  litre: 1000,
  litres: 1000,
  tsp: 4.92892,
  teaspoon: 4.92892,
  teaspoons: 4.92892,
  tbsp: 14.7868,
  tablespoon: 14.7868,
  tablespoons: 14.7868,
  cup: 236.588,
  cups: 236.588,
  c: 236.588,
  'fl oz': 29.5735,
  floz: 29.5735,
  'fl-oz': 29.5735,
  pint: 473.176,
  pt: 473.176,
  quart: 946.353,
  qt: 946.353,
  gal: 3785.41,
  gallon: 3785.41,
};

const COUNT_ALIASES: Record<string, string> = {
  pc: 'pcs',
  pcs: 'pcs',
  piece: 'pcs',
  pieces: 'pcs',
  ea: 'pcs',
  each: 'pcs',
  whole: 'pcs',
  clove: 'pcs',
  cloves: 'pcs',
  slice: 'pcs',
  slices: 'pcs',
};

function norm(u: string): string {
  return u.trim().toLowerCase();
}

export type Dimension = 'mass' | 'volume' | 'count' | 'unknown';

export function dimensionOf(unit: string): Dimension {
  const u = norm(unit);
  if (MASS_TO_G[u] != null) return 'mass';
  if (VOL_TO_ML[u] != null) return 'volume';
  if (COUNT_ALIASES[u] != null) return 'count';
  return 'unknown';
}

/**
 * Convert qty from one unit to another.
 * - Returns the converted number when a conversion is known.
 * - Returns null when units aren't in the same dimension AND no density
 *   is provided, or the units are simply unknown.
 * - For same-string units, returns qty as-is.
 */
export function convert(
  qty: number,
  from: string,
  to: string,
  densityGPerMl: number | null = null,
): number | null {
  const f = norm(from);
  const t = norm(to);
  if (f === t) return qty;

  // Count units canonicalize to 'pcs' — so 'piece' ↔ 'pcs' is allowed,
  // but 'pcs' ↔ 'g' is never allowed.
  const fCount = COUNT_ALIASES[f];
  const tCount = COUNT_ALIASES[t];
  if (fCount && tCount) return fCount === tCount ? qty : null;
  if (fCount || tCount) return null;

  const fMass = MASS_TO_G[f];
  const tMass = MASS_TO_G[t];
  const fVol = VOL_TO_ML[f];
  const tVol = VOL_TO_ML[t];

  if (fMass != null && tMass != null) return (qty * fMass) / tMass;
  if (fVol != null && tVol != null) return (qty * fVol) / tVol;

  if (densityGPerMl != null && densityGPerMl > 0) {
    if (fMass != null && tVol != null) {
      const grams = qty * fMass;
      const ml = grams / densityGPerMl;
      return ml / tVol;
    }
    if (fVol != null && tMass != null) {
      const ml = qty * fVol;
      const grams = ml * densityGPerMl;
      return grams / tMass;
    }
  }

  return null;
}

/**
 * True when two units can be converted into each other with the given density.
 */
export function canConvert(
  from: string,
  to: string,
  densityGPerMl: number | null = null,
): boolean {
  return convert(1, from, to, densityGPerMl) !== null;
}
