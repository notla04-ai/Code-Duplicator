import type { HandResult, ArchivedShoe } from './types';

// ─── Legacy Types (UI backward compat) ────────────────────────────────────────

export type TrapType =
  | 'LONG_STREAK_BAIT'
  | 'CHOP_BAIT'
  | 'FAKE_REVERSAL'
  | 'STREAK_EXHAUSTION'
  | 'CROWD_FOLLOW_TRAP'
  | 'LOSS_CHASE_TRIGGER'
  | 'TIE_DISTRACTION'
  | 'SIDE_BET_BAIT';

export interface TrapDetection {
  type: TrapType;
  label: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  detail: string;
}

export interface TransitionMatrix {
  BB: number;
  BP: number;
  PB: number;
  PP: number;
}

export interface RandomnessScore {
  shannonEntropy: number;
  chiSquare: number;
  chiSquareSignificant: boolean;
  runsTestZ: number;
  autocorrelationLag1: number;
  transitionMatrix: TransitionMatrix;
  verdict: 'STRUCTURED' | 'MIXED' | 'RANDOM';
  biasEvidence: string;
  bankerPct: number;
  playerPct: number;
}

export interface ShoeFingerprint {
  streakCounts: Record<number, number>;
  chopRate: number;
  avgRunLength: number;
  bankerPct: number;
  playerPct: number;
  matchedArchiveId: number | null;
  similarityScore: number;
}

export interface ScreenIntegrity {
  valid: boolean;
  issues: string[];
  handCount: number;
}

// ─── New Stochastic Engine Types ──────────────────────────────────────────────

export interface EntropyAnalysis {
  shannon: number;
  permutation: number;
  lempelZiv: number;
  verdict: 'MAXIMUM' | 'HIGH' | 'REDUCED' | 'LOW';
  significantDrop: boolean;
  detail: string;
}

export interface TransitionPersistence {
  rawCounts: { BB: number; BP: number; PB: number; PP: number };
  pctMatrix: { BB: number; BP: number; PB: number; PP: number };
  chiSquare: number;
  pValue: number;
  cramersV: number;
  stationarity: number;
  bankerContinuation: number;
  playerContinuation: number;
  persistent: boolean;
  detail: string;
}

export interface StreakModel {
  currentStreak: number;
  currentSide: 'B' | 'P' | null;
  pContinues: number;
  observedTrials: number;
  exhaustionRisk: boolean;
  geometricMean: number;
  detail: string;
}

export interface BaitPattern {
  id: string;
  label: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  confidence: number;
  detail: string;
}

export interface DeviationTest {
  name: string;
  statistic: number;
  pValue: number;
  significant: boolean;
  direction: string;
  effectSize: number;
}

export interface EdgeGateCheck {
  pass: boolean;
  value: string;
  detail: string;
}

export interface EdgeGate {
  pass: boolean;
  checksPass: number;
  checksTotal: number;
  suggestedSide: 'B' | 'P' | 'SKIP';
  reason: string;
  checks: {
    sampleSize: EdgeGateCheck;
    entropyDrop: EdgeGateCheck;
    effectSize: EdgeGateCheck;
    transitionPersists: EdgeGateCheck;
    crossShoeBias: EdgeGateCheck;
  };
}

// ─── Truth Gate ───────────────────────────────────────────────────────────────

export type TruthGateVerdict = 'BANKER' | 'PLAYER' | 'TIE' | 'NO_BET' | 'SKIP';

export interface TruthGateCondition {
  id: string;
  label: string;
  priority: number;
  triggered: boolean;
  triggeredLabel: string;
  detail: string;
}

export interface TruthGate {
  finalVerdict: TruthGateVerdict;
  fakeConsensus: boolean;
  roadInvalidated: boolean;
  disabledVoterIds: string[];
  priorityPath: string[];
  overrideReason: string;
  rawEnsembleVote: string;
  conditions: TruthGateCondition[];
}

export interface AnalysisReport {
  traps: TrapDetection[];
  randomness: RandomnessScore;
  fingerprint: ShoeFingerprint;
  integrity: ScreenIntegrity;
  noEdge: boolean;
  noEdgeReason: string;
  entropy: EntropyAnalysis;
  transitions: TransitionPersistence;
  streakModel: StreakModel;
  baitPatterns: BaitPattern[];
  deviations: DeviationTest[];
  edgeGate: EdgeGate;
  truthGate: TruthGate;
}

// ─── Math Primitives ──────────────────────────────────────────────────────────

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const p = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const r = 1 - p * Math.exp(-(x * x));
  return x < 0 ? -r : r;
}

function chi2pv(chi2: number): number {
  if (chi2 <= 0) return 1;
  return 1 - erf(Math.sqrt(chi2 / 2));
}

