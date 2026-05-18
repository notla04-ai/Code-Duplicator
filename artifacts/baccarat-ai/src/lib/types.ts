export type Side = 'B' | 'P' | 'T';
export type AIVote = 'B' | 'P' | 'T' | 'NO_VOTE';
export type ConsensusLevel = 'VERY_STRONG' | 'STRONG' | 'MEDIUM' | 'WEAK' | 'NO_BET';
export type VoteType = 'HOT_ACTIVE' | 'HOT' | 'WARM' | 'NORMAL' | 'WEAK' | 'NO_VOTE';
export type ReactionSpeed = 'FAST' | 'NORMAL' | 'SLOW';
export type HotColdStatus = 'hot' | 'cold' | 'neutral';
export type VoteStatus = 'HOT' | 'COLD' | 'NEUTRAL';
export type PairFlags = 'banker_pair' | 'player_pair' | 'none';
export type PressureBand = 'LOW' | 'HIGH' | 'STRONG_HIGH' | 'KILL_SHOT';
export type AgentStrength = 'LOW' | 'MEDIUM' | 'HIGH';

export interface SimScores {
  continuationRate: number;
  reversalRate: number;
  chopRate: number;
  sampleSize: number;
  simConfidence: number;
}

export interface AIStateKeyEntry {
  samples: number;
  successes: number;
  lastSeenHand: number;
  accuracy: number;
}

export type AIStateKeyMemory = Record<string, Record<string, AIStateKeyEntry>>;

// ─── Global Shoe State (consensus from all 50 AIs) ────────────────────────────

export interface GlobalShoeState {
  regime: 'trend' | 'chop' | 'mix' | 'nd';
  texture: 'smooth' | 'mix' | 'chop' | 'nd';
  volatility: 'H' | 'M' | 'L';
  streak: { side: Side | null; length: number };
  trend: 'up' | 'dn' | 'fl' | 'nd';
  phase: 'early' | 'mid' | 'late';
  dominantSide: 'B' | 'P' | 'equal';
  regimeVotes: Record<string, number>;
  textureVotes: Record<string, number>;
  aiContrib: Record<string, string>;
  handCount: number;
}

export interface VoterOut {
  id: string;
  name: string;
  shortTag: string;
  vote: AIVote;
  voteType: VoteType;
  stateKey: string;
  voteStatus: VoteStatus;
  confidence: number;
  simScores: SimScores;
  skAccuracy: number;
  skSamples: number;
  hotCold: HotColdStatus;
  reactionSpeed: ReactionSpeed;
  startHand: number;
  fastSignal?: { vote: AIVote; confidence: number };
  confirmedSignal?: { vote: AIVote; confidence: number };
  regimeVote: string;
  textureVote: string;
  correct: number;
  wrong: number;
  push: number;
  skipped: number;
  allTimeCorrect: number;
  allTimeWrong: number;
  allTimePush: number;
  allTimeSkipped: number;
  pendingStateKey: string;
  skill: string;
  skillTag: string;
  skillDesc: string;
  // ─── Pressure fields (50-agent system) ──────────────────────────────────────
  pressureScore?: number;       // -100 to +100
  numberPressure?: string;      // LOW | HIGH | STRONG_HIGH | KILL_SHOT | MIXED
  agentStrength?: AgentStrength;
  rejectionReason?: string;
  agentGroup?: string;
  // ─── Self-Awareness Layer (informational only — cannot force abstain) ───────
  uncertaintyScore?: number;     // 0.00-1.00
  fakePatternRisk?: number;      // 0.00-1.00
  entropyWarning?: boolean;
  sideOnlyWarning?: boolean;
  contradictionWarning?: boolean;
  peerReviewChanged?: boolean;
  peerReviewReason?: string;
  selfAwarenessOverride?: string; // reason hard rule fired
}

export interface HandResult {
  side: Side;
  number: number;
  sideNumber: string;
  id: string;
  pairFlags?: PairFlags;
  naturalFlag?: boolean;
}

