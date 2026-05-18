import type {
  Side,
  AIVote,
  HandResult,
  ArchivedShoe,
  VoterOut,
  VoteType,
  VoteStatus,
  HotColdStatus,
  ReactionSpeed,
  SimScores,
  AIStateKeyEntry,
  AIStateKeyMemory,
  FinalDecision,
  ConsensusLevel,
  GlobalShoeState,
  PatternTypeMemory,
} from "./types";

// ─── Pressure Encoding ────────────────────────────────────────────────────────

type PressureBand = 'LOW' | 'HIGH' | 'STRONG_HIGH' | 'KILL_SHOT';

interface EncodedHand {
  side: Side;
  finalNumber: number;
  band: PressureBand;
  score: number; // -1.00 to +1.00 (B positive, P negative, T zero)
}

function getPressureBand(n: number): PressureBand {
  if (n >= 8) return 'KILL_SHOT';
  if (n >= 6) return 'STRONG_HIGH';
  if (n >= 5) return 'HIGH';
  return 'LOW';
}

function bandScore(band: PressureBand): number {
  return band === 'KILL_SHOT' ? 1.00 : band === 'STRONG_HIGH' ? 0.80 : band === 'HIGH' ? 0.60 : 0.25;
}

function getEncodedScore(side: Side, n: number): number {
  if (side === 'T') return 0;
  const bs = bandScore(getPressureBand(n));
  return side === 'B' ? bs : -bs;
}

function encodeHands(hands: HandResult[]): EncodedHand[] {
  return hands.map(h => ({
    side: h.side,
    finalNumber: h.number,
    band: getPressureBand(h.number),
    score: getEncodedScore(h.side, h.number),
  }));
}

function bpEncoded(encoded: EncodedHand[]): EncodedHand[] {
  return encoded.filter(e => e.side !== 'T');
}

// ─── Pressure helpers ─────────────────────────────────────────────────────────

function weightedPressureScore(enc: EncodedHand[]): number {
  if (enc.length === 0) return 0;
  return enc.reduce((s, e) => s + e.score, 0) / enc.length;
}

function pressureDelta(enc: EncodedHand[]): number {
  const bScore = enc.filter(e => e.side === 'B').reduce((s, e) => s + e.score, 0);
  const pScore = Math.abs(enc.filter(e => e.side === 'P').reduce((s, e) => s + e.score, 0));
  return bScore - pScore;
}

function dominantBand(enc: EncodedHand[]): string {
  if (enc.length === 0) return 'MIXED';
  const ks = enc.filter(e => e.band === 'KILL_SHOT').length;
  const sh = enc.filter(e => e.band === 'STRONG_HIGH').length;
  const hi = enc.filter(e => e.band === 'HIGH').length;
  const lo = enc.filter(e => e.band === 'LOW').length;
  const top = Math.max(ks, sh, hi, lo);
  if (top === 0) return 'MIXED';
  if (top === ks) return 'KILL_SHOT';
  if (top === sh) return 'STRONG_HIGH';
  if (top === hi) return 'HIGH';
  return 'LOW';
}

function sideEntropy(enc: EncodedHand[]): number {
  const bp = enc.filter(e => e.side !== 'T');
  if (bp.length === 0) return 1;
  const b = bp.filter(e => e.side === 'B').length / bp.length;
  const p = 1 - b;
  if (b === 0 || p === 0) return 0;
  return -(b * Math.log2(b) + p * Math.log2(p));
}

function chopRate(enc: EncodedHand[], window: number): number {
  const bp = bpEncoded(enc).slice(-window);
  if (bp.length < 2) return 0.5;
  let alts = 0;
  for (let i = 1; i < bp.length; i++) if (bp[i].side !== bp[i - 1].side) alts++;
  return alts / (bp.length - 1);
}

function currentStreak(enc: EncodedHand[]): { side: Side | null; length: number; avgScore: number } {
  const bp = bpEncoded(enc);
  if (bp.length === 0) return { side: null, length: 0, avgScore: 0 };
  const last = bp[bp.length - 1];
  let len = 1;
  let scoreSum = Math.abs(last.score);
  for (let i = bp.length - 2; i >= 0; i--) {
    if (bp[i].side === last.side) { len++; scoreSum += Math.abs(bp[i].score); }
    else break;
  }
  return { side: last.side, length: len, avgScore: scoreSum / len };
}

function transitionProb(enc: EncodedHand[], from: Side, to: Side): number {
  const bp = bpEncoded(enc);
  let fromCount = 0, toCount = 0;
  for (let i = 0; i < bp.length - 1; i++) {
    if (bp[i].side === from) {
      fromCount++;
      if (bp[i + 1].side === to) toCount++;
    }
  }
  return fromCount > 0 ? toCount / fromCount : 0.5;
}

function signalFromScore(score: number, minConf: number): { vote: AIVote; confidence: number } {
  const abs = Math.abs(score);
  const conf = Math.round(abs * 100);
  if (conf < minConf) return { vote: 'NO_VOTE', confidence: conf };
  return { vote: score > 0 ? 'B' : 'P', confidence: conf };
}

// ─── Agent output type ────────────────────────────────────────────────────────

interface AgentOutput {
  vote: AIVote;
  confidence: number;     // 0-100
  pressureScore: number;  // -100 to +100
  numberPressure: string;
  rejectionReason: string;
}

const NO_BET_OUTPUT = (reason: string, ps = 0): AgentOutput => ({
  vote: 'NO_VOTE', confidence: 0, pressureScore: ps, numberPressure: 'MIXED', rejectionReason: reason,
});

// ─── Self-Awareness Types ─────────────────────────────────────────────────────

interface SelfAwareness {
  uncertaintyScore: number;    // 0.00-1.00
  fakePatternRisk: number;     // 0.00-1.00
  entropyWarning: boolean;
  sideOnlyWarning: boolean;
  contradictionWarning: boolean;
}

interface BlackboardEntry {
  agentId: string;
  assignedView: string;
  vote: AIVote;
  pressureScore: number;
  confidence: number;
  selfDoubtScore: number;
  fakeSignalWarning: boolean;
  evidenceUsed: string[];
}

// ─── Self-Awareness Computation ───────────────────────────────────────────────

function computeSelfAwareness(
  agentOut: AgentOutput,
  encoded: EncodedHand[],
): SelfAwareness {
  const bp = bpEncoded(encoded);

  // Entropy warning: B/P sequence is too random to trade
  const ent = bp.length >= 4 ? sideEntropy(bp) : 0;
  const entropyWarning = ent > 0.9;

  // Contradiction warning: short window and long window point in opposite directions
  const shortPs = bp.length >= 4 ? weightedPressureScore(bp.slice(-4)) : 0;
  const longPs  = bp.length >= 6 ? weightedPressureScore(bp) : 0;
  const contradictionWarning = (
    bp.length >= 6 &&
    Math.abs(shortPs) > 0.08 &&
    Math.abs(longPs)  > 0.08 &&
    Math.sign(shortPs) !== Math.sign(longPs)
  );

  // Side-only warning: agent voted but no meaningful number/pressure info was used
  // Detected when pressure score is near zero AND pressure band is LOW
  const sideOnlyWarning = (
    agentOut.vote !== 'NO_VOTE' &&
    Math.abs(agentOut.pressureScore) < 12 &&
    agentOut.numberPressure === 'LOW'
  );

  // Fake pattern risk: low-number-dominant shoes generate false patterns
  const recent8 = bp.slice(-8);
  const lowRatio = recent8.length > 0
    ? recent8.filter(e => e.band === 'LOW').length / recent8.length
    : 0;
  const fakePatternRisk = Math.min(
    lowRatio * 0.45 +
    (ent > 0.85 ? 0.30 : ent > 0.75 ? 0.15 : 0) +
    (contradictionWarning ? 0.25 : 0),
    1.0
  );

  // Aggregate uncertainty score
  const uncertaintyScore = Math.min(
    (entropyWarning   ? 0.30 : ent > 0.75 ? 0.15 : 0) +
    (contradictionWarning ? 0.25 : 0) +
    (sideOnlyWarning  ? 0.25 : 0) +
    fakePatternRisk * 0.20,
    1.0
  );

  return { uncertaintyScore, fakePatternRisk, entropyWarning, sideOnlyWarning, contradictionWarning };
}

// ─── 50 Agent Configs ─────────────────────────────────────────────────────────

interface AgentConfig {
  id: string;
  name: string;
  shortTag: string;
  startHand: number;
  reactionSpeed: ReactionSpeed;
  skill: string;
  skillTag: string;
  skillDesc: string;
  agentGroup: string;
}