function factorial(n: number): number {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function bpOnly(hands: HandResult[]): ('B' | 'P')[] {
  return hands.filter(h => h.side !== 'T').map(h => h.side as 'B' | 'P');
}

function toBinary(bp: ('B' | 'P')[]): number[] {
  return bp.map(s => (s === 'B' ? 1 : 0));
}

function currentStreakLen(bp: ('B' | 'P')[]): number {
  if (bp.length === 0) return 0;
  const last = bp[bp.length - 1];
  let len = 0;
  for (let i = bp.length - 1; i >= 0; i--) {
    if (bp[i] === last) len++;
    else break;
  }
  return len;
}

// ─── Shannon Entropy ──────────────────────────────────────────────────────────

function shannonEntropy(bp: ('B' | 'P')[]): number {
  const n = bp.length;
  if (n === 0) return 1;
  const pb = bp.filter(s => s === 'B').length / n;
  const pp = 1 - pb;
  if (pb === 0 || pp === 0) return 0;
  return -(pb * Math.log2(pb) + pp * Math.log2(pp));
}

// ─── Permutation Entropy (order m=3) ─────────────────────────────────────────

function permutationEntropy(seq: number[], m: number = 3): number {
  const n = seq.length;
  if (n < m + 1) return 1.0;
  const counts = new Map<string, number>();
  let total = 0;
  for (let i = 0; i <= n - m; i++) {
    const window = seq.slice(i, i + m);
    const indexed = window.map((v, j) => ({ v, j }));
    indexed.sort((a, b) => a.v !== b.v ? a.v - b.v : a.j - b.j);
    const perm = indexed.map(x => x.j).join('');
    counts.set(perm, (counts.get(perm) || 0) + 1);
    total++;
  }
  let H = 0;
  for (const count of counts.values()) {
    const p = count / total;
    H -= p * Math.log2(p);
  }
  const maxH = Math.log2(factorial(m));
  return maxH > 0 ? H / maxH : 1.0;
}

// ─── Lempel-Ziv Complexity ────────────────────────────────────────────────────

function lzComplexity(seq: number[]): number {
  const s = seq.join('');
  const n = s.length;
  if (n === 0) return 0;
  const substrings = new Set<string>();
  let start = 0;
  while (start < n) {
    let end = start + 1;
    while (end <= n) {
      const sub = s.slice(start, end);
      if (!substrings.has(sub)) { substrings.add(sub); break; }
      end++;
    }
    start = end;
  }
  const maxC = n > 1 ? n / Math.log2(n) : 1;
  return Math.min(1, substrings.size / maxC);
}

// ─── Entropy Analysis ─────────────────────────────────────────────────────────

function analyzeEntropy(bp: ('B' | 'P')[]): EntropyAnalysis {
  const n = bp.length;
  const bin = toBinary(bp);
  const shannon = n >= 4 ? shannonEntropy(bp) : 1.0;
  const permut = n >= 6 ? permutationEntropy(bin, 3) : 1.0;
  const lz = n >= 8 ? lzComplexity(bin) : 1.0;

  const significantDrop = shannon < 0.985 && n >= 20;

  const verdict: EntropyAnalysis['verdict'] =
    shannon > 0.998 ? 'MAXIMUM' :
    shannon > 0.985 ? 'HIGH' :
    shannon > 0.94  ? 'REDUCED' : 'LOW';

  const detail =
    n < 20 ? `Insufficient sample (${n} BP hands)` :
    verdict === 'MAXIMUM' ? `H=${shannon.toFixed(4)} — statistically indistinguishable from true random` :
    verdict === 'HIGH' ? `H=${shannon.toFixed(4)} — near-maximum, no actionable signal` :
    verdict === 'REDUCED' ? `H=${shannon.toFixed(4)} — measurable reduction, requires corroboration` :
    `H=${shannon.toFixed(4)} — significant entropy drop, bias evidence present`;

  return { shannon, permutation: permut, lempelZiv: lz, verdict, significantDrop, detail };
}

// ─── Transition Persistence ───────────────────────────────────────────────────

function rawTransCounts(bp: ('B' | 'P')[]) {
  let BB = 0, BP_c = 0, PB = 0, PP = 0;
  for (let i = 1; i < bp.length; i++) {
    if (bp[i - 1] === 'B' && bp[i] === 'B') BB++;
    else if (bp[i - 1] === 'B' && bp[i] === 'P') BP_c++;
    else if (bp[i - 1] === 'P' && bp[i] === 'B') PB++;
    else PP++;
  }
  return { BB, BP: BP_c, PB, PP };
}

function analyzeTransitions(bp: ('B' | 'P')[]): TransitionPersistence {
  const n = bp.length;
  const raw = rawTransCounts(bp);
  const { BB, BP: BP_c, PB, PP } = raw;

  const bTrans = BB + BP_c || 1;
  const pTrans = PB + PP || 1;
  const total = bTrans + pTrans;

  const pctMatrix = {
    BB: Math.round((BB / bTrans) * 100),
    BP: Math.round((BP_c / bTrans) * 100),
    PB: Math.round((PB / pTrans) * 100),
    PP: Math.round((PP / pTrans) * 100),
  };

  // Chi-square test for independence on 2x2 transition matrix
  // H0: row and column independent (no transition preference)
  const rowB = BB + BP_c;
  const rowP = PB + PP;
  const colB = BB + PB;
  const colP = BP_c + PP;
  const N = total;
  let chi2 = 0;
  if (N > 0) {
    const cells = [[BB, rowB * colB / N], [BP_c, rowB * colP / N], [PB, rowP * colB / N], [PP, rowP * colP / N]];
    for (const [obs, exp] of cells) {
      if (exp > 0) chi2 += (obs - exp) ** 2 / exp;
    }
  }
  const pValue = chi2pv(chi2);
  const cramersV = N > 0 ? Math.sqrt(chi2 / N) : 0;

  // Bayesian posterior P(continues | side) — Beta with Jeffrey's prior (0.5, 0.5)
  const bankerContinuation = (BB + 0.5) / (bTrans + 1);
  const playerContinuation = (PP + 0.5) / (pTrans + 1);

  // Stationarity: cosine similarity between first-half and second-half transition vectors
  const mid = Math.floor(bp.length / 2);
  const r1 = rawTransCounts(bp.slice(0, mid));
  const r2 = rawTransCounts(bp.slice(mid));
  const v1 = [r1.BB, r1.BP, r1.PB, r1.PP];
  const v2 = [r2.BB, r2.BP, r2.PB, r2.PP];
  const dot = v1.reduce((s, x, i) => s + x * v2[i], 0);
  const m1 = Math.sqrt(v1.reduce((s, x) => s + x * x, 0));
  const m2 = Math.sqrt(v2.reduce((s, x) => s + x * x, 0));
  const stationarity = m1 > 0 && m2 > 0 ? dot / (m1 * m2) : 0;

  const persistent = n >= 30 && pValue < 0.05 && stationarity > 0.88;

  let detail = n < 12 ? `Need ≥12 BP hands (have ${n})` :
    persistent
      ? `χ²=${chi2.toFixed(2)} p=${pValue.toFixed(3)} V=${cramersV.toFixed(3)} — persistent transition bias (stable across shoe halves)`
      : pValue < 0.05
        ? `χ²=${chi2.toFixed(2)} p=${pValue.toFixed(3)} — transition bias detected but stationarity ${(stationarity * 100).toFixed(0)}% (unstable)`
        : `χ²=${chi2.toFixed(2)} p=${pValue.toFixed(3)} — no significant transition preference`;

  return { rawCounts: raw, pctMatrix, chiSquare: chi2, pValue, cramersV, stationarity, bankerContinuation, playerContinuation, persistent, detail };
}

// ─── Streak Model (Bayesian Posterior) ───────────────────────────────────────

function buildStreakModel(bp: ('B' | 'P')[]): StreakModel {
  const streak = currentStreakLen(bp);
  const side = bp.length > 0 ? bp[bp.length - 1] : null;

  // Count continuation events for current side
  let successes = 0, trials = 0;
  for (let i = 1; i < bp.length; i++) {
    if (bp[i - 1] === side) {
      trials++;
      if (bp[i] === side) successes++;
    }
  }

  // Beta posterior with Jeffrey's prior
  const alpha = successes + 0.5;
  const beta = (trials - successes) + 0.5;
  const pCont = alpha / (alpha + beta);

  // Geometric distribution mean under posterior
  const geometricMean = pCont > 0 ? 1 / (1 - pCont) : Infinity;

  // Exhaustion: current streak exceeds geometric mean by >1 SD
  const exhaustionRisk = streak > 0 && geometricMean < Infinity && streak >= geometricMean * 1.5;

  let detail = side === null ? 'No data'
    : trials < 5 ? `Too few transitions to model (${trials} observed)`
    : `P(${side}|${side})=${(pCont * 100).toFixed(1)}% posterior · E[streak]=${geometricMean.toFixed(1)} · current=${streak}${exhaustionRisk ? ' · EXHAUSTION ZONE' : ''}`;

  return { currentStreak: streak, currentSide: side, pContinues: pCont, observedTrials: trials, exhaustionRisk, geometricMean, detail };
}

// ─── CUSUM Structural Break ───────────────────────────────────────────────────

function cusumBreak(bin: number[], target: number): { maxPos: number | null; maxVal: number } {
  let cum = 0, maxVal = 0, maxPos: number | null = null;
  const threshold = 3 * Math.sqrt(bin.length);
  for (let i = 0; i < bin.length; i++) {
    cum += bin[i] - target;
    if (Math.abs(cum) > maxVal) {
      maxVal = Math.abs(cum);
      if (Math.abs(cum) > threshold) maxPos = i;
    }
  }
  return { maxPos, maxVal };
}

// ─── Cohen's h Effect Size ────────────────────────────────────────────────────

function cohensH(p1: number, p2: number): number {
  return Math.abs(2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, p1)))) -
                  2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, p2)))));
}

