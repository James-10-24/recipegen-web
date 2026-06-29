// Default deduction step per unit, used by the inline minus stepper on
// each pantry row. One tap = one step. Repeated taps within the 4-second
// coalescing window aggregate into a single commit + a single undo
// opportunity.
//
// Sensible defaults — chosen so 1–3 taps covers the common snack/coffee
// case. Users who need precision tap the row's qty number to open the
// existing pantry-detail edit screen.
//
// These are tuneable. If post-launch data shows people tapping milk
// minus 10 times in a row, bump ml to 100. If users complain "I poured
// 50ml of stock into rice and the step ate the whole row," lower the
// relevant unit.

const STEP_BY_UNIT: Record<string, number> = {
  // Volume — small unit
  ml: 50,

  // Volume — large unit (0.1 L = 100ml — same scale as the ml step)
  l: 0.1,

  // Mass — small unit
  g: 50,

  // Mass — large unit
  kg: 0.1,

  // Whole-item units (snap-to-pantry frequently produces these)
  pcs: 1,
  pc: 1,
  slice: 1,
  slices: 1,
  clove: 1,
  cloves: 1,
  egg: 1,
  eggs: 1,

  // Cooking spoons / cups
  tsp: 1,
  tbsp: 1,
  cup: 0.25,
  cups: 0.25,
};

/**
 * Look up the default step for a given unit string. Case-insensitive.
 * Unknown units fall back to 1 — a safe default for one-of-a-kind
 * countable items the user added manually.
 */
export function defaultStep(unit: string): number {
  const key = unit.trim().toLowerCase();
  return STEP_BY_UNIT[key] ?? 1;
}

/**
 * Round a numeric qty for display so 1.4500000001 doesn't appear after
 * arithmetic drift. Two decimal places is plenty for any cooking unit.
 */
export function roundQty(qty: number): number {
  return Math.round(qty * 100) / 100;
}