const AGENT_CONFIGS: AgentConfig[] = [
  // Group A: Basic side/number/pressure (01-10)
  { id: 'a01_side_pressure',    name: 'SideSequencePressureAI', shortTag: 'SSP',  startHand: 1,  reactionSpeed: 'FAST',   skill: 'pressure-analysis',      skillTag: 'PRES', skillDesc: 'Full shoe side+number+pressure — votes only when B or P pressure score is unambiguous', agentGroup: 'A-BASIC' },
  { id: 'a02_number_pressure',  name: 'FinalNumberPressureAI',  shortTag: 'FNP',  startHand: 1,  reactionSpeed: 'FAST',   skill: 'number-analysis',        skillTag: 'NUM',  skillDesc: 'Final number sequence with side context — weak numbers suppress vote', agentGroup: 'A-BASIC' },
  { id: 'a03_highlow_sequence', name: 'HighLowSequenceAI',      shortTag: 'HLS',  startHand: 2,  reactionSpeed: 'FAST',   skill: 'band-analysis',          skillTag: 'BAND', skillDesc: 'Binary HIGH/LOW sequence with side owner — votes only when band agrees with side', agentGroup: 'A-BASIC' },
  { id: 'a04_strong_high',      name: 'StrongHighSequenceAI',   shortTag: 'SHS',  startHand: 3,  reactionSpeed: 'FAST',   skill: 'killshot-detection',     skillTag: 'KS',   skillDesc: 'STRONG_HIGH and KILL_SHOT only — ignores all LOW/HIGH results as noise', agentGroup: 'A-BASIC' },
  { id: 'a05_tie_noise',        name: 'TieSequenceNoiseAI',     shortTag: 'TNZS', startHand: 2,  reactionSpeed: 'NORMAL', skill: 'tie-filtering',          skillTag: 'TIES', skillDesc: 'Tie pressure noise monitor — rejects bet when TIE pressure is corrupting the read', agentGroup: 'A-BASIC' },
  { id: 'a06_banker_pressure',  name: 'BankerPressureAI',       shortTag: 'BKPR', startHand: 3,  reactionSpeed: 'FAST',   skill: 'banker-analysis',        skillTag: 'BK',   skillDesc: 'Banker outcomes only — final numbers and pressure must confirm B signal', agentGroup: 'A-BASIC' },
  { id: 'a07_player_pressure',  name: 'PlayerPressureAI',       shortTag: 'PLPR', startHand: 3,  reactionSpeed: 'FAST',   skill: 'player-analysis',        skillTag: 'PL',   skillDesc: 'Player outcomes only — final numbers and pressure must confirm P signal', agentGroup: 'A-BASIC' },
  { id: 'a08_bp_delta',         name: 'BankerVsPlayerDeltaAI',  shortTag: 'BPD',  startHand: 5,  reactionSpeed: 'NORMAL', skill: 'delta-analysis',         skillTag: 'DELT', skillDesc: 'B pressure score vs P pressure score — votes the dominant side only when delta is large', agentGroup: 'A-BASIC' },
  { id: 'a09_high_dominance',   name: 'HighNumberDominanceAI',  shortTag: 'HND',  startHand: 4,  reactionSpeed: 'FAST',   skill: 'dominance-detection',    skillTag: 'DOM',  skillDesc: 'HIGH/STRONG/KILL counts with side ownership — counts killshots by side', agentGroup: 'A-BASIC' },
  { id: 'a10_low_trap',         name: 'LowNumberTrapAI',        shortTag: 'LNT',  startHand: 4,  reactionSpeed: 'NORMAL', skill: 'trap-detection',         skillTag: 'TRAP', skillDesc: 'LOW win detector — warns when streak/chop driven by weak numbers only', agentGroup: 'A-BASIC' },

  // Group B: Window views (11-16)
  { id: 'b11_last3',   name: 'Last3WindowAI',  shortTag: 'W3',   startHand: 3,  reactionSpeed: 'FAST',   skill: 'micro-window',   skillTag: 'W3',   skillDesc: 'Last-3 pressure window — fastest reaction, tiny sample, high noise', agentGroup: 'B-WINDOW' },
  { id: 'b12_last6',   name: 'Last6WindowAI',  shortTag: 'W6',   startHand: 6,  reactionSpeed: 'FAST',   skill: 'short-window',   skillTag: 'W6',   skillDesc: 'Last-6 pressure window — fast, moderate sample, balanced noise', agentGroup: 'B-WINDOW' },
  { id: 'b13_last9',   name: 'Last9WindowAI',  shortTag: 'W9',   startHand: 9,  reactionSpeed: 'NORMAL', skill: 'medium-window',  skillTag: 'W9',   skillDesc: 'Last-9 pressure window — medium, good sample, lower noise', agentGroup: 'B-WINDOW' },
  { id: 'b14_last12',  name: 'Last12WindowAI', shortTag: 'W12',  startHand: 12, reactionSpeed: 'NORMAL', skill: 'standard-window',skillTag: 'W12',  skillDesc: 'Last-12 pressure window — standard, reliable sample', agentGroup: 'B-WINDOW' },
  { id: 'b15_last18',  name: 'Last18WindowAI', shortTag: 'W18',  startHand: 18, reactionSpeed: 'SLOW',   skill: 'wide-window',    skillTag: 'W18',  skillDesc: 'Last-18 pressure window — wide, stable but slower to react', agentGroup: 'B-WINDOW' },
  { id: 'b16_last24',  name: 'Last24WindowAI', shortTag: 'W24',  startHand: 24, reactionSpeed: 'SLOW',   skill: 'deep-window',    skillTag: 'W24',  skillDesc: 'Last-24 pressure window — deepest window, most stable, slowest', agentGroup: 'B-WINDOW' },

  // Group C: Streak quality (17-22)
  { id: 'c17_bk_streak',   name: 'BankerStreakQualityAI', shortTag: 'BSQ', startHand: 3, reactionSpeed: 'FAST',   skill: 'streak-quality', skillTag: 'BSQ', skillDesc: 'Banker streak length + final numbers — only follows streaks with HIGH pressure', agentGroup: 'C-STREAK' },
  { id: 'c18_pl_streak',   name: 'PlayerStreakQualityAI', shortTag: 'PSQ', startHand: 3, reactionSpeed: 'FAST',   skill: 'streak-quality', skillTag: 'PSQ', skillDesc: 'Player streak length + final numbers — only follows streaks with HIGH pressure', agentGroup: 'C-STREAK' },
  { id: 'c19_weak_streak', name: 'WeakStreakDetectorAI',  shortTag: 'WSD', startHand: 3, reactionSpeed: 'NORMAL', skill: 'streak-critic',  skillTag: 'WSC', skillDesc: 'Weak streak detector — forces NO_BET on streaks driven by LOW numbers only', agentGroup: 'C-STREAK' },
  { id: 'c20_high_streak', name: 'HighStreakDetectorAI',  shortTag: 'HSD', startHand: 3, reactionSpeed: 'FAST',   skill: 'streak-follow',  skillTag: 'HSF', skillDesc: 'High/killshot streak detector — votes continuation when KILL_SHOT in streak', agentGroup: 'C-STREAK' },
  { id: 'c21_streak_exhaust', name: 'StreakExhaustionAI', shortTag: 'SEX', startHand: 5, reactionSpeed: 'SLOW',   skill: 'streak-exhaust', skillTag: 'SXH', skillDesc: 'Streak age + weakening numbers — warns of reversal when long streak with declining pressure', agentGroup: 'C-STREAK' },
  { id: 'c22_streak_break', name: 'StreakBreakRiskAI',    shortTag: 'SBR', startHand: 4, reactionSpeed: 'NORMAL', skill: 'break-risk',     skillTag: 'SBR', skillDesc: 'Streak side + weakening numbers + opposite pressure — reversal risk vote', agentGroup: 'C-STREAK' },

  // Group D: Chop detection (23-28)
  { id: 'd23_raw_chop',   name: 'RawChopAI',           shortTag: 'RCH', startHand: 5,  reactionSpeed: 'FAST',   skill: 'chop-analysis',   skillTag: 'CHO', skillDesc: 'Raw B/P alternation with number quality — votes only when chop is high-quality', agentGroup: 'D-CHOP' },
  { id: 'd24_high_chop',  name: 'HighChopAI',           shortTag: 'HCH', startHand: 6,  reactionSpeed: 'FAST',   skill: 'high-chop',       skillTag: 'HCH', skillDesc: 'Alternation with HIGH/STRONG numbers — high-quality chop with pressure confirmation', agentGroup: 'D-CHOP' },
  { id: 'd25_weak_chop',  name: 'WeakChopDetectorAI',   shortTag: 'WCH', startHand: 5,  reactionSpeed: 'NORMAL', skill: 'weak-chop',       skillTag: 'WCH', skillDesc: 'Alternation with LOW numbers — identifies fake chop patterns, forces NO_BET', agentGroup: 'D-CHOP' },
  { id: 'd26_chop_exhaust',name: 'ChopExhaustionAI',    shortTag: 'CEX', startHand: 8,  reactionSpeed: 'SLOW',   skill: 'chop-exhaust',    skillTag: 'CXH', skillDesc: 'Chop length + number weakening — warns when chop is about to break', agentGroup: 'D-CHOP' },
  { id: 'd27_chop_break',  name: 'ChopBreakRiskAI',     shortTag: 'CBR', startHand: 7,  reactionSpeed: 'NORMAL', skill: 'chop-break',      skillTag: 'CBR', skillDesc: 'Chop instability + high opposite pressure + window disagreement', agentGroup: 'D-CHOP' },
  { id: 'd28_chop_shift',  name: 'ChopToStreakShiftAI', shortTag: 'CSS', startHand: 8,  reactionSpeed: 'NORMAL', skill: 'regime-shift',    skillTag: 'CSS', skillDesc: 'Alternation collapse + side pressure + killshot emergence — chop to streak shift detector', agentGroup: 'D-CHOP' },

  // Group E: Transition patterns (29-34)
  { id: 'e29_bh_after_bh', name: 'BHighAfterBHighAI',  shortTag: 'BBH', startHand: 5, reactionSpeed: 'FAST',   skill: 'continuation',   skillTag: 'BBH', skillDesc: 'B_HIGH chain + escalation — continuation pressure with number escalation', agentGroup: 'E-TRANS' },
  { id: 'e30_ph_after_ph', name: 'PHighAfterPHighAI',  shortTag: 'PPH', startHand: 5, reactionSpeed: 'FAST',   skill: 'continuation',   skillTag: 'PPH', skillDesc: 'P_HIGH chain + escalation — player continuation pressure', agentGroup: 'E-TRANS' },
  { id: 'e31_bh_after_ph', name: 'BHighAfterPHighAI',  shortTag: 'BPH', startHand: 5, reactionSpeed: 'FAST',   skill: 'reversal',       skillTag: 'BPH', skillDesc: 'P_HIGH to B_HIGH transition — reversal pressure from player to banker', agentGroup: 'E-TRANS' },
  { id: 'e32_ph_after_bh', name: 'PHighAfterBHighAI',  shortTag: 'PBH', startHand: 5, reactionSpeed: 'FAST',   skill: 'reversal',       skillTag: 'PBH', skillDesc: 'B_HIGH to P_HIGH transition — reversal pressure from banker to player', agentGroup: 'E-TRANS' },
  { id: 'e33_low_after_hi', name: 'LowAfterHighAI',    shortTag: 'LAH', startHand: 4, reactionSpeed: 'NORMAL', skill: 'decay',          skillTag: 'LAH', skillDesc: 'LOW after HIGH — pressure decay signal, suppresses continuation bet', agentGroup: 'E-TRANS' },
  { id: 'e34_hi_after_low', name: 'HighAfterLowAI',    shortTag: 'HAL', startHand: 4, reactionSpeed: 'NORMAL', skill: 'recovery',       skillTag: 'HAL', skillDesc: 'HIGH after LOW — pressure recovery signal, validates continuation bet', agentGroup: 'E-TRANS' },

  // Group F: Stochastic (SNR — sole survivor; f35-f39 replaced by adversarial critics)
  { id: 'f40_snr',           name: 'SignalToNoiseAI',   shortTag: 'SNR',  startHand: 8,  reactionSpeed: 'NORMAL', skill: 'signal-to-noise',   skillTag: 'SNR', skillDesc: 'Pressure score vs randomness score vs contradiction — SNR ratio critic', agentGroup: 'F-ENTROPY' },

  // Group G: Regime classification (41-45)
  { id: 'g41_streak_regime',  name: 'StreakRegimeAI',    shortTag: 'STRG', startHand: 8,  reactionSpeed: 'NORMAL', skill: 'regime-streak',  skillTag: 'SRG', skillDesc: 'Streak structure + number strength + side pressure — streak regime classifier', agentGroup: 'G-REGIME' },
  { id: 'g42_chop_regime',    name: 'ChopRegimeAI',      shortTag: 'CHRG', startHand: 8,  reactionSpeed: 'NORMAL', skill: 'regime-chop',    skillTag: 'CRG', skillDesc: 'Chop structure + number strength + side pressure — chop regime classifier', agentGroup: 'G-REGIME' },
  { id: 'g43_banker_bias',    name: 'BankerBiasRegimeAI',shortTag: 'BBRG', startHand: 10, reactionSpeed: 'SLOW',   skill: 'bias-detection', skillTag: 'BBR', skillDesc: 'B ratio + B high pressure + B killshot rate — banker bias regime', agentGroup: 'G-REGIME' },
  { id: 'g44_player_bias',    name: 'PlayerBiasRegimeAI',shortTag: 'PBRG', startHand: 10, reactionSpeed: 'SLOW',   skill: 'bias-detection', skillTag: 'PBR', skillDesc: 'P ratio + P high pressure + P killshot rate — player bias regime', agentGroup: 'G-REGIME' },
  { id: 'g45_exhaustion',     name: 'ExhaustionRegimeAI',shortTag: 'EXRG', startHand: 10, reactionSpeed: 'SLOW',   skill: 'exhaustion',     skillTag: 'EXH', skillDesc: 'Overextension + weak numbers + reversal pressure — exhaustion regime classifier', agentGroup: 'G-REGIME' },

  // Group N: Adversarial Critics (n01-n10) — attack dominant signal to destroy fake consensus
  { id: 'n01_dragon_buster',     name: 'DragonBusterAI',        shortTag: 'DRB',  startHand: 5,  reactionSpeed: 'FAST',   skill: 'adversarial', skillTag: 'ADV', skillDesc: 'Attacks streaks ≥5 — votes AGAINST dragon continuation; strength boosted when dragons have been historically failing', agentGroup: 'N-ADV' },
  { id: 'n02_weak_dragon',       name: 'WeakDragonAttackerAI',  shortTag: 'WDA',  startHand: 4,  reactionSpeed: 'FAST',   skill: 'adversarial', skillTag: 'ADV', skillDesc: 'Attacks streaks ≥3 built on LOW numbers — fake dragon = vote opposite streak direction', agentGroup: 'N-ADV' },
  { id: 'n03_chop_buster',       name: 'ChopBusterAI',          shortTag: 'CHB',  startHand: 7,  reactionSpeed: 'NORMAL', skill: 'adversarial', skillTag: 'ADV', skillDesc: 'Attacks extreme alternation ≥72% rate — bets continuation because extreme chop is due to break', agentGroup: 'N-ADV' },
  { id: 'n04_pressure_skeptic',  name: 'PressureSkepticAI',     shortTag: 'PSK',  startHand: 5,  reactionSpeed: 'NORMAL', skill: 'adversarial', skillTag: 'ADV', skillDesc: 'Attacks high pressure built on LOW numbers — fake pressure = vote opposite apparent signal', agentGroup: 'N-ADV' },
  { id: 'n05_exhaustion',        name: 'ExhaustionHunterAI',    shortTag: 'EXH',  startHand: 5,  reactionSpeed: 'NORMAL', skill: 'adversarial', skillTag: 'ADV', skillDesc: 'Geometric mean exhaustion detector — votes reversal when streak length > E[streak]*1.5', agentGroup: 'N-ADV' },
  { id: 'n06_window_conflict',   name: 'WindowConflictAI',      shortTag: 'WCF',  startHand: 8,  reactionSpeed: 'SLOW',   skill: 'adversarial', skillTag: 'ADV', skillDesc: 'Attacks recency signal when short/long windows conflict — follows long-term over recent noise', agentGroup: 'N-ADV' },
  { id: 'n07_regime_skeptic',    name: 'RegimeSkepticAI',       shortTag: 'RSK',  startHand: 8,  reactionSpeed: 'SLOW',   skill: 'adversarial', skillTag: 'ADV', skillDesc: 'Attacks any prediction in mixed/volatile regime — votes opposite in unstable shoe environment', agentGroup: 'N-ADV' },
  { id: 'n08_transition_attack', name: 'TransitionAttackerAI',  shortTag: 'TRA',  startHand: 10, reactionSpeed: 'SLOW',   skill: 'adversarial', skillTag: 'ADV', skillDesc: 'Attacks predictions at regime-shift points — first/second half chop rate divergence trigger', agentGroup: 'N-ADV' },
  { id: 'n09_number_trap',       name: 'NumberTrapAttackerAI',  shortTag: 'NTA',  startHand: 5,  reactionSpeed: 'NORMAL', skill: 'adversarial', skillTag: 'ADV', skillDesc: 'Attacks apparent signal when ≥62% of recent numbers are LOW — built on weak number foundation', agentGroup: 'N-ADV' },
  { id: 'n10_entropy_guard',     name: 'EntropyGuardAI',        shortTag: 'ENG',  startHand: 8,  reactionSpeed: 'SLOW',   skill: 'adversarial', skillTag: 'ADV', skillDesc: 'Entropy environment guard — NO_BET above 0.87 entropy, actively OPPOSE signal above 0.93', agentGroup: 'N-ADV' },
];