// ─── Deviation Tests ──────────────────────────────────────────────────────────

function runDeviationTests(bp: ('B' | 'P')[]): DeviationTest[] {
  const n = bp.length;
  if (n < 8) return [];
  const tests: DeviationTest[] = [];
  const bin = toBinary(bp);
  const bCount = bin.reduce((s, x) => s + x, 0);
  const pb = bCount / n;

  // 1. Side distribution chi-square (vs true baccarat odds 50.68/49.32)
  const expB = n * 0.5068, expP = n * 0.4932;
  const chi2Side = ((bCount - expB) ** 2 / expB) + (((n - bCount) - expP) ** 2 / expP);
  const pSide = chi2pv(chi2Side);
  const h = cohensH(pb, 0.5068);
  tests.push({
    name: 'Side Distribution χ²',
    statistic: chi2Side,
    pValue: pSide,
    significant: pSide < 0.05,
    direction: pb > 0.5068 ? `BANKER bias (+${((pb - 0.5068) * 100).toFixed(1)}%)` : `PLAYER bias (+${((0.5068 - pb) * 100).toFixed(1)}%)`,
    effectSize: h,
  });

  // 2. Wald-Wolfowitz runs test
  let runs = 1;
  for (let i = 1; i < n; i++) if (bp[i] !== bp[i - 1]) runs++;
  const pCount = n - bCount;
  const expRuns = (2 * bCount * pCount) / n + 1;
  const varRuns = n > 1 ? (2 * bCount * pCount * (2 * bCount * pCount - n)) / (n * n * (n - 1)) : 1;
  const runsZ = varRuns > 0 ? (runs - expRuns) / Math.sqrt(varRuns) : 0;
  const pRuns = 2 * (1 - Math.min(1, (1 + erf(Math.abs(runsZ) / Math.sqrt(2))) / 2));
  tests.push({
    name: 'Runs Test (Wald-Wolfowitz)',
    statistic: runsZ,
    pValue: pRuns,
    significant: Math.abs(runsZ) > 1.96,
    direction: runsZ < -1.96 ? 'STREAKY (fewer runs than expected)' : runsZ > 1.96 ? 'CHOPPY (more runs than expected)' : 'Normal run distribution',
    effectSize: Math.abs(runsZ) / Math.sqrt(n),
  });

  // 3. Autocorrelation lag-1
  const mean = pb;
  let numAC = 0, denomAC = 0;
  for (let i = 0; i < n; i++) denomAC += (bin[i] - mean) ** 2;
  for (let i = 0; i < n - 1; i++) numAC += (bin[i] - mean) * (bin[i + 1] - mean);
  const autocorr = denomAC > 0 ? numAC / denomAC : 0;
  const acZ = autocorr * Math.sqrt(n - 1);
  const pAC = 2 * (1 - Math.min(1, (1 + erf(Math.abs(acZ) / Math.sqrt(2))) / 2));
  tests.push({
    name: 'Autocorrelation Lag-1',
    statistic: autocorr,
    pValue: pAC,
    significant: Math.abs(acZ) > 1.96,
    direction: autocorr > 0.1 ? 'Positive (momentum / streaky)' : autocorr < -0.1 ? 'Negative (mean-reverting / choppy)' : 'Near-zero',
    effectSize: Math.abs(autocorr),
  });

  // 4. CUSUM structural break
  const cusum = cusumBreak(bin, 0.5068);
  const cusumSig = cusum.maxPos !== null;
  tests.push({
    name: 'CUSUM Structural Break',
    statistic: cusum.maxVal,
    pValue: cusumSig ? 0.02 : 0.5,
    significant: cusumSig,
    direction: cusumSig ? `Break detected at hand ~${cusum.maxPos}` : 'No structural break',
    effectSize: cusum.maxVal / Math.sqrt(n),
  });

  // 5. Permutation entropy deviation
  const pe = permutationEntropy(bin, 3);
  const peDeviation = 1 - pe;
  tests.push({
    name: 'Permutation Entropy (order 3)',
    statistic: pe,
    pValue: pe < 0.90 ? 0.02 : pe < 0.95 ? 0.08 : 0.4,
    significant: pe < 0.92,
    direction: pe > 0.97 ? 'Near-maximum (random temporal structure)' : pe > 0.92 ? 'Slight temporal structure' : 'Significant temporal non-randomness',
    effectSize: peDeviation,
  });

  return tests;
}

// ─── Bait Pattern Detector ────────────────────────────────────────────────────