export interface FinalDecision {
  recommendation: AIVote;
  reason: string;
  bankerVotes: number;
  playerVotes: number;
  tieVotes: number;
  noVoteCount: number;
  totalActiveVotes: number;
  winVotePct: number;
  voteGapPct: number;
  consensus: ConsensusLevel;
  highestVote: AIVote;
  ensembleConfidence: number;
  agreementCount: number;
  patternType: 'dragon' | 'chop' | 'highPressure' | 'mixed';
}

export interface PatternTypeEntry {
  hits: number;
  trials: number;
}

export interface PatternTypeMemory {
  dragon:       PatternTypeEntry;
  chop:         PatternTypeEntry;
  highPressure: PatternTypeEntry;
  mixed:        PatternTypeEntry;
}

export interface PerformanceStats {
  correct: number;
  wrong: number;
  push: number;
  skipped: number;
  totalPlays: number;
  bankerPredictions: number;
  playerPredictions: number;
  tiePredictions: number;
  currentStreak: number;
  longestWinStreak: number;
  longestLossStreak: number;
  lastResult: string;
}

export interface PnLState {
  baseBet: number;
  sideBet: number;
  tiePayout: number;
  totalPnL: number;
  sessionPnL: number;
  lastBetSide: string;
  lastBetResult: string;
  lastBetAmount: number;
  lastMultiplier: number;
  lastFinalConfirmed: boolean;
}

export interface ArchivedShoe {
  id: number;
  hands: HandResult[];
  bankerPct: number;
  playerPct: number;
  tiePct: number;
  totalHands: number;
  timestamp: number;
}

// ─── Trigger System ───────────────────────────────────────────────────────────

export type TriggerType =
  | 'BANKER_STREAK'
  | 'PLAYER_STREAK'
  | 'TIE_APPEARED'
  | 'CHOP_PATTERN'
  | 'HOT_AI_COUNT'
  | 'CONSENSUS_LEVEL'
  | 'SIDE_BIAS'
  | 'STRONG_RECOMMENDATION'
  | 'DECISION_MATCH'
  | 'SWITCH_SAVER'
  | 'TIE_SAVER';

export type TriggerSide = 'B' | 'P' | 'T' | 'ANY';

export interface NumericMatcher {
  op: '>=' | '<=' | '>' | '<' | '==';
  val: number;
}

export interface DecisionMatch {
  finalRecommendation?: AIVote | 'ANY';
  highestVote?: AIVote | 'ANY';
  banker?: NumericMatcher;
  player?: NumericMatcher;
  tie?: NumericMatcher;
  noVote?: NumericMatcher;
  agree?: NumericMatcher;
  winVote?: NumericMatcher;
  ensemble?: NumericMatcher;
  consensus?: ConsensusLevel | 'ANY';
}

export interface TriggerCondition {
  type: TriggerType;
  side?: TriggerSide;
  streak?: number;
  count?: number;
  consensus?: ConsensusLevel;
  biasPercent?: number;
  decisionMatch?: DecisionMatch;
  savedSnapshot?: FinalDecision;
}

export interface Trigger {
  id: string;
  name: string;
  condition: TriggerCondition;
  enabled: boolean;
  isAuto: boolean;
  firedCount: number;
  lastFiredHand: number;
  cooldownHands: number;
}

export interface TriggerAlert {
  id: string;
  triggerId: string;
  triggerName: string;
  message: string;
  handNumber: number;
  timestamp: number;
  isAuto: boolean;
  side?: Side;
}

export interface AppState {
  activeShoe: HandResult[];
  shoeNumber: number;
  archivedShoes: ArchivedShoe[];
  voters: VoterOut[];
  aiStateKeyMemory: AIStateKeyMemory;
  finalDecision: FinalDecision;
  globalShoeState: GlobalShoeState;
  performance: PerformanceStats;
  highestVotePerf: PerformanceStats;
  pnl: PnLState;
  pendingDecision: FinalDecision | null;
  patternTypeMemory: PatternTypeMemory;
  triggers: Trigger[];
  triggerAlerts: TriggerAlert[];
  autoSaveSwitch: boolean;
  autoSaveTie: boolean;
}