// ─── Agent run logic ──────────────────────────────────────────────────────────

function runAgent(
  cfg: AgentConfig,
  hands: HandResult[],
  encoded: EncodedHand[],
  gs: GlobalShoeState,
  ptm: PatternTypeMemory,
): AgentOutput {
  const bp = bpEncoded(encoded);
  const id = cfg.id;

  // ── GROUP A: Basic side/number/pressure ──────────────────────────────────────
  if (id === 'a01_side_pressure') {
    if (bp.length < 3) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const ps = weightedPressureScore(bp);
    const conf = Math.round(Math.abs(ps) * 100);
    if (conf < 35) return NO_BET_OUTPUT('PRESSURE_TOO_LOW', Math.round(ps * 100));
    return { vote: ps > 0 ? 'B' : 'P', confidence: conf, pressureScore: Math.round(ps * 100), numberPressure: dominantBand(bp), rejectionReason: '' };
  }

  if (id === 'a02_number_pressure') {
    if (bp.length < 3) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const recent = bp.slice(-8);
    const highCount = recent.filter(e => e.band !== 'LOW').length;
    if (highCount < 3) return NO_BET_OUTPUT('WEAK_NUMBERS');
    const ps = weightedPressureScore(recent);
    const conf = Math.round(Math.abs(ps) * 100);
    return { vote: conf >= 30 ? (ps > 0 ? 'B' : 'P') : 'NO_VOTE', confidence: conf, pressureScore: Math.round(ps * 100), numberPressure: dominantBand(recent), rejectionReason: conf < 30 ? 'PRESSURE_MIXED' : '' };
  }

  if (id === 'a03_highlow_sequence') {
    if (bp.length < 3) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const highOnes = bp.filter(e => e.band !== 'LOW');
    if (highOnes.length < 2) return NO_BET_OUTPUT('ALL_LOW_PRESSURE');
    const ps = weightedPressureScore(highOnes);
    const conf = Math.round(Math.abs(ps) * 100);
    return { vote: conf >= 30 ? (ps > 0 ? 'B' : 'P') : 'NO_VOTE', confidence: conf, pressureScore: Math.round(ps * 100), numberPressure: dominantBand(highOnes), rejectionReason: conf < 30 ? 'BAND_CONFLICT' : '' };
  }

  if (id === 'a04_strong_high') {
    const strong = bp.filter(e => e.band === 'STRONG_HIGH' || e.band === 'KILL_SHOT');
    if (strong.length < 2) return NO_BET_OUTPUT('NO_STRONG_SIGNALS');
    const ps = weightedPressureScore(strong);
    const conf = Math.round(Math.abs(ps) * 100);
    if (conf < 40) return NO_BET_OUTPUT('STRONG_SIGNALS_MIXED', Math.round(ps * 100));
    return { vote: ps > 0 ? 'B' : 'P', confidence: Math.min(conf + 10, 100), pressureScore: Math.round(ps * 100), numberPressure: dominantBand(strong), rejectionReason: '' };
  }

  if (id === 'a05_tie_noise') {
    const ties = encoded.filter(e => e.side === 'T');
    const tieRatio = encoded.length > 0 ? ties.length / encoded.length : 0;
    if (tieRatio > 0.2) return NO_BET_OUTPUT('TIE_NOISE_HIGH');
    const ps = weightedPressureScore(bp);
    const conf = Math.round(Math.abs(ps) * 100);
    if (conf < 30) return NO_BET_OUTPUT('PRESSURE_AFTER_TIE_FILTER');
    return { vote: ps > 0 ? 'B' : 'P', confidence: conf, pressureScore: Math.round(ps * 100), numberPressure: dominantBand(bp), rejectionReason: '' };
  }

  if (id === 'a06_banker_pressure') {
    const bOnly = bp.filter(e => e.side === 'B');
    if (bOnly.length < 2) return NO_BET_OUTPUT('INSUFFICIENT_BANKER_HANDS');
    const bScore = bOnly.reduce((s, e) => s + e.score, 0) / bOnly.length;
    const pOnly = bp.filter(e => e.side === 'P');
    const pScore = pOnly.length > 0 ? Math.abs(pOnly.reduce((s, e) => s + e.score, 0) / pOnly.length) : 0;
    if (bScore > pScore + 0.15) return { vote: 'B', confidence: Math.round(bScore * 100), pressureScore: Math.round(bScore * 100), numberPressure: dominantBand(bOnly), rejectionReason: '' };
    return NO_BET_OUTPUT('BANKER_PRESSURE_INSUFFICIENT', Math.round(bScore * 100));
  }

  if (id === 'a07_player_pressure') {
    const pOnly = bp.filter(e => e.side === 'P');
    if (pOnly.length < 2) return NO_BET_OUTPUT('INSUFFICIENT_PLAYER_HANDS');
    const pScore = Math.abs(pOnly.reduce((s, e) => s + e.score, 0) / pOnly.length);
    const bOnly = bp.filter(e => e.side === 'B');
    const bScore = bOnly.length > 0 ? bOnly.reduce((s, e) => s + e.score, 0) / bOnly.length : 0;
    if (pScore > bScore + 0.15) return { vote: 'P', confidence: Math.round(pScore * 100), pressureScore: -Math.round(pScore * 100), numberPressure: dominantBand(pOnly), rejectionReason: '' };
    return NO_BET_OUTPUT('PLAYER_PRESSURE_INSUFFICIENT', -Math.round(pScore * 100));
  }

  if (id === 'a08_bp_delta') {
    if (bp.length < 5) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const delta = pressureDelta(bp);
    const conf = Math.round(Math.abs(delta) * 100);
    if (conf < 20) return NO_BET_OUTPUT('DELTA_TOO_SMALL', Math.round(delta * 100));
    return { vote: delta > 0 ? 'B' : 'P', confidence: conf, pressureScore: Math.round(delta * 100), numberPressure: dominantBand(bp), rejectionReason: '' };
  }

  if (id === 'a09_high_dominance') {
    const recent = bp.slice(-12);
    const bKill = recent.filter(e => e.side === 'B' && (e.band === 'KILL_SHOT' || e.band === 'STRONG_HIGH')).length;
    const pKill = recent.filter(e => e.side === 'P' && (e.band === 'KILL_SHOT' || e.band === 'STRONG_HIGH')).length;
    if (bKill === 0 && pKill === 0) return NO_BET_OUTPUT('NO_KILLSHOTS');
    if (bKill > pKill + 1) return { vote: 'B', confidence: Math.min(50 + bKill * 8, 90), pressureScore: (bKill - pKill) * 20, numberPressure: 'KILL_SHOT', rejectionReason: '' };
    if (pKill > bKill + 1) return { vote: 'P', confidence: Math.min(50 + pKill * 8, 90), pressureScore: -(pKill - bKill) * 20, numberPressure: 'KILL_SHOT', rejectionReason: '' };
    return NO_BET_OUTPUT('KILLSHOTS_BALANCED', (bKill - pKill) * 20);
  }

  if (id === 'a10_low_trap') {
    const recent = bp.slice(-8);
    const lowWins = recent.filter(e => e.band === 'LOW').length;
    const ratio = recent.length > 0 ? lowWins / recent.length : 0;
    if (ratio > 0.6) return NO_BET_OUTPUT('LOW_NUMBER_TRAP_DETECTED');
    const ps = weightedPressureScore(recent.filter(e => e.band !== 'LOW'));
    const conf = Math.round(Math.abs(ps) * 100);
    if (conf < 35) return NO_BET_OUTPUT('ONLY_LOW_PRESSURE_AFTER_FILTER');
    return { vote: ps > 0 ? 'B' : 'P', confidence: conf, pressureScore: Math.round(ps * 100), numberPressure: dominantBand(recent), rejectionReason: '' };
  }

  // ── GROUP B: Window views ─────────────────────────────────────────────────────
  const windowMap: Record<string, number> = { b11_last3: 3, b12_last6: 6, b13_last9: 9, b14_last12: 12, b15_last18: 18, b16_last24: 24 };
  if (id in windowMap) {
    const w = windowMap[id];
    const window = bp.slice(-w);
    if (window.length < Math.min(w, 2)) return NO_BET_OUTPUT('WINDOW_TOO_SHORT');
    const ps = weightedPressureScore(window);
    const conf = Math.round(Math.abs(ps) * 100);
    // Smaller windows need stronger pressure to compensate noise
    const minConf = w <= 3 ? 55 : w <= 6 ? 45 : w <= 12 ? 38 : 30;
    if (conf < minConf) return NO_BET_OUTPUT('WINDOW_PRESSURE_INSUFFICIENT', Math.round(ps * 100));
    return { vote: ps > 0 ? 'B' : 'P', confidence: conf, pressureScore: Math.round(ps * 100), numberPressure: dominantBand(window), rejectionReason: '' };
  }

  // ── GROUP C: Streak quality ───────────────────────────────────────────────────
  if (id === 'c17_bk_streak') {
    const streak = currentStreak(encoded);
    if (streak.side !== 'B' || streak.length < 2) return NO_BET_OUTPUT('NO_BANKER_STREAK');
    if (streak.avgScore < 0.45) return NO_BET_OUTPUT('BANKER_STREAK_WEAK_NUMBERS');
    const conf = Math.min(40 + streak.length * 8 + Math.round(streak.avgScore * 20), 95);
    return { vote: 'B', confidence: conf, pressureScore: Math.round(streak.avgScore * 100), numberPressure: streak.avgScore >= 0.8 ? 'KILL_SHOT' : streak.avgScore >= 0.6 ? 'STRONG_HIGH' : 'HIGH', rejectionReason: '' };
  }

  if (id === 'c18_pl_streak') {
    const streak = currentStreak(encoded);
    if (streak.side !== 'P' || streak.length < 2) return NO_BET_OUTPUT('NO_PLAYER_STREAK');
    if (streak.avgScore < 0.45) return NO_BET_OUTPUT('PLAYER_STREAK_WEAK_NUMBERS');
    const conf = Math.min(40 + streak.length * 8 + Math.round(streak.avgScore * 20), 95);
    return { vote: 'P', confidence: conf, pressureScore: -Math.round(streak.avgScore * 100), numberPressure: streak.avgScore >= 0.8 ? 'KILL_SHOT' : streak.avgScore >= 0.6 ? 'STRONG_HIGH' : 'HIGH', rejectionReason: '' };
  }

  if (id === 'c19_weak_streak') {
    const streak = currentStreak(encoded);
    if (streak.side === null || streak.length < 2) return NO_BET_OUTPUT('NO_STREAK');
    if (streak.avgScore > 0.4) return NO_BET_OUTPUT('STREAK_IS_HIGH_QUALITY');
    // Weak streak — critic votes NO_BET
    return NO_BET_OUTPUT('WEAK_STREAK_ALL_LOW_NUMBERS');
  }

  if (id === 'c20_high_streak') {
    const streak = currentStreak(encoded);
    if (streak.side === null || streak.length < 2) return NO_BET_OUTPUT('NO_STREAK');
    const ksInStreak = bp.slice(-streak.length).filter(e => e.band === 'KILL_SHOT').length;
    if (ksInStreak === 0) return NO_BET_OUTPUT('NO_KILLSHOTS_IN_STREAK');
    const conf = Math.min(60 + ksInStreak * 10, 95);
    const ps = streak.side === 'B' ? Math.round(streak.avgScore * 100) : -Math.round(streak.avgScore * 100);
    return { vote: streak.side, confidence: conf, pressureScore: ps, numberPressure: 'KILL_SHOT', rejectionReason: '' };
  }

  if (id === 'c21_streak_exhaust') {
    const streak = currentStreak(encoded);
    if (streak.side === null || streak.length < 4) return NO_BET_OUTPUT('STREAK_NOT_LONG_ENOUGH');
    const strSlice = bp.slice(-streak.length);
    const earlyScore = strSlice.slice(0, Math.ceil(streak.length / 2)).reduce((s, e) => s + Math.abs(e.score), 0) / Math.ceil(streak.length / 2);
    const lateScore = strSlice.slice(-Math.ceil(streak.length / 2)).reduce((s, e) => s + Math.abs(e.score), 0) / Math.ceil(streak.length / 2);
    if (earlyScore - lateScore > 0.2) {
      // Pressure declining in streak → exhaustion
      const oppSide: AIVote = streak.side === 'B' ? 'P' : 'B';
      const conf = Math.min(40 + Math.round((earlyScore - lateScore) * 100), 80);
      return { vote: oppSide, confidence: conf, pressureScore: oppSide === 'B' ? conf : -conf, numberPressure: 'LOW', rejectionReason: '' };
    }
    return NO_BET_OUTPUT('STREAK_PRESSURE_STABLE');
  }

  if (id === 'c22_streak_break') {
    const streak = currentStreak(encoded);
    if (streak.side === null || streak.length < 2) return NO_BET_OUTPUT('NO_STREAK');
    const lastTwo = bp.slice(-2);
    const avgLast = lastTwo.reduce((s, e) => s + Math.abs(e.score), 0) / 2;
    if (avgLast > 0.4) return NO_BET_OUTPUT('STREAK_STILL_STRONG');
    // Weakening pressure at end of streak
    const oppSide: AIVote = streak.side === 'B' ? 'P' : 'B';
    const conf = Math.round((0.6 - avgLast) * 100);
    return { vote: oppSide, confidence: conf, pressureScore: oppSide === 'B' ? conf : -conf, numberPressure: 'LOW', rejectionReason: '' };
  }

  // ── GROUP D: Chop detection ───────────────────────────────────────────────────
  if (id === 'd23_raw_chop') {
    if (bp.length < 5) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const cr = chopRate(encoded, 8);
    if (cr < 0.6) return NO_BET_OUTPUT('NOT_IN_CHOP');
    const last = bp[bp.length - 1];
    const oppSide: AIVote = last.side === 'B' ? 'P' : 'B';
    const conf = Math.round(cr * 80);
    const ps = oppSide === 'B' ? conf : -conf;
    return { vote: oppSide, confidence: conf, pressureScore: ps, numberPressure: dominantBand(bp.slice(-8)), rejectionReason: '' };
  }

  if (id === 'd24_high_chop') {
    if (bp.length < 6) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const cr = chopRate(encoded, 8);
    if (cr < 0.6) return NO_BET_OUTPUT('NOT_IN_CHOP');
    const recent = bp.slice(-8).filter(e => e.band !== 'LOW');
    if (recent.length < 3) return NO_BET_OUTPUT('CHOP_LOW_QUALITY_NUMBERS');
    const last = bp[bp.length - 1];
    const oppSide: AIVote = last.side === 'B' ? 'P' : 'B';
    const conf = Math.min(Math.round(cr * 80) + recent.length * 3, 90);
    const ps = oppSide === 'B' ? conf : -conf;
    return { vote: oppSide, confidence: conf, pressureScore: ps, numberPressure: 'HIGH', rejectionReason: '' };
  }

  if (id === 'd25_weak_chop') {
    if (bp.length < 5) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const cr = chopRate(encoded, 8);
    if (cr < 0.6) return NO_BET_OUTPUT('NOT_IN_CHOP');
    const recent = bp.slice(-8);
    const lowRatio = recent.filter(e => e.band === 'LOW').length / recent.length;
    if (lowRatio < 0.5) return NO_BET_OUTPUT('CHOP_HAS_HIGH_NUMBERS_OK');
    // Weak chop — critic forces NO_BET
    return NO_BET_OUTPUT('FAKE_CHOP_WEAK_NUMBERS');
  }

  if (id === 'd26_chop_exhaust') {
    if (bp.length < 8) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const cr = chopRate(encoded, 12);
    if (cr < 0.55) return NO_BET_OUTPUT('NOT_IN_CHOP');
    const old8 = bp.slice(-12, -4);
    const new4 = bp.slice(-4);
    const oldChop = old8.length >= 2 ? (() => { let a = 0; for (let i = 1; i < old8.length; i++) if (old8[i].side !== old8[i-1].side) a++; return a/(old8.length-1); })() : 0;
    const newChop = new4.length >= 2 ? (() => { let a = 0; for (let i = 1; i < new4.length; i++) if (new4[i].side !== new4[i-1].side) a++; return a/(new4.length-1); })() : 0;
    if (oldChop - newChop > 0.2) {
      const last = bp[bp.length - 1];
      const ps = weightedPressureScore(new4);
      return { vote: ps > 0 ? 'B' : 'P', confidence: 55, pressureScore: Math.round(ps * 100), numberPressure: 'LOW', rejectionReason: '' };
    }
    return NO_BET_OUTPUT('CHOP_STILL_ACTIVE');
  }

  if (id === 'd27_chop_break') {
    if (bp.length < 7) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const crFull = chopRate(encoded, 10);
    const crRecent = chopRate(encoded, 4);
    if (crFull < 0.5) return NO_BET_OUTPUT('NOT_IN_CHOP');
    if (crRecent > 0.4) return NO_BET_OUTPUT('CHOP_STILL_ACTIVE');
    // Chop breaking — follow emerging streak
    const streak = currentStreak(encoded);
    if (streak.side === null || streak.length < 2) return NO_BET_OUTPUT('NO_CLEAR_BREAK');
    const conf = Math.round(streak.avgScore * 80);
    const ps = streak.side === 'B' ? conf : -conf;
    return { vote: streak.side, confidence: conf, pressureScore: ps, numberPressure: dominantBand(bp.slice(-4)), rejectionReason: '' };
  }

  if (id === 'd28_chop_shift') {
    if (bp.length < 8) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const crRecent = chopRate(encoded, 6);
    if (crRecent > 0.45) return NO_BET_OUTPUT('STILL_IN_CHOP');
    const ks = bp.slice(-6).filter(e => e.band === 'KILL_SHOT').length;
    if (ks < 2) return NO_BET_OUTPUT('NO_KILLSHOT_EMERGENCE');
    const ps = weightedPressureScore(bp.slice(-6));
    const conf = Math.min(50 + ks * 12, 90);
    return { vote: ps > 0 ? 'B' : 'P', confidence: conf, pressureScore: Math.round(ps * 100), numberPressure: 'KILL_SHOT', rejectionReason: '' };
  }

  // ── GROUP E: Transition patterns ─────────────────────────────────────────────
  if (id === 'e29_bh_after_bh') {
    const prob = transitionProb(encoded, 'B', 'B');
    const bhChain = bp.filter(e => e.side === 'B' && e.band !== 'LOW').length;
    if (bhChain < 2) return NO_BET_OUTPUT('INSUFFICIENT_B_HIGH_CHAIN');
    const ps = weightedPressureScore(bp.filter(e => e.side === 'B' && e.band !== 'LOW').slice(-4));
    const conf = Math.round(prob * 80 + Math.abs(ps) * 20);
    if (conf < 45) return NO_BET_OUTPUT('B_HIGH_CHAIN_WEAK', Math.round(ps * 100));
    return { vote: 'B', confidence: conf, pressureScore: Math.round(ps * 100), numberPressure: 'HIGH', rejectionReason: '' };
  }

  if (id === 'e30_ph_after_ph') {
    const prob = transitionProb(encoded, 'P', 'P');
    const phChain = bp.filter(e => e.side === 'P' && e.band !== 'LOW').length;
    if (phChain < 2) return NO_BET_OUTPUT('INSUFFICIENT_P_HIGH_CHAIN');
    const ps = weightedPressureScore(bp.filter(e => e.side === 'P' && e.band !== 'LOW').slice(-4));
    const conf = Math.round(prob * 80 + Math.abs(ps) * 20);
    if (conf < 45) return NO_BET_OUTPUT('P_HIGH_CHAIN_WEAK', -Math.round(Math.abs(ps) * 100));
    return { vote: 'P', confidence: conf, pressureScore: -Math.round(Math.abs(ps) * 100), numberPressure: 'HIGH', rejectionReason: '' };
  }

  if (id === 'e31_bh_after_ph') {
    const prob = transitionProb(encoded, 'P', 'B');
    if (prob < 0.5) return NO_BET_OUTPUT('P_TO_B_TRANSITION_WEAK');
    const lastP = [...bp].reverse().find(e => e.side === 'P');
    if (!lastP || lastP.band === 'LOW') return NO_BET_OUTPUT('LAST_P_LOW_QUALITY');
    const conf = Math.round(prob * 80);
    return { vote: 'B', confidence: conf, pressureScore: conf, numberPressure: lastP.band, rejectionReason: '' };
  }

  if (id === 'e32_ph_after_bh') {
    const prob = transitionProb(encoded, 'B', 'P');
    if (prob < 0.5) return NO_BET_OUTPUT('B_TO_P_TRANSITION_WEAK');
    const lastB = [...bp].reverse().find(e => e.side === 'B');
    if (!lastB || lastB.band === 'LOW') return NO_BET_OUTPUT('LAST_B_LOW_QUALITY');
    const conf = Math.round(prob * 80);
    return { vote: 'P', confidence: conf, pressureScore: -conf, numberPressure: lastB.band, rejectionReason: '' };
  }

  if (id === 'e33_low_after_hi') {
    if (bp.length < 2) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const prev = bp[bp.length - 2];
    const last = bp[bp.length - 1];
    if (prev.band === 'LOW' || last.band !== 'LOW') return NO_BET_OUTPUT('NOT_LOW_AFTER_HIGH');
    // Pressure decay — suppresses continuation
    return NO_BET_OUTPUT('PRESSURE_DECAY_LOW_AFTER_HIGH');
  }

  if (id === 'e34_hi_after_low') {
    if (bp.length < 2) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const prev = bp[bp.length - 2];
    const last = bp[bp.length - 1];
    if (prev.band !== 'LOW' || last.band === 'LOW') return NO_BET_OUTPUT('NOT_HIGH_AFTER_LOW');
    // Pressure recovery — validates continuation
    const ps = last.score;
    const conf = Math.round(Math.abs(ps) * 100) + 15;
    return { vote: ps > 0 ? 'B' : 'P', confidence: Math.min(conf, 90), pressureScore: Math.round(ps * 100), numberPressure: last.band, rejectionReason: '' };
  }

  // ── GROUP F: Stochastic (f40_snr) ────────────────────────────────────────────
  if (id === 'f40_snr') {
    if (bp.length < 8) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const signal = Math.abs(weightedPressureScore(bp.slice(-12)));
    const ent = sideEntropy(bp.slice(-12));
    const snr = signal / (ent + 0.01);
    if (snr < 0.5) return NO_BET_OUTPUT('SIGNAL_TO_NOISE_TOO_LOW');
    const ps = weightedPressureScore(bp.slice(-12));
    const conf = Math.min(Math.round(snr * 40), 90);
    if (conf < 30) return NO_BET_OUTPUT('SNR_CONFIDENCE_LOW');
    return { vote: ps > 0 ? 'B' : 'P', confidence: conf, pressureScore: Math.round(ps * 100), numberPressure: dominantBand(bp.slice(-12)), rejectionReason: '' };
  }

  // ── GROUP G: Regime classification ────────────────────────────────────────────
  if (id === 'g41_streak_regime') {
    if (bp.length < 8) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const streak = currentStreak(encoded);
    if (gs.regime !== 'trend' || streak.side === null || streak.length < 3) return NO_BET_OUTPUT('NOT_IN_STREAK_REGIME');
    const conf = Math.min(45 + streak.length * 5 + Math.round(streak.avgScore * 20), 90);
    const ps = streak.side === 'B' ? Math.round(streak.avgScore * 100) : -Math.round(streak.avgScore * 100);
    return { vote: streak.side, confidence: conf, pressureScore: ps, numberPressure: streak.avgScore >= 0.6 ? 'HIGH' : 'LOW', rejectionReason: '' };
  }

  if (id === 'g42_chop_regime') {
    if (bp.length < 8) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    if (gs.regime !== 'chop') return NO_BET_OUTPUT('NOT_IN_CHOP_REGIME');
    const cr = chopRate(encoded, 8);
    if (cr < 0.6) return NO_BET_OUTPUT('CHOP_REGIME_WEAK');
    const last = bp[bp.length - 1];
    const oppSide: AIVote = last.side === 'B' ? 'P' : 'B';
    const conf = Math.round(cr * 80);
    const ps = oppSide === 'B' ? conf : -conf;
    return { vote: oppSide, confidence: conf, pressureScore: ps, numberPressure: dominantBand(bp.slice(-8)), rejectionReason: '' };
  }

  if (id === 'g43_banker_bias') {
    if (bp.length < 10) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const bRatio = bp.filter(e => e.side === 'B').length / bp.length;
    const bHigh = bp.filter(e => e.side === 'B' && e.band !== 'LOW').length;
    const bKill = bp.filter(e => e.side === 'B' && e.band === 'KILL_SHOT').length;
    if (bRatio < 0.55) return NO_BET_OUTPUT('NO_BANKER_BIAS');
    const conf = Math.min(Math.round(bRatio * 60 + bHigh * 3 + bKill * 5), 90);
    return { vote: 'B', confidence: conf, pressureScore: conf, numberPressure: bKill > 1 ? 'KILL_SHOT' : 'HIGH', rejectionReason: '' };
  }

  if (id === 'g44_player_bias') {
    if (bp.length < 10) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const pRatio = bp.filter(e => e.side === 'P').length / bp.length;
    const pHigh = bp.filter(e => e.side === 'P' && e.band !== 'LOW').length;
    const pKill = bp.filter(e => e.side === 'P' && e.band === 'KILL_SHOT').length;
    if (pRatio < 0.55) return NO_BET_OUTPUT('NO_PLAYER_BIAS');
    const conf = Math.min(Math.round(pRatio * 60 + pHigh * 3 + pKill * 5), 90);
    return { vote: 'P', confidence: conf, pressureScore: -conf, numberPressure: pKill > 1 ? 'KILL_SHOT' : 'HIGH', rejectionReason: '' };
  }

  if (id === 'g45_exhaustion') {
    if (bp.length < 10) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const streak = currentStreak(encoded);
    if (streak.side === null || streak.length < 5) return NO_BET_OUTPUT('STREAK_TOO_SHORT_FOR_EXHAUSTION');
    const strSlice = bp.slice(-streak.length);
    const firstHalf = strSlice.slice(0, Math.ceil(streak.length / 2));
    const lastHalf = strSlice.slice(-Math.ceil(streak.length / 2));
    const firstScore = firstHalf.reduce((s, e) => s + Math.abs(e.score), 0) / firstHalf.length;
    const lastScore = lastHalf.reduce((s, e) => s + Math.abs(e.score), 0) / lastHalf.length;
    if (firstScore - lastScore < 0.15) return NO_BET_OUTPUT('STREAK_NOT_EXHAUSTED');
    const oppSide: AIVote = streak.side === 'B' ? 'P' : 'B';
    const conf = Math.min(40 + Math.round((firstScore - lastScore) * 100), 85);
    return { vote: oppSide, confidence: conf, pressureScore: oppSide === 'B' ? conf : -conf, numberPressure: 'LOW', rejectionReason: '' };
  }

  // ── GROUP N: Adversarial Critics ─────────────────────────────────────────────
  if (id.startsWith('n')) {
    return runAdversarialCritic(id, hands, encoded, gs, ptm);
  }

  return NO_BET_OUTPUT('UNKNOWN_AGENT');
}