function detectBaitPatterns(hands: HandResult[]): BaitPattern[] {
  const bp = bpOnly(hands);
  const n = bp.length;
  const patterns: BaitPattern[] = [];
  if (n < 8) return patterns;

  // 1. Escalating Clarity Trap: local entropy much lower than global entropy
  const globalH = shannonEntropy(bp);
  const localBp = bp.slice(-8);
  const localH = shannonEntropy(localBp);
  if (n >= 20 && localH < globalH - 0.15 && localBp.length >= 6) {
    const conf = Math.min(1, (globalH - localH) / 0.4);
    patterns.push({
      id: 'ESCALATING_CLARITY',
      label: 'Escalating Clarity Trap',
      severity: conf > 0.6 ? 'HIGH' : 'MEDIUM',
      confidence: conf,
      detail: `Recent 8-hand entropy (H=${localH.toFixed(3)}) is much lower than shoe entropy (H=${globalH.toFixed(3)}) — false clarity illusion`,
    });
  }

  // 2. Phantom Momentum: exactly 3-4 same-side hands ending now
  const streak = currentStreakLen(bp);
  if (streak >= 3 && streak <= 4) {
    const side = bp[bp.length - 1];
    patterns.push({
      id: 'PHANTOM_MOMENTUM',
      label: 'Phantom Momentum',
      severity: 'MEDIUM',
      confidence: streak === 4 ? 0.72 : 0.55,
      detail: `Exactly ${streak}-hand ${side === 'B' ? 'BANKER' : 'PLAYER'} run exploits human "3-4 is a trend" heuristic — no statistical significance`,
    });
  }

  // 3. Regression Illusion: dominant side → sudden opposite mini-run
  if (n >= 15) {
    const bTotal = bp.filter(s => s === 'B').length;
    const domSide: 'B' | 'P' = bTotal > n / 2 ? 'B' : 'P';
    const last5 = bp.slice(-5);
    const oppCount = last5.filter(s => s !== domSide).length;
    if (oppCount >= 3 && bTotal / n > 0.57) {
      patterns.push({
        id: 'REGRESSION_ILLUSION',
        label: 'Regression Illusion',
        severity: 'HIGH',
        confidence: Math.min(1, oppCount / 5 + 0.3),
        detail: `After ${Math.round(bTotal / n * 100)}% ${domSide === 'B' ? 'BANKER' : 'PLAYER'} dominance, ${oppCount}/5 recent flips trigger "balancing" fallacy — gambler's fallacy at work`,
      });
    }
  }

  // 4. Phase-Shift Mirror: alternating block → reversed alternating block
  if (n >= 12) {
    const block1 = bp.slice(-12, -6);
    const block2 = bp.slice(-6);
    let alts1 = 0, alts2 = 0;
    for (let i = 1; i < 6; i++) {
      if (block1[i] !== block1[i - 1]) alts1++;
      if (block2[i] !== block2[i - 1]) alts2++;
    }
    if (alts1 >= 4 && alts2 >= 4 && block1[0] !== block2[0]) {
      patterns.push({
        id: 'PHASE_SHIFT_MIRROR',
        label: 'Phase-Shift Mirror',
        severity: 'MEDIUM',
        confidence: 0.65,
        detail: 'B-P-B-P... then P-B-P-B... — apparent phase shift creates illusion of a "new chop cycle" starting',
      });
    }
  }

  // 5. Late-Shoe Normalization Trap: very deep shoe with one-side bias shifting
  if (n >= 50) {
    const earlyBp = bp.slice(0, 25);
    const lateBp = bp.slice(-15);
    const earlyB = earlyBp.filter(s => s === 'B').length / 25;
    const lateB = lateBp.filter(s => s === 'B').length / 15;
    if (Math.abs(earlyB - 0.5) > 0.1 && Math.abs(lateB - 0.5) < 0.05) {
      patterns.push({
        id: 'LATE_SHOE_NORMALIZATION',
        label: 'Late-Shoe Normalization Trap',
        severity: 'MEDIUM',
        confidence: 0.6,
        detail: `Early shoe ${earlyB > 0.5 ? 'BANKER' : 'PLAYER'} bias (${Math.round(Math.max(earlyB, 1 - earlyB) * 100)}%) appears to "normalize" late — do not interpret as reversion signal`,
      });
    }
  }

  // 6. False Confirmation Cascade: 3+ consecutive "correct" side predictions in a row triggering overconfidence
  if (n >= 8 && streak >= 3) {
    const sideNow = bp[n - 1];
    const bRatio = bp.filter(s => s === 'B').length / n;
    const sideBias = sideNow === 'B' ? bRatio : 1 - bRatio;
    if (sideBias > 0.55) {
      patterns.push({
        id: 'FALSE_CONFIRMATION_CASCADE',
        label: 'False Confirmation Cascade',
        severity: 'LOW',
        confidence: Math.min(1, (sideBias - 0.5) * 4),
        detail: `${streak}-hand streak matches shoe-dominant side — creates confirmation loop; bias may be memory artifact not predictable edge`,
      });
    }
  }

  return patterns;
}

// ─── Legacy Trap Detector ─────────────────────────────────────────────────────

export function detectTraps(hands: HandResult[]): TrapDetection[] {
  const bp = bpOnly(hands);
  const traps: TrapDetection[] = [];
  if (bp.length < 5) return traps;
  const streak = currentStreakLen(bp);
  const last = bp[bp.length - 1];

  if (streak >= 6) {
    traps.push({ type: 'LONG_STREAK_BAIT', label: 'Long Streak Bait', severity: streak >= 9 ? 'HIGH' : 'MEDIUM',
      detail: `${last === 'B' ? 'BANKER' : 'PLAYER'} on a ${streak}-hand streak — psychological pressure to follow` });
  }

  const tail8 = bp.slice(-8);
  let alts8 = 0;
  for (let i = 1; i < tail8.length; i++) if (tail8[i] !== tail8[i - 1]) alts8++;
  const chopRate8 = tail8.length > 1 ? alts8 / (tail8.length - 1) : 0;
  if (chopRate8 >= 0.8 && tail8.length >= 6) {
    traps.push({ type: 'CHOP_BAIT', label: 'Chop Bait', severity: 'MEDIUM',
      detail: `${tail8.length}-hand alternating pattern (${Math.round(chopRate8 * 100)}% chop) — do not assume it continues` });
  }

  if (bp.length >= 7 && streak <= 2 && streak >= 1) {
    const preWindow = bp.slice(-(streak + 5), -streak);
    if (preWindow.length >= 4) {
      const prevSide = preWindow[preWindow.length - 1];
      const prevStreak = preWindow.filter(s => s === prevSide).length;
      if (prevStreak >= 4 && prevSide !== last) {
        traps.push({ type: 'FAKE_REVERSAL', label: 'Fake Reversal', severity: 'HIGH',
          detail: `Only ${streak}-hand break after ${prevStreak}-${prevSide === 'B' ? 'BANKER' : 'PLAYER'} run — may be false reversal` });
      }
    }
  }

  if (streak >= 4 && streak <= 6) {
    let maxSeen = 0, cur = 1;
    for (let i = 1; i < bp.length - streak; i++) {
      if (bp[i] === bp[i - 1]) cur++; else { maxSeen = Math.max(maxSeen, cur); cur = 1; }
    }
    maxSeen = Math.max(maxSeen, cur);
    if (streak >= maxSeen && maxSeen >= 4) {
      traps.push({ type: 'STREAK_EXHAUSTION', label: 'Streak Exhaustion', severity: 'LOW',
        detail: `Current streak ${streak} matches shoe max — reversal probability elevated` });
    }
  }

  const last3 = hands.slice(-3);
  if (last3.some(h => h.side === 'T') && streak >= 2) {
    traps.push({ type: 'TIE_DISTRACTION', label: 'Tie Distraction', severity: 'LOW',
      detail: 'Recent tie interrupts streak rhythm — watch for side-bet pressure' });
  }

  const tail15 = bp.slice(-15);
  if (tail15.length >= 10) {
    const bC = tail15.filter(s => s === 'B').length;
    const dom = Math.max(bC, tail15.length - bC) / tail15.length;
    if (dom >= 0.72) {
      traps.push({ type: 'SIDE_BET_BAIT', label: 'Side Dominance Bait', severity: 'MEDIUM',
        detail: `${bC > tail15.length / 2 ? 'BANKER' : 'PLAYER'} at ${Math.round(dom * 100)}% over last ${tail15.length} — statistical overextension` });
    }
  }

  if (streak >= 4 && bp.length >= 20) {
    const bTotal = bp.filter(s => s === 'B').length;
    const domSide = bTotal > bp.length / 2 ? 'B' : 'P';
    if (last === domSide) {
      traps.push({ type: 'CROWD_FOLLOW_TRAP', label: 'Crowd-Follow Trap', severity: 'MEDIUM',
        detail: `${last === 'B' ? 'BANKER' : 'PLAYER'} is both shoe-dominant and on streak — herding bias active` });
    }
  }

  if (streak >= 3 && bp.length >= 15) {
    const bTotal = bp.filter(s => s === 'B').length;
    const recentDom = bTotal / bp.length > 0.55 ? 'B' : bTotal / bp.length < 0.45 ? 'P' : null;
    if (recentDom && last !== recentDom) {
      traps.push({ type: 'LOSS_CHASE_TRIGGER', label: 'Loss-Chase Trigger', severity: 'MEDIUM',
        detail: `Betting against dominant side (${recentDom === 'B' ? 'BANKER' : 'PLAYER'}) after ${streak}-hand mini-run may indicate chasing` });
    }
  }

  return traps;
}

// ─── Legacy Randomness Score ──────────────────────────────────────────────────

export function testRandomness(hands: HandResult[]): RandomnessScore {
  const bp = bpOnly(hands);
  const n = bp.length;
  const empty: RandomnessScore = {
    shannonEntropy: 1.0, chiSquare: 0, chiSquareSignificant: false,
    runsTestZ: 0, autocorrelationLag1: 0,
    transitionMatrix: { BB: 50, BP: 50, PB: 50, PP: 50 },
    verdict: 'RANDOM', biasEvidence: `Insufficient sample (${n})`, bankerPct: 50, playerPct: 50,
  };
  if (n < 8) return empty;

  const bCount = bp.filter(s => s === 'B').length;
  const pCount = n - bCount;
  const pb = bCount / n;
  const entropy = shannonEntropy(bp);
  const expB = n * 0.5068, expP = n * 0.4932;
  const chiSq = ((bCount - expB) ** 2 / expB) + ((pCount - expP) ** 2 / expP);
  const chiSignificant = chiSq > 3.84;
  const bin = toBinary(bp);
  let runs = 1;
  for (let i = 1; i < n; i++) if (bp[i] !== bp[i - 1]) runs++;
  const expRuns = (2 * bCount * pCount) / n + 1;
  const varRuns = n > 1 ? (2 * bCount * pCount * (2 * bCount * pCount - n)) / (n * n * (n - 1)) : 1;
  const runsZ = varRuns > 0 ? (runs - expRuns) / Math.sqrt(varRuns) : 0;
  const mean = pb;
  let numAC = 0, denomAC = 0;
  for (let i = 0; i < n; i++) denomAC += (bin[i] - mean) ** 2;
  for (let i = 0; i < n - 1; i++) numAC += (bin[i] - mean) * (bin[i + 1] - mean);
  const autocorr = denomAC > 0 ? numAC / denomAC : 0;

  const { BB, BP: BP_c, PB, PP } = rawTransCounts(bp);
  const bTrans = BB + BP_c || 1, pTrans = PB + PP || 1;
  const transitionMatrix: TransitionMatrix = {
    BB: Math.round(BB / bTrans * 100), BP: Math.round(BP_c / bTrans * 100),
    PB: Math.round(PB / pTrans * 100), PP: Math.round(PP / pTrans * 100),
  };

  let structuredScore = 0;
  if (entropy < 0.96) structuredScore++;
  if (Math.abs(runsZ) > 1.96) structuredScore++;
  if (chiSignificant) structuredScore++;
  if (Math.abs(autocorr) > 0.12) structuredScore++;

  const verdict: RandomnessScore['verdict'] = structuredScore >= 3 ? 'STRUCTURED' : structuredScore >= 1 ? 'MIXED' : 'RANDOM';
  const bPct = Math.round(pb * 100);
  let biasEvidence = bPct > 53 ? `BANKER bias ${bPct}%` : bPct < 47 ? `PLAYER bias ${100 - bPct}%` : `Balanced B:${bPct}% P:${100 - bPct}%`;
  if (chiSignificant) biasEvidence += ` · χ²=${chiSq.toFixed(1)} p<0.05`;
  if (Math.abs(runsZ) > 1.96) biasEvidence += ` · Z=${runsZ.toFixed(2)} (${runsZ < 0 ? 'streaky' : 'choppy'})`;

  return { shannonEntropy: entropy, chiSquare: chiSq, chiSquareSignificant: chiSignificant, runsTestZ: runsZ, autocorrelationLag1: autocorr, transitionMatrix, verdict, biasEvidence, bankerPct: bPct, playerPct: 100 - bPct };
}