// ─── Pattern Type Classification ─────────────────────────────────────────────

function classifyCurrentPatternType(encoded: EncodedHand[]): 'dragon' | 'chop' | 'highPressure' | 'mixed' {
  const bp = bpEncoded(encoded);
  if (bp.length < 3) return 'mixed';
  const streak = currentStreak(encoded);
  if (streak.side !== null && streak.length >= 4) return 'dragon';
  if (bp.length >= 5) {
    const cr = chopRate(encoded, 8);
    if (cr >= 0.65) return 'chop';
  }
  const ps = Math.abs(weightedPressureScore(bp.slice(-6)));
  if (ps >= 0.55) return 'highPressure';
  return 'mixed';
}

// ─── Adversarial Critics ─────────────────────────────────────────────────────

function runAdversarialCritic(
  id: string,
  hands: HandResult[],
  encoded: EncodedHand[],
  gs: GlobalShoeState,
  ptm: PatternTypeMemory,
): AgentOutput {
  const bp = bpEncoded(encoded);
  if (bp.length < 2) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
  void hands;

  const apparentPs   = weightedPressureScore(bp.slice(-6));
  const apparentSide: AIVote = apparentPs > 0 ? 'B' : apparentPs < 0 ? 'P' : 'NO_VOTE';
  const oppSide      = (s: AIVote): AIVote => s === 'B' ? 'P' : s === 'P' ? 'B' : 'NO_VOTE';

  // Pattern failure history → boost adversarial aggression when that type has been losing
  const dragonFailRate = ptm.dragon.trials >= 5       ? 1 - ptm.dragon.hits / ptm.dragon.trials             : 0.5;
  const chopFailRate   = ptm.chop.trials >= 5         ? 1 - ptm.chop.hits / ptm.chop.trials                 : 0.5;
  const presFailRate   = ptm.highPressure.trials >= 5 ? 1 - ptm.highPressure.hits / ptm.highPressure.trials : 0.5;

  if (id === 'n01_dragon_buster') {
    const streak = currentStreak(encoded);
    if (streak.side === null || streak.length < 5) return NO_BET_OUTPUT('NO_DRAGON_TO_BUST');
    const boost = dragonFailRate > 0.65 ? 15 : 0;
    const conf  = Math.min(40 + streak.length * 5 + boost, 90);
    const side: AIVote = streak.side === 'B' ? 'P' : 'B';
    return { vote: side, confidence: conf, pressureScore: side === 'B' ? conf : -conf, numberPressure: 'LOW', rejectionReason: 'ADV_DRAGON_BUST' };
  }

  if (id === 'n02_weak_dragon') {
    const streak = currentStreak(encoded);
    if (streak.side === null || streak.length < 3) return NO_BET_OUTPUT('STREAK_TOO_SHORT');
    if (streak.avgScore >= 0.40) return NO_BET_OUTPUT('STREAK_QUALITY_OK');
    const boost = dragonFailRate > 0.65 ? 12 : 0;
    const conf  = Math.min(45 + Math.round((0.40 - streak.avgScore) * 120) + boost, 82);
    const side: AIVote = streak.side === 'B' ? 'P' : 'B';
    return { vote: side, confidence: conf, pressureScore: side === 'B' ? conf : -conf, numberPressure: 'LOW', rejectionReason: 'ADV_FAKE_DRAGON' };
  }

  if (id === 'n03_chop_buster') {
    if (bp.length < 7) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const cr = chopRate(encoded, 8);
    if (cr < 0.72) return NO_BET_OUTPUT('CHOP_NOT_EXTREME');
    // Extreme chop running too long → bet CONTINUATION (break incoming)
    const last     = bp[bp.length - 1];
    const contSide = last.side as AIVote;
    const boost    = chopFailRate > 0.65 ? 12 : 0;
    const conf     = Math.min(Math.round(cr * 65) + boost, 82);
    return { vote: contSide, confidence: conf, pressureScore: contSide === 'B' ? conf : -conf, numberPressure: dominantBand(bp.slice(-8)), rejectionReason: 'ADV_CHOP_BUST' };
  }

  if (id === 'n04_pressure_skeptic') {
    if (bp.length < 5) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const ps     = weightedPressureScore(bp.slice(-8));
    if (Math.abs(ps) < 0.55) return NO_BET_OUTPUT('PRESSURE_NOT_HIGH_ENOUGH');
    const recent   = bp.slice(-8);
    const lowRatio = recent.filter(e => e.band === 'LOW').length / recent.length;
    if (lowRatio < 0.55) return NO_BET_OUTPUT('NUMBERS_ARE_QUALITY');
    // High pressure built on LOW numbers → fake → attack it
    const boost = presFailRate > 0.65 ? 12 : 0;
    const conf  = Math.min(40 + Math.round(lowRatio * 50) + boost, 82);
    const side  = oppSide(ps > 0 ? 'B' : 'P');
    return { vote: side, confidence: conf, pressureScore: side === 'B' ? conf : -conf, numberPressure: 'LOW', rejectionReason: 'ADV_FAKE_PRESSURE' };
  }

  if (id === 'n05_exhaustion') {
    const streak = currentStreak(encoded);
    if (streak.side === null || streak.length < 3) return NO_BET_OUTPUT('NO_STREAK');
    // Geometric mean: E[run length] = 1 / (1 - p_continuation)
    const sideCount  = bp.filter(e => e.side === streak.side).length;
    const pCont      = (sideCount + 0.5) / (bp.length + 1);
    const expectedLen = pCont > 0.01 ? 1 / (1 - pCont) : 10;
    if (streak.length < expectedLen * 1.5) return NO_BET_OUTPUT('STREAK_WITHIN_EXPECTED');
    const side: AIVote = streak.side === 'B' ? 'P' : 'B';
    const conf = Math.min(40 + Math.round((streak.length / expectedLen - 1.5) * 25), 82);
    return { vote: side, confidence: conf, pressureScore: side === 'B' ? conf : -conf, numberPressure: 'LOW', rejectionReason: 'ADV_EXHAUSTION' };
  }

  if (id === 'n06_window_conflict') {
    if (bp.length < 8) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const shortPs = weightedPressureScore(bp.slice(-4));
    const longPs  = weightedPressureScore(bp.slice(-14));
    if (Math.abs(shortPs) < 0.10 || Math.abs(longPs) < 0.10) return NO_BET_OUTPUT('SIGNALS_TOO_WEAK');
    if (Math.sign(shortPs) === Math.sign(longPs)) return NO_BET_OUTPUT('WINDOWS_AGREE');
    // Short vs long conflict → attack recency signal, follow long-term
    const longSide: AIVote = longPs > 0 ? 'B' : 'P';
    const conf = Math.min(40 + Math.round(Math.abs(longPs) * 55), 78);
    return { vote: longSide, confidence: conf, pressureScore: longSide === 'B' ? conf : -conf, numberPressure: dominantBand(bp.slice(-8)), rejectionReason: 'ADV_RECENCY_ATTACK' };
  }

  if (id === 'n07_regime_skeptic') {
    if (bp.length < 8) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    if (gs.regime !== 'mix' && gs.volatility !== 'H') return NO_BET_OUTPUT('REGIME_IS_STABLE');
    if (apparentSide === 'NO_VOTE') return NO_BET_OUTPUT('NO_APPARENT_SIGNAL');
    const conf = gs.volatility === 'H' && gs.regime === 'mix' ? 60 : 48;
    const side = oppSide(apparentSide);
    return { vote: side, confidence: conf, pressureScore: side === 'B' ? conf : -conf, numberPressure: 'MIXED', rejectionReason: 'ADV_REGIME_SKEPTIC' };
  }

  if (id === 'n08_transition_attack') {
    if (bp.length < 10) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const mid    = Math.floor(bp.length / 2);
    const first  = bp.slice(0, mid);
    const second = bp.slice(mid);
    let fAlts = 0, sAlts = 0;
    for (let i = 1; i < first.length;  i++) if (first[i].side  !== first[i-1].side)  fAlts++;
    for (let i = 1; i < second.length; i++) if (second[i].side !== second[i-1].side) sAlts++;
    const rFirst  = first.length  > 1 ? fAlts / (first.length  - 1) : 0.5;
    const rSecond = second.length > 1 ? sAlts / (second.length - 1) : 0.5;
    if (Math.abs(rFirst - rSecond) < 0.28) return NO_BET_OUTPUT('NO_REGIME_SHIFT');
    if (apparentSide === 'NO_VOTE') return NO_BET_OUTPUT('NO_APPARENT_SIGNAL');
    const conf = Math.min(40 + Math.round(Math.abs(rFirst - rSecond) * 80), 78);
    const side = oppSide(apparentSide);
    return { vote: side, confidence: conf, pressureScore: side === 'B' ? conf : -conf, numberPressure: 'MIXED', rejectionReason: 'ADV_TRANSITION' };
  }

  if (id === 'n09_number_trap') {
    if (bp.length < 5) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const recent   = bp.slice(-7);
    const lowRatio = recent.filter(e => e.band === 'LOW').length / recent.length;
    if (lowRatio < 0.62) return NO_BET_OUTPUT('NUMBERS_QUALITY_OK');
    if (apparentSide === 'NO_VOTE') return NO_BET_OUTPUT('NO_APPARENT_SIGNAL');
    const conf = Math.min(35 + Math.round(lowRatio * 55), 78);
    const side = oppSide(apparentSide);
    return { vote: side, confidence: conf, pressureScore: side === 'B' ? conf : -conf, numberPressure: 'LOW', rejectionReason: 'ADV_NUMBER_TRAP' };
  }

  if (id === 'n10_entropy_guard') {
    if (bp.length < 8) return NO_BET_OUTPUT('INSUFFICIENT_DATA');
    const ent = sideEntropy(bp.slice(-12));
    if (ent <= 0.87) return NO_BET_OUTPUT('ENTROPY_ACCEPTABLE');
    if (ent > 0.93 && apparentSide !== 'NO_VOTE') {
      // Extreme chaos: actively vote against whatever signal exists
      const conf = Math.min(Math.round((ent - 0.87) * 500), 72);
      const side = oppSide(apparentSide);
      return { vote: side, confidence: conf, pressureScore: side === 'B' ? conf : -conf, numberPressure: 'LOW', rejectionReason: 'ADV_CHAOS_ATTACK' };
    }
    return NO_BET_OUTPUT('ADV_ENTROPY_BLOCK');
  }

  return NO_BET_OUTPUT('UNKNOWN_ADVERSARIAL_AGENT');
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_WEIGHT = 1.0;
const VOTE_TYPE_MULTIPLIERS: Record<VoteType, number> = {
  HOT_ACTIVE: 2.0, HOT: 1.5, WARM: 1.2, NORMAL: 1.0, WEAK: 0.5, NO_VOTE: 0.0,
};
const REACTION_SPEED_FACTORS: Record<ReactionSpeed, number> = { FAST: 1.05, NORMAL: 1.0, SLOW: 0.95 };
const MIN_SAMPLES = 8;
const MIN_SAMPLES_EARLY = 3;
const HOT_ACTIVE_ACC = 0.78;
const HOT_ACC = 0.7;
const COLD_ACC = 0.35;
const EARLY_SHOE_THRESHOLD = 20;

// ─── Core analysis helpers (preserved) ────────────────────────────────────────

function bpOnly(hands: HandResult[]): Side[] {
  return hands.filter((h) => h.side !== "T").map((h) => h.side);
}

function lastSide(hands: HandResult[]): string {
  return hands.length === 0 ? "X" : hands[hands.length - 1].side;
}

function runLen(bp: Side[]): number {
  if (bp.length === 0) return 0;
  const last = bp[bp.length - 1];
  let len = 1;
  for (let i = bp.length - 2; i >= 0; i--) {
    if (bp[i] === last) len++;
    else break;
  }
  return Math.min(len, 8);
}

function altScore(bp: Side[], n: number): string {
  const w = bp.slice(-n);
  if (w.length < 2) return "nd";
  let alts = 0;
  for (let i = 1; i < w.length; i++) if (w[i] !== w[i - 1]) alts++;
  const rate = alts / (w.length - 1);
  return rate >= 0.66 ? "hi" : rate <= 0.33 ? "lo" : "md";
}

function regimeBucketFn(bp: Side[]): "trend" | "chop" | "mix" | "nd" {
  if (bp.length < 6) return "nd";
  const w = bp.slice(-10);
  let alts = 0;
  for (let i = 1; i < w.length; i++) if (w[i] !== w[i - 1]) alts++;
  const rate = alts / (w.length - 1);
  return rate >= 0.65 ? "chop" : rate <= 0.35 ? "trend" : "mix";
}

function flipRate(bp: Side[], n: number): string {
  const w = bp.slice(-n);
  if (w.length < 2) return "lo";
  let flips = 0;
  for (let i = 1; i < w.length; i++) if (w[i] !== w[i - 1]) flips++;
  return flips / (w.length - 1) >= 0.5 ? "hi" : "lo";
}

function numCluster(n: number): string {
  if (n === 0) return "nt";
  if (n >= 7) return "hi";
  if (n >= 4) return "md";
  return "lo";
}

function sideFreqBucket(bp: Side[], n: number): string {
  const w = bp.slice(-n);
  if (w.length === 0) return "ev";
  const b = w.filter((s) => s === "B").length;
  const p = w.filter((s) => s === "P").length;
  if (b > p * 1.3) return "B";
  if (p > b * 1.3) return "P";
  return "ev";
}

function runVarianceFn(bp: Side[]): string {
  const w = bp.slice(-12);
  const runs: number[] = [];
  let cur = 1;
  for (let i = 1; i < w.length; i++) {
    if (w[i] === w[i - 1]) cur++;
    else { runs.push(cur); cur = 1; }
  }
  runs.push(cur);
  if (runs.length < 2) return "lo";
  const variance = Math.max(...runs) - Math.min(...runs);
  return variance >= 3 ? "hi" : variance >= 1 ? "md" : "lo";
}

function avgRunLen(bp: Side[]): string {
  const w = bp.slice(-12);
  const runs: number[] = [];
  let cur = 1;
  for (let i = 1; i < w.length; i++) {
    if (w[i] === w[i - 1]) cur++;
    else { runs.push(cur); cur = 1; }
  }
  runs.push(cur);
  const avg = runs.reduce((a, b) => a + b, 0) / runs.length;
  return avg < 1.5 ? "ch" : avg > 2.5 ? "tr" : "mx";
}


// ─── Global Shoe State (50 AI Consensus) ─────────────────────────────────────

export function computeGlobalShoeState(hands: HandResult[]): GlobalShoeState {
  const bp = bpOnly(hands);
  const n = hands.length;

  if (n === 0) return {
    regime: "nd", texture: "nd", volatility: "L",
    streak: { side: null, length: 0 }, trend: "nd", phase: "early",
    dominantSide: "equal", regimeVotes: {}, textureVotes: {}, aiContrib: {}, handCount: 0,
  };

  const regimeVotes: Record<string, number> = { trend: 0, chop: 0, mix: 0, nd: 0 };
  const textureVotes: Record<string, number> = { smooth: 0, mix: 0, chop: 0 };
  const aiContrib: Record<string, string> = {};

  const rl = runLen(bp);
  const alt6 = altScore(bp, 6);
  const alt8 = altScore(bp, 8);
  const altN = altScore(bp, bp.length > 0 ? Math.min(10, bp.length) : 1);
  const mainRegime = regimeBucketFn(bp);

  const regTrend: GlobalShoeState["regime"] = rl >= 4 ? "trend" : rl >= 3 ? "trend" : rl === 1 ? "chop" : "mix";
  regimeVotes[regTrend]++;
  aiContrib["TREND"] = regTrend;

  const regChop: GlobalShoeState["regime"] = alt6 === "hi" ? "chop" : alt6 === "lo" ? "trend" : "mix";
  regimeVotes[regChop]++;
  aiContrib["CHOP"] = regChop;

  const regMain = mainRegime === "nd" ? "mix" : mainRegime;
  regimeVotes[regMain]++;
  aiContrib["RGME"] = regMain;

  const w8 = bp.slice(-8);
  let changes8 = 0;
  for (let i = 1; i < w8.length; i++) if (w8[i] !== w8[i - 1]) changes8++;
  const regRhythm: GlobalShoeState["regime"] = w8.length > 1
    ? (changes8 / (w8.length - 1) >= 0.65 ? "chop" : changes8 / (w8.length - 1) <= 0.35 ? "trend" : "mix")
    : "nd";
  regimeVotes[regRhythm]++;
  aiContrib["RHYT"] = regRhythm;

  let transTotal = 0;
  for (let i = 1; i < bp.length; i++) if (bp[i] !== bp[i - 1]) transTotal++;
  const markovRate = bp.length > 1 ? transTotal / (bp.length - 1) : 0.5;
  const regMarkov: GlobalShoeState["regime"] = markovRate >= 0.62 ? "chop" : markovRate <= 0.38 ? "trend" : "mix";
  regimeVotes[regMarkov]++;
  aiContrib["MRKV"] = regMarkov;

  const runs: number[] = [];
  let cur = 1;
  for (let i = 1; i < bp.length; i++) {
    if (bp[i] === bp[i - 1]) cur++;
    else { runs.push(cur); cur = 1; }
  }
  runs.push(cur);
  const avgRun = runs.reduce((a, b) => a + b, 0) / (runs.length || 1);
  const regPres: GlobalShoeState["regime"] = rl > avgRun * 1.3 ? "trend" : rl < avgRun * 0.7 ? "chop" : "mix";
  regimeVotes[regPres]++;
  aiContrib["PRES"] = regPres;

  const texTxtr: string = alt8 === "hi" ? "chop" : alt8 === "lo" ? "smooth" : "mix";
  textureVotes[texTxtr] = (textureVotes[texTxtr] || 0) + 1;
  aiContrib["TXTR"] = texTxtr;

  const texStbl: string = avgRunLen(bp) === "ch" ? "chop" : avgRunLen(bp) === "tr" ? "smooth" : "mix";
  textureVotes[texStbl] = (textureVotes[texStbl] || 0) + 1;
  aiContrib["STBL"] = texStbl;

  const texNseq: string = altN === "hi" ? "chop" : altN === "lo" ? "smooth" : "mix";
  textureVotes[texNseq] = (textureVotes[texNseq] || 0) + 1;
  aiContrib["NSEQ"] = texNseq;


  const sortedRegime = Object.entries(regimeVotes).filter(([k]) => k !== "nd").sort((a, b) => b[1] - a[1]);
  const regime: GlobalShoeState["regime"] = bp.length < 6 ? "nd" : ((sortedRegime[0]?.[0] ?? "mix") as GlobalShoeState["regime"]);

  const sortedTexture = Object.entries(textureVotes).sort((a, b) => b[1] - a[1]);
  const texture: GlobalShoeState["texture"] = bp.length < 4 ? "nd" : ((sortedTexture[0]?.[0] ?? "mix") as GlobalShoeState["texture"]);

  const volatility: GlobalShoeState["volatility"] = runVarianceFn(bp) === "hi" ? "H" : runVarianceFn(bp) === "md" ? "M" : "L";
  const lastBP = bp.length > 0 ? bp[bp.length - 1] : null;
  const trend: GlobalShoeState["trend"] = bp.length < 4 ? "nd" : alt6 === "lo" ? "up" : alt6 === "hi" ? "dn" : "fl";
  const phase: GlobalShoeState["phase"] = n < 20 ? "early" : n < 50 ? "mid" : "late";
  const bCount = bp.filter((s) => s === "B").length;
  const pCount = bp.filter((s) => s === "P").length;
  const dominantSide: GlobalShoeState["dominantSide"] = bCount > pCount * 1.15 ? "B" : pCount > bCount * 1.15 ? "P" : "equal";

  return { regime, texture, volatility, streak: { side: lastBP, length: rl }, trend, phase, dominantSide, regimeVotes, textureVotes, aiContrib, handCount: n };
}

// ─── Memory ────────────────────────────────────────────────────────────────────

export function lookupStateKeyMemory(
  mem: AIStateKeyMemory,
  aiId: string,
  stateKey: string,
): AIStateKeyEntry | undefined {
  return mem[aiId]?.[stateKey];
}

export function recordStateKeyOutcome(
  mem: AIStateKeyMemory,
  aiId: string,
  stateKey: string,
  predicted: AIVote,
  actual: Side,
  handIndex: number,
): AIStateKeyMemory {
  if (!stateKey || stateKey === "ND" || predicted === "NO_VOTE") return mem;
  const aiMem = mem[aiId] ?? {};
  const entry = aiMem[stateKey] ?? { samples: 0, successes: 0, lastSeenHand: 0, accuracy: 0 };
  const isWin = predicted === actual;
  const newSamples = entry.samples + 1;
  const newSuccesses = entry.successes + (isWin ? 1 : 0);
  const newEntry: AIStateKeyEntry = { samples: newSamples, successes: newSuccesses, lastSeenHand: handIndex, accuracy: newSamples > 0 ? newSuccesses / newSamples : 0 };
  return { ...mem, [aiId]: { ...aiMem, [stateKey]: newEntry } };
}

// ─── Hot/Cold classification ──────────────────────────────────────────────────

function computeVoteStatus(
  entry: AIStateKeyEntry | undefined,
  isEarlyShoe: boolean,
): { voteStatus: VoteStatus; hotCold: HotColdStatus; voteType: VoteType; skAccuracy: number; skSamples: number; } {
  const minSamples = isEarlyShoe ? MIN_SAMPLES_EARLY : MIN_SAMPLES;
  if (!entry || entry.samples < minSamples) {
    return { voteStatus: "NEUTRAL", hotCold: "neutral", voteType: "NORMAL", skAccuracy: 0, skSamples: entry?.samples ?? 0 };
  }
  const acc = entry.accuracy;
  const skAccuracy = Math.round(acc * 100);
  const skSamples = entry.samples;
  if (acc >= HOT_ACTIVE_ACC) return { voteStatus: "HOT", hotCold: "hot", voteType: "HOT_ACTIVE", skAccuracy, skSamples };
  if (acc >= HOT_ACC) return { voteStatus: "HOT", hotCold: "hot", voteType: "HOT", skAccuracy, skSamples };
  if (acc <= COLD_ACC) return { voteStatus: "COLD", hotCold: "cold", voteType: "WEAK", skAccuracy, skSamples };
  if (acc >= 0.6) return { voteStatus: "NEUTRAL", hotCold: "neutral", voteType: "WARM", skAccuracy, skSamples };
  return { voteStatus: "NEUTRAL", hotCold: "neutral", voteType: "NORMAL", skAccuracy, skSamples };
}

// ─── State Key Generator for 50 agents ───────────────────────────────────────

function generateStateKey50(agentId: string, hands: HandResult[], gs: GlobalShoeState): string {
  const bp = bpOnly(hands);
  if (bp.length < 2) return "ND";
  const last = lastSide(hands);
  const rl = runLen(bp);
  const enc = encodeHands(hands);
  const bpEnc = bpEncoded(enc);
  const band = bpEnc.length > 0 ? getPressureBand(bpEnc[bpEnc.length - 1].finalNumber) : 'LOW';
  const group = agentId.split('_')[0];

  switch (group) {
    case 'a': {
      const ps = Math.round(weightedPressureScore(bpEnc.slice(-6)) * 4) / 4;
      return `${agentId.substring(0, 8)}|${last}|${band}|ps${ps}|${gs.regime}`;
    }
    case 'b': {
      const ps = Math.round(weightedPressureScore(bpEnc.slice(-8)) * 4) / 4;
      return `${agentId.substring(0, 8)}|${last}|${band}|ps${ps}|r${rl}`;
    }
    case 'c': {
      const streak = currentStreak(enc);
      return `${agentId.substring(0, 8)}|${streak.side ?? 'X'}|r${streak.length}|${band}|${gs.regime}`;
    }
    case 'd': {
      const cr = Math.round(chopRate(enc, 8) * 4) / 4;
      return `${agentId.substring(0, 8)}|${last}|cr${cr}|${band}|${gs.texture}`;
    }
    case 'e': {
      const prev = bpEnc.length >= 2 ? bpEnc[bpEnc.length - 2] : null;
      const prevKey = prev ? `${prev.side}${prev.band[0]}` : 'XX';
      return `${agentId.substring(0, 8)}|${last}|${band}|${prevKey}|${gs.regime}`;
    }
    case 'f': {
      const ent = Math.round(sideEntropy(bpEnc.slice(-12)) * 4) / 4;
      return `${agentId.substring(0, 8)}|${last}|ent${ent}|${band}|${gs.volatility}`;
    }
    case 'g': {
      return `${agentId.substring(0, 8)}|${last}|${gs.regime}|${gs.texture}|${band}`;
    }
    case 'h': {
      const ps = Math.round(weightedPressureScore(bpEnc.slice(-8)) * 4) / 4;
      return `${agentId.substring(0, 8)}|${last}|${band}|ps${ps}|${gs.phase}`;
    }
    default:
      return `${agentId.substring(0, 8)}|${last}|${band}|${gs.regime}`;
  }
}

// ─── Consensus calculation ─────────────────────────────────────────────────────

function getConsensus(winVotePct: number): ConsensusLevel {
  if (winVotePct >= 80) return "VERY_STRONG";
  if (winVotePct >= 70) return "STRONG";
  if (winVotePct >= 62) return "MEDIUM";
  if (winVotePct >= 55) return "WEAK";
  return "NO_BET";
}

// ─── SimScores placeholder ─────────────────────────────────────────────────────

const emptySimScores: SimScores = { continuationRate: 0, reversalRate: 0, chopRate: 0, sampleSize: 0, simConfidence: 0 };

// ─── runVoters — 50-agent blackboard system ───────────────────────────────────
//
//  Step 1  Private analysis: each agent runs independently (runAgent + self-awareness)
//  Step 2  Broadcast: build shared blackboard with per-agent report
//  Step 3  Peer review: each agent reads all 49 reports, may change vote once
//  Step 4  Vote lock: no further mutations
//  Step 5  Consensus: equal-weight count only — B if ≥60%, P if ≥60%, else NO_BET

export function runVoters(
  hands: HandResult[],
  _archives: ArchivedShoe[],
  prevVoters: VoterOut[],
  mem: AIStateKeyMemory,
  ptm: PatternTypeMemory,
): { voters: VoterOut[]; globalShoeState: GlobalShoeState; decision: FinalDecision } {
  const handIndex = hands.length;
  const isEarlyShoe = handIndex <= EARLY_SHOE_THRESHOLD;

  const globalShoeState = computeGlobalShoeState(hands);
  const encoded = encodeHands(hands);
  const prevMap = new Map(prevVoters.map((v) => [v.id, v]));

  // ── STEP 1: Private analysis + self-awareness ──────────────────────────────
  const firstPass: VoterOut[] = AGENT_CONFIGS.map((cfg) => {
    const prev = prevMap.get(cfg.id);

    const baseFields = {
      id: cfg.id,
      name: cfg.name,
      shortTag: cfg.shortTag,
      reactionSpeed: cfg.reactionSpeed,
      startHand: cfg.startHand,
      skill: cfg.skill,
      skillTag: cfg.skillTag,
      skillDesc: cfg.skillDesc,
      correct: prev?.correct ?? 0,
      wrong: prev?.wrong ?? 0,
      push: prev?.push ?? 0,
      skipped: prev?.skipped ?? 0,
      allTimeCorrect: prev?.allTimeCorrect ?? 0,
      allTimeWrong: prev?.allTimeWrong ?? 0,
      allTimePush: prev?.allTimePush ?? 0,
      allTimeSkipped: prev?.allTimeSkipped ?? 0,
      pendingStateKey: prev?.pendingStateKey ?? "",
      regimeVote: globalShoeState.aiContrib[cfg.shortTag] ?? globalShoeState.regime,
      textureVote: globalShoeState.aiContrib[cfg.shortTag] ?? globalShoeState.texture,
      agentGroup: cfg.agentGroup,
    };

    // Waiting for startHand
    if (handIndex < cfg.startHand) {
      return {
        ...baseFields,
        vote: "NO_VOTE", voteType: "NO_VOTE", stateKey: "ND",
        voteStatus: "NEUTRAL", confidence: 0, simScores: emptySimScores,
        skAccuracy: 0, skSamples: 0, hotCold: "neutral",
        pressureScore: 0, numberPressure: 'MIXED', agentStrength: 'LOW',
        rejectionReason: 'WAITING',
        uncertaintyScore: 0, fakePatternRisk: 0,
        entropyWarning: false, sideOnlyWarning: false, contradictionWarning: false,
        peerReviewChanged: false, peerReviewReason: '', selfAwarenessOverride: '',
      } as VoterOut;
    }

    const stateKey = generateStateKey50(cfg.id, hands, globalShoeState);
    const memEntry = lookupStateKeyMemory(mem, cfg.id, stateKey);
    const { voteStatus, hotCold, voteType: memVT, skAccuracy, skSamples } = computeVoteStatus(memEntry, isEarlyShoe);

    // Run the pressure agent (private analysis)
    const agentOut = runAgent(cfg, hands, encoded, globalShoeState, ptm);

    // Compute self-awareness
    const sa = computeSelfAwareness(agentOut, encoded);

    let vote = agentOut.vote;
    let finalConf = agentOut.confidence;
    let voteType: VoteType = vote === "NO_VOTE" ? "NO_VOTE" : memVT;
    if (vote !== "NO_VOTE" && voteType === "NORMAL" && finalConf < 45) voteType = "WEAK";
    // Self-awareness metrics are informational — they cannot force a vote change.
    // Every agent votes what it computes: B, P, or NO_BET (NO_VOTE).

    const agentStrength: VoterOut['agentStrength'] =
      finalConf >= 80 ? 'HIGH' : finalConf >= 62 ? 'MEDIUM' : 'LOW';

    return {
      ...baseFields,
      vote,
      voteType,
      stateKey,
      voteStatus,
      confidence: Math.round(finalConf),
      simScores: emptySimScores,
      skAccuracy,
      skSamples,
      hotCold,
      fastSignal: undefined,
      confirmedSignal: undefined,
      pressureScore: agentOut.pressureScore,
      numberPressure: agentOut.numberPressure,
      agentStrength,
      rejectionReason: agentOut.rejectionReason,
      // self-awareness fields
      uncertaintyScore: sa.uncertaintyScore,
      fakePatternRisk: sa.fakePatternRisk,
      entropyWarning: sa.entropyWarning,
      sideOnlyWarning: sa.sideOnlyWarning,
      contradictionWarning: sa.contradictionWarning,
      peerReviewChanged: false,
      peerReviewReason: '',
      selfAwarenessOverride: '',
    } as VoterOut;
  });

  // ── STEP 2: Build blackboard (broadcast) ───────────────────────────────────
  const blackboard: BlackboardEntry[] = firstPass.map(v => ({
    agentId: v.id,
    assignedView: v.agentGroup ?? 'UNKNOWN',
    vote: v.vote,
    pressureScore: v.pressureScore ?? 0,
    confidence: v.confidence,
    selfDoubtScore: v.uncertaintyScore ?? 0,
    fakeSignalWarning: (v.fakePatternRisk ?? 0) > 0.50,
    evidenceUsed: [
      'side',
      ...(Math.abs(v.pressureScore ?? 0) >= 12 ? ['final_number', 'high_low_pressure'] : []),
      v.agentGroup ?? 'assigned_view',
    ],
  }));

  // ── STEP 3: Peer review — informational read only, no vote changes ─────────
  // All 50 agents vote. Peer review provides awareness context but cannot force
  // any agent to abstain. Votes are locked as computed in step 1.
  const peerBCount = blackboard.filter(b => b.vote === 'B').length;
  const peerPCount = blackboard.filter(b => b.vote === 'P').length;
  const peerBPct   = peerBCount / blackboard.length;
  const peerPPct   = peerPCount / blackboard.length;
  void peerBPct; void peerPPct; // available for future informational use

  const finalVoters: VoterOut[] = firstPass;

  // ── STEP 4: Votes are locked ────────────────────────────────────────────────

  // ── STEP 5: Equal-weight consensus — all 50 votes counted ──────────────────
  // B if ≥30 votes for B, P if ≥30 votes for P, else NO_BET
  const bCount      = finalVoters.filter(v => v.vote === 'B').length;
  const pCount      = finalVoters.filter(v => v.vote === 'P').length;
  const tCount      = finalVoters.filter(v => v.vote === 'T').length;
  const noVoteCount = finalVoters.filter(v => v.vote === 'NO_VOTE').length;
  const total       = finalVoters.length; // always 50

  const currentPatternType = classifyCurrentPatternType(encoded);

  let recommendation: AIVote = 'NO_VOTE';
  let noBetReason = '';
  if (bCount >= 30)      { recommendation = 'B'; }
  else if (pCount >= 30) { recommendation = 'P'; }
  else                   { noBetReason = 'BELOW_30_VOTE_THRESHOLD'; }

  // Environment quality gate: suppress recommendation when this pattern type has historically failed
  if (recommendation !== 'NO_VOTE') {
    const ptEntry = ptm[currentPatternType];
    if (ptEntry.trials >= 6 && ptEntry.hits / ptEntry.trials < 0.38) {
      recommendation = 'NO_VOTE';
      noBetReason = `ENV_GATE_${currentPatternType.toUpperCase()}_FAILING`;
    }
  }

  const winVotePct = Math.max(bCount, pCount) / total * 100;
  const sorted2    = [bCount, pCount, tCount].sort((a, b) => b - a);
  const voteGapPct = ((sorted2[0] - sorted2[1]) / total) * 100;

  let highestVote: AIVote = 'NO_VOTE';
  if (bCount >= pCount && bCount >= tCount && bCount > 0) highestVote = 'B';
  else if (pCount >= bCount && pCount >= tCount && pCount > 0) highestVote = 'P';
  else if (tCount > 0) highestVote = 'T';

  const activeVoters = finalVoters.filter(v => v.vote !== 'NO_VOTE');
  const ensembleConfidence = activeVoters.length > 0
    ? Math.round(activeVoters.reduce((s, v) => s + v.confidence, 0) / activeVoters.length)
    : 0;

  return {
    voters: finalVoters,
    globalShoeState,
    decision: {
      recommendation,
      reason: noBetReason,
      bankerVotes: bCount,
      playerVotes: pCount,
      tieVotes: tCount,
      noVoteCount,
      totalActiveVotes: total - noVoteCount,
      winVotePct: Math.round(winVotePct * 10) / 10,
      voteGapPct: Math.round(voteGapPct * 10) / 10,
      consensus: recommendation === 'NO_VOTE' ? 'NO_BET' : getConsensus(winVotePct),
      highestVote,
      ensembleConfidence,
      agreementCount: total - noVoteCount,
      patternType: currentPatternType,
    },
  };
}

export function updateVoterStats(voters: VoterOut[], actualSide: Side): VoterOut[] {
  return voters.map((ai) => {
    const newAI = { ...ai };
    const { vote } = ai;
    const isPush = vote !== "NO_VOTE" && vote !== "T" && actualSide === "T";

    // Standard stat tracking
    if (vote === "NO_VOTE") { newAI.skipped++; newAI.allTimeSkipped++; }
    else if (isPush)        { newAI.push++;    newAI.allTimePush++; }
    else if (vote === actualSide) { newAI.correct++; newAI.allTimeCorrect++; }
    else                    { newAI.wrong++;   newAI.allTimeWrong++; }

    return newAI;
  });
}

export function initVoters(): VoterOut[] {
  return AGENT_CONFIGS.map((cfg) => ({
    id: cfg.id, name: cfg.name, shortTag: cfg.shortTag,
    vote: "NO_VOTE" as AIVote, voteType: "NO_VOTE" as const, stateKey: "ND",
    voteStatus: "NEUTRAL" as const, confidence: 0, simScores: emptySimScores,
    skAccuracy: 0, skSamples: 0, hotCold: "neutral" as const,
    reactionSpeed: cfg.reactionSpeed, startHand: cfg.startHand,
    skill: cfg.skill, skillTag: cfg.skillTag, skillDesc: cfg.skillDesc,
    regimeVote: "nd", textureVote: "nd",
    correct: 0, wrong: 0, push: 0, skipped: 0,
    allTimeCorrect: 0, allTimeWrong: 0, allTimePush: 0, allTimeSkipped: 0,
    pendingStateKey: "",
    pressureScore: 0, numberPressure: 'MIXED', agentStrength: 'LOW' as const,
    rejectionReason: 'WAITING', agentGroup: cfg.agentGroup,
    // self-awareness defaults
    uncertaintyScore: 0, fakePatternRisk: 0,
    entropyWarning: false, sideOnlyWarning: false, contradictionWarning: false,
    peerReviewChanged: false, peerReviewReason: '', selfAwarenessOverride: '',
  }));
}

export function archiveVoters(voters: VoterOut[]): VoterOut[] {
  return voters.map((v) => ({
    ...v,
    vote: "NO_VOTE" as AIVote, voteType: "NO_VOTE" as const, stateKey: "ND",
    voteStatus: "NEUTRAL" as const, confidence: 0, simScores: emptySimScores,
    skAccuracy: 0, skSamples: 0, hotCold: "neutral" as const,
    correct: 0, wrong: 0, push: 0, skipped: 0, pendingStateKey: "",
    pressureScore: 0, numberPressure: 'MIXED', agentStrength: 'LOW' as const,
    rejectionReason: '', agentGroup: v.agentGroup,
    // reset self-awareness state for new shoe
    uncertaintyScore: 0, fakePatternRisk: 0,
    entropyWarning: false, sideOnlyWarning: false, contradictionWarning: false,
    peerReviewChanged: false, peerReviewReason: '', selfAwarenessOverride: '',
  }));
}

export function initPatternTypeMemory(): PatternTypeMemory {
  return {
    dragon:       { hits: 0, trials: 0 },
    chop:         { hits: 0, trials: 0 },
    highPressure: { hits: 0, trials: 0 },
    mixed:        { hits: 0, trials: 0 },
  };
}

export function updatePatternTypeMemory(
  ptm: PatternTypeMemory,
  patternType: string,
  recommendation: AIVote,
  actualSide: Side,
): PatternTypeMemory {
  if (recommendation === 'NO_VOTE' || recommendation === 'T') return ptm;
  const key = patternType as keyof PatternTypeMemory;
  if (!ptm[key]) return ptm;
  const wasCorrect = recommendation === actualSide;
  return {
    ...ptm,
    [key]: { hits: ptm[key].hits + (wasCorrect ? 1 : 0), trials: ptm[key].trials + 1 },
  };
}

export function calcAccuracy(correct: number, wrong: number): number {
  const d = correct + wrong;
  return d > 0 ? Math.round((correct / d) * 100) : 0;
}