// ─── Shoe Fingerprinter ───────────────────────────────────────────────────────

export function fingerprintShoe(hands: HandResult[], archived: ArchivedShoe[]): ShoeFingerprint {
  const bp = bpOnly(hands);
  const n = bp.length;
  const streakCounts: Record<number, number> = {};
  let cur = 1;
  for (let i = 1; i < bp.length; i++) {
    if (bp[i] === bp[i - 1]) cur++;
    else { streakCounts[cur] = (streakCounts[cur] || 0) + 1; cur = 1; }
  }
  if (bp.length > 0) streakCounts[cur] = (streakCounts[cur] || 0) + 1;
  let alts = 0;
  for (let i = 1; i < bp.length; i++) if (bp[i] !== bp[i - 1]) alts++;
  const chopRate = n > 1 ? alts / (n - 1) : 0;
  const runs: number[] = [];
  let curRun = 1;
  for (let i = 1; i < bp.length; i++) { if (bp[i] === bp[i - 1]) curRun++; else { runs.push(curRun); curRun = 1; } }
  if (bp.length > 0) runs.push(curRun);
  const avgRunLength = runs.length > 0 ? runs.reduce((a, b) => a + b, 0) / runs.length : 1;
  const bCount = bp.filter(s => s === 'B').length;
  const bankerPct = n > 0 ? bCount / n : 0.5;
  const playerPct = n > 0 ? (n - bCount) / n : 0.5;

  let matchedArchiveId: number | null = null, bestSimilarity = 0;
  for (const shoe of archived) {
    if (shoe.totalHands < 12 || n < 12) continue;
    const archBankerPct = shoe.bankerPct / 100;
    const bDiff = Math.abs(bankerPct - archBankerPct);
    const sim = 1 - bDiff * 0.8;
    if (sim > bestSimilarity && sim > 0.88) { bestSimilarity = sim; matchedArchiveId = shoe.id; }
  }
  return { streakCounts, chopRate, avgRunLength, bankerPct, playerPct, matchedArchiveId, similarityScore: bestSimilarity };
}

// ─── Screen Integrity Auditor ─────────────────────────────────────────────────

export function auditScreenIntegrity(hands: HandResult[]): ScreenIntegrity {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const h of hands) {
    if (seen.has(h.id)) issues.push(`Duplicate hand ID at #${h.number}`);
    seen.add(h.id);
  }
  for (let i = 1; i < hands.length; i++) {
    if (hands[i].number < hands[i - 1].number) {
      issues.push(`Out-of-order at position ${i} (hand #${hands[i].number} after #${hands[i - 1].number})`);
      break;
    }
  }
  const invalid = hands.filter(h => !['B', 'P', 'T'].includes(h.side));
  if (invalid.length > 0) issues.push(`${invalid.length} invalid result code(s)`);
  const tieCount = hands.filter(h => h.side === 'T').length;
  const tiePct = hands.length > 0 ? tieCount / hands.length : 0;
  if (tiePct > 0.20 && hands.length >= 15) issues.push(`High tie rate: ${Math.round(tiePct * 100)}% (expected ~9-11%)`);
  return { valid: issues.length === 0, issues, handCount: hands.length };
}

// ─── Edge Gate — 5-condition hard validator ────────────────────────────────────
// ALL 5 must pass before any recommendation is issued. Edge is presumed absent.

export function buildEdgeGate(
  bp: ('B' | 'P')[],
  entropy: EntropyAnalysis,
  transitions: TransitionPersistence,
  deviations: DeviationTest[],
  archived: ArchivedShoe[],
  agreementCount: number,
): EdgeGate {
  const n = bp.length;
  const pb = n > 0 ? bp.filter(s => s === 'B').length / n : 0.5;
  const h = cohensH(pb, 0.5068);

  // Check 1: Minimum sample (≥ 30 BP hands)
  const samplePass = n >= 30;
  const sampleCheck: EdgeGateCheck = {
    pass: samplePass,
    value: `${n}/30`,
    detail: samplePass ? `${n} BP hands — sufficient sample` : `${n} BP hands — need ≥30 before any edge claim`,
  };

  // Check 2: Shannon entropy significantly below maximum (< 0.985)
  const entropyPass = entropy.significantDrop;
  const entropyCheck: EdgeGateCheck = {
    pass: entropyPass,
    value: entropy.shannon.toFixed(4),
    detail: entropyPass ? `H=${entropy.shannon.toFixed(4)} < 0.985 — meaningful entropy reduction` : `H=${entropy.shannon.toFixed(4)} ≥ 0.985 — entropy consistent with true random`,
  };

  // Check 3: Effect size above noise floor (Cohen's h ≥ 0.12)
  const effectPass = h >= 0.12;
  const effectCheck: EdgeGateCheck = {
    pass: effectPass,
    value: `h=${h.toFixed(3)}`,
    detail: effectPass ? `h=${h.toFixed(3)} ≥ 0.12 — effect size clears noise threshold` : `h=${h.toFixed(3)} < 0.12 — within noise floor, no exploitable bias`,
  };

  // Check 4: At least 2 independent statistical tests significant (from deviations)
  const sigTests = deviations.filter(d => d.significant);
  const transitionPass = transitions.persistent || sigTests.length >= 2;
  const transitionCheck: EdgeGateCheck = {
    pass: transitionPass,
    value: transitions.persistent ? `V=${transitions.cramersV.toFixed(3)}` : `${sigTests.length} sig tests`,
    detail: transitions.persistent
      ? `Transition bias persistent (χ²=${transitions.chiSquare.toFixed(2)} p=${transitions.pValue.toFixed(3)}, stationary=${(transitions.stationarity * 100).toFixed(0)}%)`
      : sigTests.length >= 2
        ? `${sigTests.length} independent tests significant: ${sigTests.map(d => d.name.split(' ')[0]).join(', ')}`
        : `Only ${sigTests.length}/2 tests significant — insufficient corroboration`,
  };

  // Check 5: Bias direction confirmed in ≥1 archived shoe
  const biasDir: 'B' | 'P' = pb > 0.5068 ? 'B' : 'P';
  const confirmedInArchive = archived.filter(shoe => {
    if (shoe.totalHands < 20) return false;
    const archPb = shoe.bankerPct / 100;
    return (biasDir === 'B' && archPb > 0.52) || (biasDir === 'P' && archPb < 0.48);
  }).length;
  const crossShoePass = confirmedInArchive >= 1;
  const crossShoeCheck: EdgeGateCheck = {
    pass: crossShoePass,
    value: `${confirmedInArchive} shoe(s)`,
    detail: crossShoePass
      ? `Same ${biasDir === 'B' ? 'BANKER' : 'PLAYER'} bias confirmed in ${confirmedInArchive} archived shoe(s)`
      : archived.length === 0
        ? 'No archived shoes — cannot cross-validate bias persistence'
        : `${biasDir === 'B' ? 'BANKER' : 'PLAYER'} bias not confirmed in any of ${archived.length} archived shoe(s)`,
  };

  const checksPass = [samplePass, entropyPass, effectPass, transitionPass, crossShoePass].filter(Boolean).length;
  const allPass = checksPass === 5;

  let suggestedSide: 'B' | 'P' | 'SKIP' = 'SKIP';
  if (allPass && h >= 0.12) {
    suggestedSide = biasDir;
  }

  const reason = allPass
    ? `All 5 gates clear — ${biasDir === 'B' ? 'BANKER' : 'PLAYER'} bias is statistically actionable`
    : `${5 - checksPass} gate(s) failed — SKIP. Agreement among AI voters (${agreementCount}/20) is NOT a substitute for statistical edge.`;

  return {
    pass: allPass,
    checksPass,
    checksTotal: 5,
    suggestedSide,
    reason,
    checks: { sampleSize: sampleCheck, entropyDrop: entropyCheck, effectSize: effectCheck, transitionPersists: transitionCheck, crossShoeBias: crossShoeCheck },
  };
}

// ─── Legacy No-Edge Rule ──────────────────────────────────────────────────────

export function applyNoEdgeRule(
  hands: HandResult[],
  randomness: RandomnessScore,
  agreementCount: number,
): { noEdge: boolean; reason: string } {
  const n = bpOnly(hands).length;
  if (n < 10) return { noEdge: true, reason: `Sample too small (${n} BP hands — need ≥10)` };
  if (randomness.shannonEntropy >= 0.998) return { noEdge: true, reason: `Maximum entropy (H=${randomness.shannonEntropy.toFixed(4)}) — shoe is statistically indistinguishable from random` };
  if (randomness.verdict === 'RANDOM' && agreementCount < 5) return { noEdge: true, reason: `Random shoe + low AI consensus (${agreementCount}/20) — no provable bias` };
  return { noEdge: false, reason: '' };
}

// ─── Truth Gate Builder ───────────────────────────────────────────────────────

export function buildTruthGate(
  entropy: EntropyAnalysis,
  randomness: RandomnessScore,
  integrity: ScreenIntegrity,
  transitions: TransitionPersistence,
  deviations: DeviationTest[],
  edgeGate: EdgeGate,
  archived: ArchivedShoe[],
  agreementCount: number,
  ensembleVote: string,
  voterStats: { id: string; allTimeCorrect: number; allTimeWrong: number }[],
): TruthGate {
  const conditions: TruthGateCondition[] = [];
  const disabledVoterIds: string[] = [];
  const priorityPath: string[] = [];
  let finalVerdict: TruthGateVerdict =
    ensembleVote === 'B' ? 'BANKER' :
    ensembleVote === 'P' ? 'PLAYER' :
    ensembleVote === 'T' ? 'TIE' : 'NO_BET';
  let overrideReason = '';
  let fakeConsensus = false;
  let roadInvalidated = false;
  let blocked = false;

  // ── Pre-pass: Voter accuracy gate (condition 4) ───────────────────────────
  for (const v of voterStats) {
    const resolved = v.allTimeCorrect + v.allTimeWrong;
    if (resolved >= 50 && v.allTimeCorrect / resolved < 0.55) {
      disabledVoterIds.push(v.id);
    }
  }
  conditions.push({
    id: 'VOTER_ACCURACY',
    label: 'Model Accuracy Gate',
    priority: 3,
    triggered: disabledVoterIds.length > 0,
    triggeredLabel: disabledVoterIds.length > 0 ? `${disabledVoterIds.length} DISABLED` : 'ALL ACTIVE',
    detail: disabledVoterIds.length > 0
      ? `Models below 55% accuracy over ≥50 resolved bets: ${disabledVoterIds.join(', ').toUpperCase()}`
      : 'All models above accuracy threshold or insufficient history',
  });

  // ── Priority 1: Screen Integrity ──────────────────────────────────────────
  priorityPath.push('P1·INTEGRITY');
  const integrityTriggered = !integrity.valid;
  conditions.push({
    id: 'INTEGRITY',
    label: 'Screen Integrity',
    priority: 1,
    triggered: integrityTriggered,
    triggeredLabel: integrityTriggered ? 'INVALIDATED' : 'VALID',
    detail: integrityTriggered
      ? `${integrity.issues.length} issue(s) — ${integrity.issues[0]}. All road-based predictions voided.`
      : `${integrity.handCount} hands verified — no sequence anomalies detected`,
  });
  if (integrityTriggered) {
    roadInvalidated = true;
    finalVerdict = 'SKIP';
    overrideReason = `[P1·INTEGRITY] ${integrity.issues[0]} — road predictions invalidated`;
    blocked = true;
  }

  // ── Priority 2: Entropy / Randomness ──────────────────────────────────────
  if (!blocked) {
    priorityPath.push('P2·ENTROPY');
    const pb = randomness.bankerPct / 100;
    const biasDir: 'B' | 'P' = pb >= 0.5 ? 'B' : 'P';

    // Condition 1: entropy >= 0.95 → SKIP unless 3+ archived shoes confirm bias
    const confirmedShoes = archived.filter(s => {
      if (s.totalHands < 20) return false;
      const ap = s.bankerPct / 100;
      return (biasDir === 'B' && ap > 0.52) || (biasDir === 'P' && ap < 0.48);
    }).length;
    const entropyBlocked = entropy.shannon >= 0.95 && confirmedShoes < 3;
    conditions.push({
      id: 'ENTROPY_GATE',
      label: 'Entropy Gate',
      priority: 2,
      triggered: entropyBlocked,
      triggeredLabel: entropyBlocked ? 'FORCE SKIP' : entropy.shannon >= 0.95 ? 'BYPASS (3+ shoes)' : 'PASS',
      detail: entropy.shannon >= 0.95
        ? confirmedShoes >= 3
          ? `H=${entropy.shannon.toFixed(4)} ≥ 0.95 but bias confirmed in ${confirmedShoes} archived shoes — conditional pass`
          : `H=${entropy.shannon.toFixed(4)} ≥ 0.95 with only ${confirmedShoes}/3 archive confirmations — forcing SKIP`
        : `H=${entropy.shannon.toFixed(4)} < 0.95 — entropy gate cleared`,
    });
    if (entropyBlocked) {
      finalVerdict = 'SKIP';
      overrideReason = `[P2·ENTROPY] H=${entropy.shannon.toFixed(4)} — cross-shoe bias unconfirmed (${confirmedShoes}/3 shoes)`;
      blocked = true;
    }

    // Condition 3: B/P bias within 47–53% → NO EDGE
    if (!blocked) {
      const bPct = randomness.bankerPct;
      const noEdgeBias = bPct >= 47 && bPct <= 53;
      conditions.push({
        id: 'BIAS_BOUNDARY',
        label: 'Bias Boundary Gate',
        priority: 2,
        triggered: noEdgeBias,
        triggeredLabel: noEdgeBias ? 'NO EDGE' : `${bPct}% BANKER`,
        detail: noEdgeBias
          ? `BANKER ${bPct}% / PLAYER ${randomness.playerPct}% — within 47–53% noise zone, no exploitable directional bias`
          : `BANKER ${bPct}% / PLAYER ${randomness.playerPct}% — outside noise zone`,
      });
      if (noEdgeBias) {
        finalVerdict = 'NO_BET';
        overrideReason = `[P2·ENTROPY] NO EDGE — bias ${bPct}%/${randomness.playerPct}% is within the 47–53% noise zone`;
        blocked = true;
      }
    }
  }

  // ── Priority 3: Real Hit Rate ──────────────────────────────────────────────
  if (!blocked) {
    priorityPath.push('P3·HIT RATE');
    // If majority of active voters are disabled → model degradation
    if (disabledVoterIds.length >= 10) {
      finalVerdict = 'NO_BET';
      overrideReason = `[P3·HIT RATE] ${disabledVoterIds.length}/20 models disabled — ensemble unreliable`;
      blocked = true;
    }
  }

  // ── Priority 4: Transition Persistence ────────────────────────────────────
  if (!blocked) {
    priorityPath.push('P4·TRANSITIONS');
    // Note: already evaluated in EdgeGate. Transition persistence alone doesn't
    // block here — it feeds into the EdgeGate check. If edge gate passed,
    // transitions were validated. If not, edgeGate captures it.
  }

  // ── Priority 5: Ensemble Vote ──────────────────────────────────────────────
  if (!blocked) {
    priorityPath.push('P5·ENSEMBLE');
    // Condition 2: High agreement but weak edge → FAKE CONSENSUS
    const highAgreement = agreementCount >= 14;
    const weakEdge = !edgeGate.pass;
    const sigTestCount = deviations.filter(d => d.significant).length;
    const fakeConsensusTriggered = highAgreement && weakEdge && sigTestCount < 2;
    conditions.push({
      id: 'FAKE_CONSENSUS',
      label: 'Fake Consensus Detector',
      priority: 5,
      triggered: fakeConsensusTriggered,
      triggeredLabel: fakeConsensusTriggered ? 'FAKE CONSENSUS' : highAgreement ? `${agreementCount}/20 VALID` : `${agreementCount}/20 NORMAL`,
      detail: fakeConsensusTriggered
        ? `${agreementCount}/20 voters agree (≥14) but edge gate failed and only ${sigTestCount}/2 statistical tests significant — AI correlation is NOT statistical edge. Downgraded to NO_BET.`
        : highAgreement
          ? `${agreementCount}/20 agreement backed by edge evidence — genuine consensus`
          : `${agreementCount}/20 agreement — within expected range`,
    });
    if (fakeConsensusTriggered) {
      fakeConsensus = true;
      finalVerdict = 'NO_BET';
      overrideReason = `[P5·ENSEMBLE] FAKE CONSENSUS — ${agreementCount}/20 agreement has no statistical foundation`;
    } else {
      overrideReason = overrideReason || `[P5·ENSEMBLE] Truth gates cleared — ensemble vote applied`;
    }
  }

  return {
    finalVerdict,
    fakeConsensus,
    roadInvalidated,
    disabledVoterIds,
    priorityPath,
    overrideReason,
    rawEnsembleVote: ensembleVote,
    conditions,
  };
}

// ─── Full Analysis Runner ─────────────────────────────────────────────────────

export function runFullAnalysis(
  hands: HandResult[],
  archived: ArchivedShoe[],
  agreementCount: number,
  ensembleVote: string = 'NO_VOTE',
  voterStats: { id: string; allTimeCorrect: number; allTimeWrong: number }[] = [],
): AnalysisReport {
  const bp = bpOnly(hands);
  const traps = detectTraps(hands);
  const randomness = testRandomness(hands);
  const fingerprint = fingerprintShoe(hands, archived);
  const integrity = auditScreenIntegrity(hands);
  const { noEdge, reason: noEdgeReason } = applyNoEdgeRule(hands, randomness, agreementCount);

  const entropy = analyzeEntropy(bp);
  const transitions = analyzeTransitions(bp);
  const streakModel = buildStreakModel(bp);
  const baitPatterns = detectBaitPatterns(hands);
  const deviations = runDeviationTests(bp);
  const edgeGate = buildEdgeGate(bp, entropy, transitions, deviations, archived, agreementCount);
  const truthGate = buildTruthGate(
    entropy, randomness, integrity, transitions, deviations,
    edgeGate, archived, agreementCount, ensembleVote, voterStats,
  );

  return { traps, randomness, fingerprint, integrity, noEdge, noEdgeReason, entropy, transitions, streakModel, baitPatterns, deviations, edgeGate, truthGate };
}
