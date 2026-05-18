import { useState, useEffect, useCallback, useRef } from "react";
import type {
  Side, HandResult, VoterOut, FinalDecision, PerformanceStats,
  ArchivedShoe, AppState, AIStateKeyMemory, GlobalShoeState,
  Trigger, TriggerAlert, TriggerCondition, TriggerType, ConsensusLevel,
  DecisionMatch, NumericMatcher, AIVote, PairFlags,
} from "./lib/types";
import {
  initVoters, runVoters, updateVoterStats, archiveVoters,
  calcAccuracy, recordStateKeyOutcome,
} from "./lib/ai-engine";
import {
  buildBeadRoad, buildBigRoad, buildBigEyeBoy, buildSmallRoad, buildCockroachPig,
  type BeadRoadCell, type BigRoadCell, type DerivedCell,
} from "./lib/scoreboards";
import {
  runFullAnalysis,
  type AnalysisReport, type TrapDetection, type BaitPattern,
  type DeviationTest, type EdgeGateCheck, type TruthGate, type TruthGateCondition,
} from "./lib/analysis";

// ─── Storage ───────────────────────────────────────────────────────────────────

const STORAGE_KEY = "baccarat_ai_v6";

function loadState(): Partial<AppState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /**/ }
  return {};
}

function saveState(state: AppState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /**/ }
}

// ─── Default triggers ──────────────────────────────────────────────────────────

function makeDefaultTriggers(): Trigger[] {
  return [
    { id: 'auto-banker-3',    name: 'Banker 3-Streak',       condition: { type: 'BANKER_STREAK',   streak: 3 },            enabled: true, isAuto: true, firedCount: 0, lastFiredHand: -99, cooldownHands: 3 },
    { id: 'auto-player-3',    name: 'Player 3-Streak',       condition: { type: 'PLAYER_STREAK',   streak: 3 },            enabled: true, isAuto: true, firedCount: 0, lastFiredHand: -99, cooldownHands: 3 },
    { id: 'auto-chop',        name: 'Chop Pattern (5+ alt)', condition: { type: 'CHOP_PATTERN' },                          enabled: true, isAuto: true, firedCount: 0, lastFiredHand: -99, cooldownHands: 4 },
    { id: 'auto-hot-ai',      name: '3+ HOT AIs Active',     condition: { type: 'HOT_AI_COUNT',    count: 3 },             enabled: true, isAuto: true, firedCount: 0, lastFiredHand: -99, cooldownHands: 2 },
    { id: 'auto-very-strong', name: 'VERY STRONG Consensus', condition: { type: 'CONSENSUS_LEVEL', consensus: 'VERY_STRONG' }, enabled: true, isAuto: true, firedCount: 0, lastFiredHand: -99, cooldownHands: 2 },
  ];
}

// ─── Empty state factories ─────────────────────────────────────────────────────

function makeEmptyGSS(): GlobalShoeState {
  return {
    regime: 'nd', texture: 'nd', volatility: 'L',
    streak: { side: null, length: 0 }, trend: 'nd', phase: 'early',
    dominantSide: 'equal', regimeVotes: {}, textureVotes: {}, aiContrib: {},
    patterns: { c2b: 'nd', death: false, mirror: 'nd', sevens: null },
    handCount: 0,
  };
}

function makeInitialDecision(): FinalDecision {
  return {
    recommendation: "NO_VOTE", reason: "WAITING",
    bankerVotes: 0, playerVotes: 0, tieVotes: 0,
    noVoteCount: 50, totalActiveVotes: 0,
    winVotePct: 0, voteGapPct: 0, consensus: "NO_BET",
    highestVote: "NO_VOTE", ensembleConfidence: 0, agreementCount: 0,
  };
}

function makeInitialPerf(): PerformanceStats {
  return {
    correct: 0, wrong: 0, push: 0, skipped: 0, totalPlays: 0,
    bankerPredictions: 0, playerPredictions: 0, tiePredictions: 0,
    currentStreak: 0, longestWinStreak: 0, longestLossStreak: 0, lastResult: "",
  };
}

function isValidVoterArray(v: unknown): v is VoterOut[] {
  return Array.isArray(v) && v.length === 20 && typeof (v[0] as VoterOut).voteType === "string";
}

function buildInitialState(saved: Partial<AppState>): AppState {
  const ep = makeInitialPerf();
  const voters = isValidVoterArray(saved.voters) ? saved.voters : initVoters();
  return {
    activeShoe: saved.activeShoe ?? [],
    shoeNumber: saved.shoeNumber ?? 1,
    archivedShoes: saved.archivedShoes ?? [],
    voters,
    aiStateKeyMemory: saved.aiStateKeyMemory ?? {},
    finalDecision: saved.finalDecision ?? makeInitialDecision(),
    globalShoeState: saved.globalShoeState ?? makeEmptyGSS(),
    performance: saved.performance ? { ...ep, ...saved.performance } : ep,
    highestVotePerf: saved.highestVotePerf ? { ...ep, ...saved.highestVotePerf } : ep,
    pnl: {
      baseBet: saved.pnl?.baseBet ?? 500,
      sideBet: saved.pnl?.sideBet ?? 350,
      tiePayout: saved.pnl?.tiePayout ?? 8,
      totalPnL: saved.pnl?.totalPnL ?? 0,
      sessionPnL: saved.pnl?.sessionPnL ?? 0,
      lastBetSide: saved.pnl?.lastBetSide ?? "",
      lastBetResult: saved.pnl?.lastBetResult ?? "",
      lastBetAmount: saved.pnl?.lastBetAmount ?? 0,
      lastMultiplier: saved.pnl?.lastMultiplier ?? 1,
      lastFinalConfirmed: saved.pnl?.lastFinalConfirmed ?? false,
    },
    pendingDecision: saved.pendingDecision ?? null,
    triggers: saved.triggers ?? makeDefaultTriggers(),
    triggerAlerts: saved.triggerAlerts ?? [],
    autoSaveSwitch: saved.autoSaveSwitch ?? true,
    autoSaveTie: saved.autoSaveTie ?? true,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function pct(n: number, d: number) { return d > 0 ? Math.round(n / d * 100) + "%" : "0%"; }
function sideLabel(s: string) { return s === "B" ? "BANKER" : s === "P" ? "PLAYER" : s === "T" ? "TIE" : "NO BET"; }
function sideColor(s: string) { return s === "B" ? "#ff4444" : s === "P" ? "#4488ff" : s === "T" ? "#44dd88" : "#555"; }
function consensusColor(c: string) {
  return c === "VERY_STRONG" ? "#44dd88" : c === "STRONG" ? "#88cc44" : c === "MEDIUM" ? "#ddcc44" : c === "WEAK" ? "#dd8844" : "#555";
}
function voteTypeColor(vt: string) {
  return vt === "HOT_ACTIVE" ? "#ff2222" : vt === "HOT" ? "#ff8844" : vt === "WARM" ? "#ddaa44" : vt === "NORMAL" ? "#555" : vt === "WEAK" ? "#3a3a3a" : "#222";
}
function speedColor(rs: string) {
  return rs === "FAST" ? "#44dd88" : rs === "NORMAL" ? "#4488ff" : "#886688";
}

function updatePerfWithResult(perf: PerformanceStats, predicted: string, actual: Side, isPush: boolean, isSkip: boolean): PerformanceStats {
  const p = { ...perf };
  if (isSkip) { p.skipped++; return p; }
  p.totalPlays++;
  if (predicted === "B") p.bankerPredictions++;
  else if (predicted === "P") p.playerPredictions++;
  else if (predicted === "T") p.tiePredictions++;
  if (isPush || (actual === "T" && predicted !== "T")) {
    p.push++; p.lastResult = "PUSH"; p.currentStreak = 0;
  } else if (predicted === actual) {
    p.correct++;
    p.currentStreak = p.currentStreak > 0 ? p.currentStreak + 1 : 1;
    p.longestWinStreak = Math.max(p.longestWinStreak, p.currentStreak);
    p.lastResult = "WIN";
  } else {
    p.wrong++;
    p.currentStreak = p.currentStreak < 0 ? p.currentStreak - 1 : -1;
    p.longestLossStreak = Math.max(p.longestLossStreak, Math.abs(p.currentStreak));
    p.lastResult = "LOSS";
  }
  return p;
}

// ─── Trigger Engine ────────────────────────────────────────────────────────────

function getBPStreak(hands: HandResult[], side: Side): number {
  const bp = hands.filter(h => h.side !== 'T');
  let streak = 0;
  for (let i = bp.length - 1; i >= 0; i--) { if (bp[i].side === side) streak++; else break; }
  return streak;
}

function isChopPattern(hands: HandResult[], minLen = 5): boolean {
  const bp = hands.filter(h => h.side !== 'T').map(h => h.side);
  if (bp.length < minLen) return false;
  const tail = bp.slice(-minLen);
  let alts = 0;
  for (let i = 1; i < tail.length; i++) if (tail[i] !== tail[i - 1]) alts++;
  return alts / (tail.length - 1) >= 0.8;
}

function matchNum(val: number, m: NumericMatcher | undefined): boolean {
  if (!m) return true;
  switch (m.op) {
    case '>=': return val >= m.val;
    case '<=': return val <= m.val;
    case '>':  return val > m.val;
    case '<':  return val < m.val;
    case '==': return Math.abs(val - m.val) < 0.01;
  }
}

function snapshotFuzzyMatch(decision: FinalDecision, snap: FinalDecision): boolean {
  if (decision.recommendation !== snap.recommendation) return false;
  if (decision.highestVote !== snap.highestVote) return false;
  if (decision.consensus !== snap.consensus) return false;
  if (Math.abs(decision.winVotePct - snap.winVotePct) > 15) return false;
  if (Math.abs(decision.ensembleConfidence - snap.ensembleConfidence) > 15) return false;
  if (Math.abs(decision.agreementCount - snap.agreementCount) > 3) return false;
  return true;
}

function evaluateTrigger(t: Trigger, hands: HandResult[], voters: VoterOut[], decision: FinalDecision): { fired: boolean; message: string } {
  const c: TriggerCondition = t.condition;
  switch (c.type) {
    case 'BANKER_STREAK': { const s = getBPStreak(hands, 'B'); if (s >= (c.streak ?? 3)) return { fired: true, message: `BANKER streak: ${s} in a row` }; break; }
    case 'PLAYER_STREAK': { const s = getBPStreak(hands, 'P'); if (s >= (c.streak ?? 3)) return { fired: true, message: `PLAYER streak: ${s} in a row` }; break; }
    case 'TIE_APPEARED':  if (hands.length > 0 && hands[hands.length - 1].side === 'T') return { fired: true, message: 'TIE just appeared' }; break;
    case 'CHOP_PATTERN':  if (isChopPattern(hands)) return { fired: true, message: 'Chop pattern (5+ alt)' }; break;
    case 'HOT_AI_COUNT': {
      const hot = voters.filter(v => v.voteType === 'HOT_ACTIVE' || v.voteType === 'HOT').length;
      if (hot >= (c.count ?? 3)) return { fired: true, message: `${hot} HOT AIs active` }; break;
    }
    case 'CONSENSUS_LEVEL': {
      const order: ConsensusLevel[] = ['NO_BET', 'WEAK', 'MEDIUM', 'STRONG', 'VERY_STRONG'];
      const ni = order.indexOf(c.consensus ?? 'STRONG');
      const ai = order.indexOf(decision.consensus);
      if (ai >= ni && decision.consensus !== 'NO_BET') return { fired: true, message: `Consensus: ${decision.consensus} → ${sideLabel(decision.recommendation)}` }; break;
    }
    case 'SIDE_BIAS': {
      const bp = hands.filter(h => h.side !== 'T');
      if (bp.length < 10) break;
      const bPct = Math.round(bp.filter(h => h.side === 'B').length / bp.length * 100);
      const maxP = Math.max(bPct, 100 - bPct);
      if (maxP >= (c.biasPercent ?? 60)) return { fired: true, message: `${bPct > 50 ? 'BANKER' : 'PLAYER'} bias: ${maxP}%` }; break;
    }
    case 'STRONG_RECOMMENDATION':
      if (decision.recommendation !== 'NO_VOTE' && decision.winVotePct >= 75) return { fired: true, message: `Strong: ${sideLabel(decision.recommendation)} (${decision.winVotePct.toFixed(0)}%)` }; break;
    case 'DECISION_MATCH': {
      const dm = c.decisionMatch;
      if (!dm) break;
      if (dm.finalRecommendation && dm.finalRecommendation !== 'ANY' && decision.recommendation !== dm.finalRecommendation) break;
      if (dm.highestVote && dm.highestVote !== 'ANY' && decision.highestVote !== dm.highestVote) break;
      if (dm.consensus && dm.consensus !== 'ANY' && decision.consensus !== dm.consensus) break;
      if (!matchNum(decision.bankerVotes, dm.banker)) break;
      if (!matchNum(decision.playerVotes, dm.player)) break;
      if (!matchNum(decision.tieVotes, dm.tie)) break;
      if (!matchNum(decision.noVoteCount, dm.noVote)) break;
      if (!matchNum(decision.agreementCount, dm.agree)) break;
      if (!matchNum(decision.winVotePct, dm.winVote)) break;
      if (!matchNum(decision.ensembleConfidence, dm.ensemble)) break;
      return { fired: true, message: `Decision match: ${sideLabel(decision.recommendation)} Win${decision.winVotePct.toFixed(0)}% Ens${decision.ensembleConfidence}%` };
    }
    case 'SWITCH_SAVER': {
      if (!c.savedSnapshot) break;
      if (snapshotFuzzyMatch(decision, c.savedSnapshot)) return { fired: true, message: `⚠ Matches SWITCH pattern (${sideLabel(c.savedSnapshot.recommendation)} ${c.savedSnapshot.winVotePct.toFixed(0)}%)` };
      break;
    }
    case 'TIE_SAVER': {
      if (!c.savedSnapshot) break;
      if (snapshotFuzzyMatch(decision, c.savedSnapshot)) return { fired: true, message: `⚠ Matches TIE pattern (${sideLabel(c.savedSnapshot.recommendation)} ${c.savedSnapshot.winVotePct.toFixed(0)}%)` };
      break;
    }
  }
  return { fired: false, message: '' };
}

function checkTriggers(triggers: Trigger[], hands: HandResult[], voters: VoterOut[], decision: FinalDecision, _existing: TriggerAlert[]): { newAlerts: TriggerAlert[]; updatedTriggers: Trigger[] } {
  const handNumber = hands.length;
  const newAlerts: TriggerAlert[] = [];
  const updatedTriggers = triggers.map(trigger => {
    if (!trigger.enabled) return trigger;
    if (handNumber - trigger.lastFiredHand < trigger.cooldownHands) return trigger;
    const { fired, message } = evaluateTrigger(trigger, hands, voters, decision);
    if (fired) {
      newAlerts.push({ id: `${trigger.id}-${Date.now()}`, triggerId: trigger.id, triggerName: trigger.name, message, handNumber, timestamp: Date.now(), isAuto: trigger.isAuto, side: hands.length > 0 ? hands[hands.length - 1].side : undefined });
      return { ...trigger, firedCount: trigger.firedCount + 1, lastFiredHand: handNumber };
    }
    return trigger;
  });
  return { newAlerts, updatedTriggers };
}

// ─── Scoreboard Components ─────────────────────────────────────────────────────

const CELL = 16;
const ROWS = 6;
const GAP = 1;
const CS = CELL + GAP;

function RoadScroller({ title, children, minCols = 10 }: { title: string; children: React.ReactNode; minCols?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ color: '#666', fontSize: 7, letterSpacing: '0.06em', marginBottom: 3, fontWeight: 700 }}>{title}</div>
      <div ref={ref} style={{ overflowX: 'auto', overflowY: 'hidden', height: ROWS * CS + 2, minWidth: minCols * CS }}>
        {children}
      </div>
    </div>
  );
}

function BigRoadGrid({ cells }: { cells: BigRoadCell[] }) {
  const maxCol = cells.length > 0 ? Math.max(...cells.map(c => c.col)) : 0;
  const cols = Math.max(12, maxCol + 3);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth; }, [cells.length]);

  const gridMap: Record<string, BigRoadCell> = {};
  for (const c of cells) gridMap[`${c.col}-${c.row}`] = c;

  return (
    <RoadScroller title="BIG ROAD" minCols={12}>
      <div ref={ref} style={{ display: 'flex', flexDirection: 'row', gap: GAP, minWidth: cols * CS, overflowX: 'auto' }}>
        {Array.from({ length: cols }).map((_, col) => (
          <div key={col} style={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
            {Array.from({ length: ROWS }).map((_, row) => {
              const cell = gridMap[`${col}-${row}`];
              const color = cell ? sideColor(cell.side) : '#141414';
              return (
                <div key={row} style={{ width: CELL, height: CELL, position: 'relative', flexShrink: 0 }}>
                  <div style={{ width: CELL, height: CELL, borderRadius: '50%', border: `1.5px solid ${color}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {cell && <span style={{ color, fontSize: 6, fontWeight: 800 }}>{cell.side}</span>}
                  </div>
                  {cell && cell.ties > 0 && (
                    <div style={{ position: 'absolute', top: -2, right: -2, background: '#44dd88', color: '#000', fontSize: 5, fontWeight: 800, borderRadius: 2, padding: '0 2px', lineHeight: '8px' }}>
                      {cell.ties}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </RoadScroller>
  );
}

function DerivedRoadGrid({ title, cells }: { title: string; cells: DerivedCell[] }) {
  const DOT = 10;
  const DG = 1;
  const DS = DOT + DG;
  const DROWS = 6;
  const maxCol = cells.length > 0 ? Math.max(...cells.map(c => c.col)) : 0;
  const cols = Math.max(10, maxCol + 3);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth; }, [cells.length]);

  const gridMap: Record<string, DerivedCell> = {};
  for (const c of cells) gridMap[`${c.col}-${c.row}`] = c;

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ color: '#555', fontSize: 7, letterSpacing: '0.06em', marginBottom: 3, fontWeight: 700 }}>{title}</div>
      <div ref={ref} style={{ overflowX: 'auto', overflowY: 'hidden', height: DROWS * DS + 2 }}>
        <div style={{ display: 'flex', flexDirection: 'row', gap: DG, minWidth: cols * DS }}>
          {Array.from({ length: cols }).map((_, col) => (
            <div key={col} style={{ display: 'flex', flexDirection: 'column', gap: DG }}>
              {Array.from({ length: DROWS }).map((_, row) => {
                const cell = gridMap[`${col}-${row}`];
                const color = cell ? (cell.color === 'R' ? '#ff4444' : '#4488ff') : 'transparent';
                return (
                  <div key={row} style={{ width: DOT, height: DOT, borderRadius: '50%', border: `1px solid ${cell ? color : '#181818'}`, background: cell ? `${color}33` : 'transparent', flexShrink: 0 }} />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Bead Road Grid ─────────────────────────────────────────────────────────────

const CELL_PX = 18;

function BeadRoadGrid({ cells }: { cells: BeadRoadCell[] }) {
  if (cells.length === 0) return (
    <div style={{ height: CELL_PX * 6, display: 'flex', alignItems: 'center', paddingLeft: 8 }}>
      <span style={{ color: '#1a1a1a', fontSize: 7 }}>BEAD ROAD — no hands</span>
    </div>
  );
  const maxCol = Math.max(...cells.map(c => c.col)) + 2;
  const width = maxCol * CELL_PX;
  return (
    <div style={{ overflowX: 'auto', overflowY: 'hidden' }}>
      <div style={{ position: 'relative', width, height: CELL_PX * 6, flexShrink: 0 }}>
        {cells.map(cell => {
          const sideCol = cell.side === 'B' ? '#ff4444' : cell.side === 'P' ? '#4488ff' : '#44dd88';
          const x = cell.col * CELL_PX;
          const y = cell.row * CELL_PX;
          return (
            <div key={cell.index} style={{ position: 'absolute', left: x + 1, top: y + 1, width: CELL_PX - 2, height: CELL_PX - 2 }}>
              {/* Main circle */}
              <div style={{ width: '100%', height: '100%', borderRadius: '50%', border: `1.5px solid ${sideCol}`, background: `${sideCol}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                <span style={{ color: sideCol, fontSize: 7.5, fontWeight: 700, fontFamily: 'monospace' }}>{cell.finalNumber}</span>
                {/* Natural badge */}
                {cell.naturalFlag && (
                  <span style={{ position: 'absolute', top: -2, right: -2, width: 7, height: 7, background: '#ddcc44', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 4.5, color: '#000', fontWeight: 900 }}>N</span>
                )}
              </div>
              {/* Pair dots below circle */}
              {cell.pairFlags !== 'none' && (
                <div style={{ position: 'absolute', bottom: -3, left: 0, width: '100%', display: 'flex', justifyContent: 'center', gap: 1 }}>
                  {(cell.pairFlags === 'banker_pair') && (
                    <span style={{ width: 4, height: 4, background: '#ff4444', borderRadius: '50%', display: 'block' }} />
                  )}
                  {(cell.pairFlags === 'player_pair') && (
                    <span style={{ width: 4, height: 4, background: '#4488ff', borderRadius: '50%', display: 'block' }} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ScoreboardsPanel({ hands }: { hands: HandResult[] }) {
  const [open, setOpen] = useState(true);
  const beadRoadCells = buildBeadRoad(hands);
  const bigRoadCells = buildBigRoad(hands);
  const beyBoy     = buildBigEyeBoy(bigRoadCells);
  const smallRoad  = buildSmallRoad(bigRoadCells);
  const cockroach  = buildCockroachPig(bigRoadCells);
  return (
    <div style={{ background: '#0a0a0a', border: '1px solid #1a1a1a', borderRadius: 3, padding: '5px 8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', marginBottom: open ? 6 : 0 }} onClick={() => setOpen(o => !o)}>
        <span style={{ color: '#44dd88', fontSize: 8, fontWeight: 700, letterSpacing: '0.08em' }}>■ BACCARAT SCOREBOARDS</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ color: '#333', fontSize: 7 }}>
            <span style={{ color: '#ff4444' }}>●</span>B &nbsp;
            <span style={{ color: '#4488ff' }}>●</span>P &nbsp;
            <span style={{ color: '#44dd88' }}>●</span>T &nbsp;&nbsp;
            <span style={{ color: '#ff4444' }}>●</span><span style={{ color: '#4488ff' }}>●</span>derived
          </span>
          <span style={{ color: '#333', fontSize: 9 }}>{open ? '▲' : '▼'}</span>
        </div>
      </div>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Bead Road — chronological display with final numbers, pairs, naturals */}
          <div>
            <div style={{ color: '#333', fontSize: 6.5, fontWeight: 700, letterSpacing: '0.07em', marginBottom: 3 }}>BEAD ROAD</div>
            <BeadRoadGrid cells={beadRoadCells} />
          </div>
          <div style={{ borderTop: '1px solid #141414' }} />
          {/* Big Road — full width */}
          <BigRoadGrid cells={bigRoadCells} />
          {/* Divider */}
          <div style={{ borderTop: '1px solid #141414' }} />
          {/* Three derived roads side-by-side below */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <DerivedRoadGrid title="BIG EYE BOY" cells={beyBoy} />
            <DerivedRoadGrid title="SMALL ROAD"  cells={smallRoad} />
            <DerivedRoadGrid title="COCKROACH PIG" cells={cockroach} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Global Shoe State Panel ───────────────────────────────────────────────────

function GlobalShoeStatePanel({ gss }: { gss: GlobalShoeState }) {
  const [open, setOpen] = useState(false);
  const regColor = gss.regime === 'trend' ? '#44dd88' : gss.regime === 'chop' ? '#ff8844' : gss.regime === 'mix' ? '#ddcc44' : '#444';
  const txtColor = gss.texture === 'smooth' ? '#44dd88' : gss.texture === 'chop' ? '#ff8844' : gss.texture === 'mix' ? '#ddcc44' : '#444';
  const volColor = gss.volatility === 'H' ? '#ff4444' : gss.volatility === 'M' ? '#ddcc44' : '#44dd88';
  const strSide = gss.streak.side;
  const strColor = strSide === 'B' ? '#ff4444' : strSide === 'P' ? '#4488ff' : '#444';
  const trendColor = gss.trend === 'up' ? '#44dd88' : gss.trend === 'dn' ? '#ff4444' : '#666';
  const domColor = gss.dominantSide === 'B' ? '#ff4444' : gss.dominantSide === 'P' ? '#4488ff' : '#666';
  const pat = gss.patterns;

  const topVotes = Object.entries(gss.regimeVotes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const contribs = Object.entries(gss.aiContrib).slice(0, 8);

  return (
    <div style={{ background: '#080808', border: '1px solid #1a2a1a', borderTop: '2px solid #2a4a2a', borderRadius: 3, padding: '5px 8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: '#44aa44', fontSize: 8, fontWeight: 700, letterSpacing: '0.08em' }}>⬡ GLOBAL SHOE STATE</span>
          <span style={{ color: '#2a4a2a', fontSize: 7 }}>50 AI Consensus · {gss.handCount} hands</span>
          <span style={{ color: regColor, fontSize: 8, fontWeight: 700 }}>{gss.regime.toUpperCase()}</span>
          {strSide && <span style={{ color: strColor, fontSize: 7 }}>{strSide}×{gss.streak.length}</span>}
          {pat.death && <span style={{ color: '#ff4444', fontSize: 7, background: '#ff444415', padding: '1px 3px', borderRadius: 2 }}>DEATH</span>}
          {pat.sevens && <span style={{ color: '#ddcc44', fontSize: 7, background: '#ddcc4415', padding: '1px 3px', borderRadius: 2 }}>7s→{pat.sevens.signal}</span>}
        </div>
        <span style={{ color: '#333', fontSize: 9 }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 8 }}>
            {[
              { k: 'REGIME',    v: gss.regime.toUpperCase(),    c: regColor },
              { k: 'TEXTURE',   v: gss.texture.toUpperCase(),   c: txtColor },
              { k: 'VOLATIL',   v: gss.volatility,              c: volColor },
              { k: 'STREAK',    v: strSide ? `${strSide}×${gss.streak.length}` : 'nd', c: strColor },
              { k: 'TREND',     v: gss.trend.toUpperCase(),     c: trendColor },
              { k: 'PHASE',     v: gss.phase.toUpperCase(),     c: '#666' },
              { k: 'DOM SIDE',  v: gss.dominantSide,            c: domColor },
            ].map(({ k, v, c }) => (
              <div key={k} style={{ textAlign: 'center' }}>
                <div style={{ color: c, fontSize: 9, fontWeight: 800 }}>{v}</div>
                <div style={{ color: '#2a2a2a', fontSize: 6 }}>{k}</div>
              </div>
            ))}
          </div>

          <div style={{ borderTop: '1px solid #141414', paddingTop: 6 }}>
            <div style={{ color: '#333', fontSize: 7, marginBottom: 4, letterSpacing: '0.06em' }}>
              AI REGIME VOTES — top: {topVotes.map(([k, v]) => `${k}:${v}`).join(' ')}
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {contribs.map(([tag, vote]) => (
                <span key={tag} style={{ fontSize: 6.5, background: '#111', borderRadius: 2, padding: '1px 4px' }}>
                  <span style={{ color: '#444' }}>{tag}</span>
                  <span style={{ color: vote === 'trend' ? '#44dd88' : vote === 'chop' ? '#ff8844' : vote === 'smooth' ? '#44dd88' : '#ddcc44', marginLeft: 2 }}>{vote}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Analysis Intelligence Panel ──────────────────────────────────────────────

function StatBar({ label, value, min, max, color, fmt }: { label: string; value: number; min: number; max: number; color: string; fmt: (v: number) => string }) {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 1 }}>
        <span style={{ color: '#444', fontSize: 6.5 }}>{label}</span>
        <span style={{ color, fontSize: 6.5, fontWeight: 700 }}>{fmt(value)}</span>
      </div>
      <div style={{ background: '#141414', borderRadius: 2, height: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2, transition: 'width 0.4s' }} />
      </div>
    </div>
  );
}

function GateRow({ label, check }: { label: string; check: EdgeGateCheck }) {
  const c = check.pass ? '#44dd88' : '#ff4444';
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 4 }}>
      <span style={{ color: c, fontSize: 9, fontWeight: 900, lineHeight: 1, flexShrink: 0, marginTop: 1 }}>{check.pass ? '✓' : '✗'}</span>
      <div>
        <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginBottom: 1 }}>
          <span style={{ color: '#555', fontSize: 6.5, fontWeight: 700 }}>{label}</span>
          <span style={{ color: c, fontSize: 6.5, background: `${c}15`, padding: '0 3px', borderRadius: 2 }}>{check.value}</span>
        </div>
        <div style={{ color: '#333', fontSize: 6 }}>{check.detail}</div>
      </div>
    </div>
  );
}

function AlertCard({ label, severity, confidence, detail }: { label: string; severity: string; confidence?: number; detail: string }) {
  const c = severity === 'HIGH' ? '#ff3333' : severity === 'MEDIUM' ? '#ff8844' : '#ddcc44';
  return (
    <div style={{ background: `${c}0c`, border: `1px solid ${c}2a`, borderLeft: `2px solid ${c}`, borderRadius: 2, padding: '3px 6px', marginBottom: 3 }}>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginBottom: 1 }}>
        <span style={{ color: c, fontSize: 6.5, fontWeight: 800 }}>{label.toUpperCase()}</span>
        <span style={{ color: `${c}88`, fontSize: 5.5, background: `${c}18`, padding: '0 3px', borderRadius: 2 }}>{severity}</span>
        {confidence !== undefined && <span style={{ color: '#444', fontSize: 5.5, marginLeft: 'auto' }}>{Math.round(confidence * 100)}%</span>}
      </div>
      <div style={{ color: '#555', fontSize: 6 }}>{detail}</div>
    </div>
  );
}

function DevTest({ d }: { d: DeviationTest }) {
  const c = d.significant ? '#44dd88' : '#333';
  const pStr = d.pValue < 0.001 ? '<0.001' : d.pValue < 0.01 ? '<0.01' : d.pValue.toFixed(3);
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'flex-start', marginBottom: 3, padding: '3px 5px', background: '#0c0c0c', borderRadius: 2, borderLeft: `2px solid ${c}` }}>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginBottom: 1 }}>
          <span style={{ color: '#444', fontSize: 6, fontWeight: 700 }}>{d.name}</span>
          {d.significant && <span style={{ color: '#44dd88', fontSize: 5.5, background: '#44dd8815', padding: '0 3px', borderRadius: 2 }}>SIG p={pStr}</span>}
          {!d.significant && <span style={{ color: '#2a2a2a', fontSize: 5.5 }}>p={pStr}</span>}
        </div>
        <div style={{ color: '#333', fontSize: 5.5 }}>{d.direction}</div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ color: c, fontSize: 7, fontWeight: 800 }}>{Math.abs(d.statistic).toFixed(3)}</div>
        <div style={{ color: '#2a2a2a', fontSize: 5.5 }}>h={d.effectSize.toFixed(3)}</div>
      </div>
    </div>
  );
}

function AnalysisIntelligencePanel({
  report, hands,
}: {
  report: AnalysisReport;
  hands: HandResult[];
}) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<'gate' | 'entropy' | 'transitions' | 'patterns' | 'deviations'>('gate');

  const { edgeGate, entropy, transitions, streakModel, baitPatterns, traps, deviations, randomness, fingerprint, integrity } = report;

  const allAlerts: (TrapDetection | BaitPattern)[] = [...baitPatterns, ...traps];
  const highAlerts = allAlerts.filter(a => a.severity === 'HIGH');
  const integrityColor = integrity.valid ? '#44dd88' : '#ff4444';

  const gateColor = edgeGate.pass ? '#44dd88' : '#555';
  const topBorder = edgeGate.pass ? '#44dd8840' : highAlerts.length > 0 ? '#ff333340' : '#1a1a1a';

  const tabs: { key: typeof tab; label: string }[] = [
    { key: 'gate', label: 'EDGE GATE' },
    { key: 'entropy', label: 'ENTROPY' },
    { key: 'transitions', label: 'TRANSITIONS' },
    { key: 'patterns', label: `PATTERNS${allAlerts.length > 0 ? ` (${allAlerts.length})` : ''}` },
    { key: 'deviations', label: 'TESTS' },
  ];

  return (
    <div style={{ background: '#070707', border: '1px solid #1a1a1a', borderTop: `2px solid ${topBorder}`, borderRadius: 3, padding: '5px 8px' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', marginBottom: open ? 6 : 0 }} onClick={() => setOpen(o => !o)}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: '#666', fontSize: 7.5, fontWeight: 700, letterSpacing: '0.08em' }}>⬡ STOCHASTIC ANALYSIS ENGINE</span>
          <span style={{ color: gateColor, fontSize: 8, fontWeight: 900, background: `${gateColor}15`, padding: '1px 5px', borderRadius: 2 }}>
            {edgeGate.pass ? `EDGE: ${edgeGate.suggestedSide}` : `SKIP (${edgeGate.checksPass}/5)`}
          </span>
          <span style={{ color: '#333', fontSize: 6.5 }}>H={entropy.shannon.toFixed(4)}</span>
          {highAlerts.length > 0 && <span style={{ color: '#ff3333', fontSize: 6, background: '#ff333315', padding: '0 4px', borderRadius: 2 }}>⚠ {highAlerts.length} HIGH</span>}
          {!integrity.valid && <span style={{ color: '#ff4444', fontSize: 6, background: '#ff444415', padding: '0 4px', borderRadius: 2 }}>INTEGRITY ⚠</span>}
        </div>
        <span style={{ color: '#2a2a2a', fontSize: 9 }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div>
          {/* Tabs */}
          <div style={{ display: 'flex', gap: 2, marginBottom: 8, borderBottom: '1px solid #141414', paddingBottom: 4 }}>
            {tabs.map(t => (
              <button key={t.key} onClick={() => setTab(t.key)}
                style={{ background: tab === t.key ? '#1a1a1a' : 'transparent', border: `1px solid ${tab === t.key ? '#2a2a2a' : 'transparent'}`, color: tab === t.key ? '#aaa' : '#333', fontSize: 6, padding: '2px 5px', borderRadius: 2, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.06em' }}>
                {t.label}
              </button>
            ))}
          </div>

          {/* ── EDGE GATE TAB ── */}
          {tab === 'gate' && (
            <div>
              {/* Summary row */}
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 10, marginBottom: 8, padding: '6px 8px', background: '#0c0c0c', borderRadius: 3, border: `1px solid ${gateColor}22` }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ color: gateColor, fontSize: 20, fontWeight: 900, lineHeight: 1, marginBottom: 2 }}>
                    {edgeGate.pass ? edgeGate.suggestedSide === 'B' ? 'BKR' : 'PLR' : 'SKIP'}
                  </div>
                  <div style={{ color: '#333', fontSize: 5.5, letterSpacing: '0.08em' }}>{edgeGate.checksPass}/5 GATES</div>
                </div>
                <div>
                  <div style={{ color: '#333', fontSize: 5.5, marginBottom: 2, letterSpacing: '0.06em' }}>VERDICT</div>
                  <div style={{ color: edgeGate.pass ? '#44dd88' : '#666', fontSize: 6.5 }}>{edgeGate.reason}</div>
                  <div style={{ color: '#2a2a2a', fontSize: 6, marginTop: 3, fontStyle: 'italic' }}>
                    {edgeGate.pass
                      ? 'Mathematical edge confirmed — 5/5 conditions met'
                      : 'Edge is presumed ABSENT until all 5 gates pass. AI consensus ≠ mathematical edge.'}
                  </div>
                </div>
              </div>

              {/* Gate checklist */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                <GateRow label="1 · Sample Size (≥30 BP hands)" check={edgeGate.checks.sampleSize} />
                <GateRow label="2 · Entropy Drop (Shannon < 0.985)" check={edgeGate.checks.entropyDrop} />
                <GateRow label="3 · Effect Size (Cohen's h ≥ 0.12)" check={edgeGate.checks.effectSize} />
                <GateRow label="4 · Statistical Tests (persistent transition or ≥2 sig tests)" check={edgeGate.checks.transitionPersists} />
                <GateRow label="5 · Cross-Shoe Bias (≥1 archived shoe confirms direction)" check={edgeGate.checks.crossShoeBias} />
              </div>

              {/* Shoe stats */}
              <div style={{ display: 'flex', gap: 8, marginTop: 6, paddingTop: 6, borderTop: '1px solid #141414' }}>
                {[
                  { l: 'BANKER', v: `${randomness.bankerPct}%`, c: '#ff4444' },
                  { l: 'PLAYER', v: `${randomness.playerPct}%`, c: '#4488ff' },
                  { l: 'CHOP', v: `${Math.round(fingerprint.chopRate * 100)}%`, c: '#666' },
                  { l: 'AVG RUN', v: fingerprint.avgRunLength.toFixed(1), c: '#666' },
                  { l: 'INTEGRITY', v: integrity.valid ? 'OK' : 'ERR', c: integrityColor },
                  { l: 'HANDS', v: `${hands.length}`, c: '#555' },
                ].map(({ l, v, c }) => (
                  <div key={l} style={{ textAlign: 'center' }}>
                    <div style={{ color: c, fontSize: 9, fontWeight: 800 }}>{v}</div>
                    <div style={{ color: '#2a2a2a', fontSize: 5.5 }}>{l}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── ENTROPY TAB ── */}
          {tab === 'entropy' && (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 4, marginBottom: 8 }}>
                {[
                  { label: 'SHANNON', value: entropy.shannon, verdict: entropy.verdict, desc: 'Binary entropy (0–1)' },
                  { label: 'PERMUTATION', value: entropy.permutation, verdict: entropy.permutation > 0.95 ? 'HIGH' : 'REDUCED', desc: 'Temporal order-3 entropy' },
                  { label: 'LEMPEL-ZIV', value: entropy.lempelZiv, verdict: entropy.lempelZiv > 0.85 ? 'HIGH' : 'REDUCED', desc: 'Compression complexity' },
                ].map(({ label, value, verdict, desc }) => {
                  const vc = verdict === 'MAXIMUM' || verdict === 'HIGH' ? '#ff8844' : verdict === 'REDUCED' ? '#ddcc44' : '#44dd88';
                  return (
                    <div key={label} style={{ background: '#0d0d0d', borderRadius: 2, padding: '5px 7px' }}>
                      <div style={{ color: '#333', fontSize: 5.5, marginBottom: 2, letterSpacing: '0.06em' }}>{label}</div>
                      <div style={{ color: vc, fontSize: 13, fontWeight: 900, lineHeight: 1, marginBottom: 2 }}>{value.toFixed(4)}</div>
                      <div style={{ color: '#2a2a2a', fontSize: 5.5 }}>{desc}</div>
                    </div>
                  );
                })}
              </div>

              <div style={{ background: '#0c0c0c', borderRadius: 2, padding: '5px 7px', marginBottom: 6 }}>
                <div style={{ color: '#333', fontSize: 5.5, marginBottom: 3, letterSpacing: '0.06em' }}>ENTROPY VERDICT</div>
                <div style={{ color: entropy.significantDrop ? '#44dd88' : '#ff8844', fontSize: 7, fontWeight: 700, marginBottom: 2 }}>{entropy.verdict}</div>
                <div style={{ color: '#444', fontSize: 6 }}>{entropy.detail}</div>
              </div>

              <StatBar label="Shannon H (lower = more structured)" value={entropy.shannon} min={0.9} max={1}
                color={entropy.shannon < 0.985 ? '#44dd88' : '#ff8844'} fmt={v => v.toFixed(4)} />
              <StatBar label="Permutation Entropy (order 3)" value={entropy.permutation} min={0.8} max={1}
                color={entropy.permutation < 0.95 ? '#44dd88' : '#ff8844'} fmt={v => v.toFixed(4)} />
              <StatBar label="Lempel-Ziv Complexity" value={entropy.lempelZiv} min={0.5} max={1}
                color={entropy.lempelZiv < 0.85 ? '#44dd88' : '#ff8844'} fmt={v => v.toFixed(4)} />

              {/* Streak model */}
              <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid #141414' }}>
                <div style={{ color: '#333', fontSize: 6, fontWeight: 700, letterSpacing: '0.07em', marginBottom: 4 }}>BAYESIAN STREAK MODEL</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {[
                    { l: 'CURRENT STREAK', v: `${streakModel.currentStreak}×${streakModel.currentSide || '?'}`, c: streakModel.currentSide === 'B' ? '#ff4444' : '#4488ff' },
                    { l: 'P(CONTINUES)', v: `${(streakModel.pContinues * 100).toFixed(1)}%`, c: streakModel.pContinues > 0.6 ? '#ff8844' : '#666' },
                    { l: 'GEO MEAN', v: isFinite(streakModel.geometricMean) ? streakModel.geometricMean.toFixed(1) : '∞', c: '#555' },
                    { l: 'EXHAUSTION', v: streakModel.exhaustionRisk ? 'RISK' : 'NONE', c: streakModel.exhaustionRisk ? '#ff4444' : '#333' },
                  ].map(({ l, v, c }) => (
                    <div key={l} style={{ textAlign: 'center' }}>
                      <div style={{ color: c, fontSize: 9, fontWeight: 700 }}>{v}</div>
                      <div style={{ color: '#2a2a2a', fontSize: 5.5 }}>{l}</div>
                    </div>
                  ))}
                </div>
                <div style={{ color: '#2a2a2a', fontSize: 6, marginTop: 4, fontStyle: 'italic' }}>{streakModel.detail}</div>
              </div>
            </div>
          )}

          {/* ── TRANSITIONS TAB ── */}
          {tab === 'transitions' && (
            <div>
              {/* 2×2 matrix */}
              <div style={{ marginBottom: 6 }}>
                <div style={{ color: '#333', fontSize: 6, fontWeight: 700, letterSpacing: '0.06em', marginBottom: 4 }}>TRANSITION PROBABILITY MATRIX (posterior)</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}>
                  {[
                    { label: 'B → BANKER', pct: transitions.pctMatrix.BB, raw: transitions.rawCounts.BB, c: '#ff4444', post: (transitions.bankerContinuation * 100).toFixed(1) },
                    { label: 'B → PLAYER', pct: transitions.pctMatrix.BP, raw: transitions.rawCounts.BP, c: '#aa4444', post: null },
                    { label: 'P → BANKER', pct: transitions.pctMatrix.PB, raw: transitions.rawCounts.PB, c: '#4444aa', post: null },
                    { label: 'P → PLAYER', pct: transitions.pctMatrix.PP, raw: transitions.rawCounts.PP, c: '#4488ff', post: (transitions.playerContinuation * 100).toFixed(1) },
                  ].map(({ label, pct, raw, c, post }) => (
                    <div key={label} style={{ background: '#0d0d0d', borderRadius: 2, padding: '4px 7px' }}>
                      <div style={{ color: '#333', fontSize: 5.5, marginBottom: 2 }}>{label}</div>
                      <div style={{ color: c, fontSize: 13, fontWeight: 900, lineHeight: 1 }}>{pct}%</div>
                      <div style={{ display: 'flex', gap: 5, marginTop: 2 }}>
                        <span style={{ color: '#2a2a2a', fontSize: 5.5 }}>n={raw}</span>
                        {post !== null && <span style={{ color: '#4488ff', fontSize: 5.5 }}>posterior={post}%</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Persistence stats */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 3, marginBottom: 6 }}>
                {[
                  { l: 'χ² STAT', v: transitions.chiSquare.toFixed(2), c: transitions.chiSquare > 3.84 ? '#44dd88' : '#333' },
                  { l: 'P-VALUE', v: transitions.pValue < 0.001 ? '<0.001' : transitions.pValue.toFixed(3), c: transitions.pValue < 0.05 ? '#44dd88' : '#333' },
                  { l: "CRAMÉR'S V", v: transitions.cramersV.toFixed(3), c: transitions.cramersV > 0.1 ? '#ddcc44' : '#333' },
                  { l: 'STATIONARITY', v: `${(transitions.stationarity * 100).toFixed(0)}%`, c: transitions.stationarity > 0.88 ? '#44dd88' : '#ff8844' },
                ].map(({ l, v, c }) => (
                  <div key={l} style={{ background: '#0c0c0c', borderRadius: 2, padding: '3px 5px', textAlign: 'center' }}>
                    <div style={{ color: c, fontSize: 9, fontWeight: 700 }}>{v}</div>
                    <div style={{ color: '#2a2a2a', fontSize: 5.5 }}>{l}</div>
                  </div>
                ))}
              </div>

              <div style={{ background: '#0c0c0c', borderRadius: 2, padding: '4px 7px' }}>
                <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginBottom: 2 }}>
                  <span style={{ color: transitions.persistent ? '#44dd88' : '#ff4444', fontSize: 6.5, fontWeight: 700 }}>
                    {transitions.persistent ? '✓ PERSISTENT BIAS' : '✗ NOT PERSISTENT'}
                  </span>
                </div>
                <div style={{ color: '#444', fontSize: 6 }}>{transitions.detail}</div>
                <div style={{ color: '#2a2a2a', fontSize: 5.5, marginTop: 3 }}>
                  Persistence requires: χ² p&lt;0.05 AND stationarity &gt;88% AND n≥30. All 3 must hold simultaneously.
                </div>
              </div>
            </div>
          )}

          {/* ── PATTERNS TAB ── */}
          {tab === 'patterns' && (
            <div>
              {baitPatterns.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{ color: '#555', fontSize: 6, fontWeight: 700, letterSpacing: '0.07em', marginBottom: 4 }}>COGNITIVE MANIPULATION SIGNATURES</div>
                  {baitPatterns.map(p => (
                    <AlertCard key={p.id} label={p.label} severity={p.severity} confidence={p.confidence} detail={p.detail} />
                  ))}
                </div>
              )}
              {traps.length > 0 && (
                <div>
                  <div style={{ color: '#555', fontSize: 6, fontWeight: 700, letterSpacing: '0.07em', marginBottom: 4 }}>PSYCHOLOGICAL TRAP PATTERNS</div>
                  {traps.map(t => (
                    <AlertCard key={t.type} label={t.label} severity={t.severity} detail={t.detail} />
                  ))}
                </div>
              )}
              {allAlerts.length === 0 && (
                <div style={{ color: '#2a2a2a', fontSize: 7, padding: '8px', background: '#0c0c0c', borderRadius: 2, textAlign: 'center' }}>
                  No manipulation patterns detected — clean sequence
                </div>
              )}
            </div>
          )}

          {/* ── DEVIATIONS TAB ── */}
          {tab === 'deviations' && (
            <div>
              <div style={{ color: '#333', fontSize: 6, marginBottom: 5, fontStyle: 'italic' }}>
                Significance at p&lt;0.05. Effect size (h) measures magnitude independent of sample size. Multiple tests require Bonferroni caution.
              </div>
              {deviations.length === 0 ? (
                <div style={{ color: '#2a2a2a', fontSize: 7, padding: '8px', background: '#0c0c0c', borderRadius: 2, textAlign: 'center' }}>Need ≥8 BP hands</div>
              ) : (
                deviations.map(d => <DevTest key={d.name} d={d} />)
              )}
              <div style={{ marginTop: 6, padding: '4px 6px', background: '#0c0c0c', borderRadius: 2 }}>
                <div style={{ color: '#333', fontSize: 5.5, marginBottom: 2 }}>ENSEMBLE CAUTION</div>
                <div style={{ color: '#2a2a2a', fontSize: 5.5 }}>
                  AI voter agreement (20-voter ensemble) reflects pattern correlation among models trained on the same sequence — it is NOT an independent statistical test. Do not use it as corroboration. Only the 5 gate conditions above constitute valid evidence of exploitable edge.
                </div>
              </div>
            </div>
          )}

        </div>
      )}
    </div>
  );
}

// ─── Shoe History Grid ─────────────────────────────────────────────────────────

function ShoeHistoryGrid({ hands, onRemove }: { hands: HandResult[]; onRemove: (id: string) => void }) {
  const totalCols = Math.max(Math.ceil(hands.length / 6), 8);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth; }, [hands.length]);
  return (
    <div ref={ref} style={{ overflowX: 'auto', overflowY: 'hidden' }}>
      <div style={{ display: 'flex', flexDirection: 'row', gap: 2, minWidth: 'max-content' }}>
        {Array.from({ length: totalCols }).map((_, col) => (
          <div key={col} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {Array.from({ length: 6 }).map((_, row) => {
              const idx = col * 6 + row;
              const hand = idx < hands.length ? hands[idx] : null;
              if (!hand) return <div key={row} style={{ width: 22, height: 22, borderRadius: '50%', border: '1px solid #1c1c1c', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 7, color: '#2a2a2a' }}>?</div>;
              return (
                <div key={row} onClick={() => onRemove(hand.id)} style={{ width: 22, height: 22, borderRadius: '50%', border: `2px solid ${sideColor(hand.side)}`, color: sideColor(hand.side), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 700, cursor: 'pointer', userSelect: 'none' }} title={`Remove ${hand.sideNumber}`}>
                  {hand.number}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Performance Panel ─────────────────────────────────────────────────────────

function PerfPanel({ title, subtitle, perf, accentColor }: { title: string; subtitle: string; perf: PerformanceStats; accentColor: string }) {
  const acc = calcAccuracy(perf.correct, perf.wrong);
  const sc = perf.currentStreak > 0 ? "▲" : perf.currentStreak < 0 ? "▼" : "—";
  const streakColor = perf.currentStreak > 0 ? "#44dd88" : perf.currentStreak < 0 ? "#ff4444" : "#555";
  const lastColor = perf.lastResult === "WIN" ? "#44dd88" : perf.lastResult === "LOSS" ? "#ff4444" : perf.lastResult === "PUSH" ? "#ddcc44" : "#444";
  return (
    <div style={{ background: '#0a0a0a', border: `1px solid ${accentColor}22`, borderTop: `2px solid ${accentColor}`, borderRadius: 3, padding: '5px 8px', flex: 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <div>
          <div style={{ color: accentColor, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em' }}>{title}</div>
          <div style={{ color: '#444', fontSize: 7 }}>{subtitle}</div>
        </div>
        <div style={{ color: lastColor, fontSize: 8, fontWeight: 700 }}>{perf.lastResult || '—'}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 3, marginBottom: 4 }}>
        {[{ l: 'CORRECT', v: perf.correct, c: '#44dd88' }, { l: 'WRONG', v: perf.wrong, c: '#ff4444' }, { l: 'PUSH', v: perf.push, c: '#ddcc44' }, { l: 'SKIPPED', v: perf.skipped, c: '#555' }].map(({ l, v, c }) => (
          <div key={l} style={{ background: `${c}0d`, border: `1px solid ${c}22`, borderRadius: 2, padding: '3px 4px', textAlign: 'center' }}>
            <div style={{ color: c, fontSize: 12, fontWeight: 700, lineHeight: 1 }}>{v}</div>
            <div style={{ color: '#444', fontSize: 7, marginTop: 1 }}>{l}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 3, marginBottom: 4 }}>
        {[{ l: 'ACCURACY', v: `${acc}%`, c: acc >= 55 ? '#44dd88' : '#ff6644' }, { l: 'WIN RATE', v: pct(perf.correct, perf.totalPlays), c: '#44dd88' }, { l: 'LOSS RATE', v: pct(perf.wrong, perf.totalPlays), c: '#ff4444' }, { l: 'PUSH RATE', v: pct(perf.push, perf.totalPlays), c: '#ddcc44' }].map(({ l, v, c }) => (
          <div key={l} style={{ textAlign: 'center' }}>
            <div style={{ color: c, fontSize: 10, fontWeight: 700 }}>{v}</div>
            <div style={{ color: '#444', fontSize: 7 }}>{l}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, paddingTop: 3, borderTop: '1px solid #141414' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: streakColor, fontSize: 10, fontWeight: 700 }}>{sc} {Math.abs(perf.currentStreak)}</div>
          <div style={{ color: '#444', fontSize: 7 }}>STREAK</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: '#44dd88', fontSize: 10, fontWeight: 700 }}>{perf.longestWinStreak}</div>
          <div style={{ color: '#444', fontSize: 7 }}>BEST WIN</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: '#ff4444', fontSize: 10, fontWeight: 700 }}>{perf.longestLossStreak}</div>
          <div style={{ color: '#444', fontSize: 7 }}>WORST LOSS</div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ color: '#444', fontSize: 7, alignSelf: 'flex-end' }}>PLAYS {perf.totalPlays}</div>
      </div>
    </div>
  );
}

// ─── Voter Card ────────────────────────────────────────────────────────────────

function VoterCard({ ai, disabled }: { ai: VoterOut; disabled?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const acc = calcAccuracy(ai.correct, ai.wrong);
  const voteColor = disabled ? '#2a2a2a' : sideColor(ai.vote);
  const vtColor = disabled ? '#2a2a2a' : voteTypeColor(ai.voteType);
  const spColor = speedColor(ai.reactionSpeed);
  const hotColdColor = ai.hotCold === 'hot' ? '#ff6633' : ai.hotCold === 'cold' ? '#4499ff' : '#333';
  const regColor = ai.regimeVote === 'trend' ? '#44dd88' : ai.regimeVote === 'chop' ? '#ff8844' : ai.regimeVote === 'mix' ? '#ddcc44' : '#2a2a2a';

  return (
    <div style={{ background: disabled ? '#080808' : '#0d0d0d', border: `1px solid ${disabled ? '#ff222215' : ai.voteType === 'HOT_ACTIVE' ? '#ff222244' : ai.voteType === 'HOT' ? '#ff884422' : '#1a1a1a'}`, borderLeft: `2px solid ${disabled ? '#ff222233' : vtColor}`, borderRadius: 3, padding: '4px 6px', opacity: disabled ? 0.55 : 1 }}>
      {disabled && (
        <div style={{ color: '#ff3333', fontSize: 5.5, fontWeight: 800, letterSpacing: '0.08em', marginBottom: 2, background: '#ff333315', padding: '1px 4px', borderRadius: 1 }}>
          ✗ DISABLED — below 55% accuracy (≥50 resolved)
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <span style={{ color: disabled ? '#2a2a2a' : '#444', fontSize: 7, fontWeight: 700 }}>{ai.shortTag}</span>
          <span style={{ color: disabled ? '#3a2222' : '#ff884488', fontSize: 5, fontWeight: 700, background: disabled ? '#3a221a' : '#ff884412', padding: '1px 3px', borderRadius: 1, letterSpacing: '0.04em' }}>{ai.skillTag}</span>
        </div>
        <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
          <span style={{ color: regColor, fontSize: 6 }}>{ai.regimeVote}</span>
          <span style={{ color: spColor, fontSize: 6 }}>{ai.reactionSpeed[0]}</span>
          <span style={{ color: hotColdColor, fontSize: 7 }}>{ai.hotCold === 'hot' ? '●' : ai.hotCold === 'cold' ? '○' : '·'}</span>
          <button onClick={() => setExpanded(e => !e)} style={{ background: 'transparent', border: 'none', color: '#333', fontSize: 7, cursor: 'pointer', padding: 0 }}>{expanded ? '▲' : '▼'}</button>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ color: voteColor, fontSize: 11, fontWeight: 800 }}>{ai.vote === 'NO_VOTE' ? '—' : sideLabel(ai.vote)}</span>
          {ai.voteType !== 'NO_VOTE' && <span style={{ color: vtColor, fontSize: 6, fontWeight: 700, background: `${vtColor}18`, padding: '1px 3px', borderRadius: 2 }}>{ai.voteType}</span>}
        </div>
        <div style={{ color: ai.confidence > 0 ? '#aaa' : '#333', fontSize: 9, fontWeight: 700 }}>{ai.confidence > 0 ? `${ai.confidence}%` : '—'}</div>
      </div>
      <div style={{ marginBottom: 2 }}>
        <span style={{ color: '#2a2a2a', fontSize: 6, fontFamily: 'monospace', wordBreak: 'break-all' }} title={ai.stateKey}>{ai.stateKey && ai.stateKey !== 'ND' ? ai.stateKey.substring(0, 32) : '—'}</span>
      </div>
      <div style={{ display: 'flex', gap: 5, fontSize: 7.5 }}>
        <span style={{ color: '#44dd88' }}>✓{ai.correct}</span>
        <span style={{ color: '#ff4444' }}>✗{ai.wrong}</span>
        <span style={{ color: '#ddcc44' }}>◯{ai.push}</span>
        <span style={{ marginLeft: 'auto', color: acc >= 55 ? '#44dd88' : acc > 0 ? '#ff6644' : '#333', fontWeight: 700 }}>{acc > 0 ? `${acc}%` : '—'}</span>
      </div>
      {(ai.fastSignal || ai.confirmedSignal) && (
        <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
          {ai.fastSignal && <span style={{ color: '#44aa66', fontSize: 6, background: '#44aa6618', padding: '1px 3px', borderRadius: 2 }}>F:{sideLabel(ai.fastSignal.vote)[0]} {ai.fastSignal.confidence}%</span>}
          {ai.confirmedSignal && <span style={{ color: '#4488ff', fontSize: 6, background: '#4488ff18', padding: '1px 3px', borderRadius: 2 }}>C:{sideLabel(ai.confirmedSignal.vote)[0]} {ai.confirmedSignal.confidence}%</span>}
        </div>
      )}
      {expanded && (
        <div style={{ marginTop: 5, paddingTop: 4, borderTop: '1px solid #181818' }}>
          {/* ── Skill discipline description ── */}
          <div style={{ marginBottom: 5, padding: '3px 5px', background: '#ff884408', borderLeft: '2px solid #ff884422', borderRadius: 1 }}>
            <div style={{ color: '#ff8844', fontSize: 5.5, fontWeight: 700, letterSpacing: '0.07em', marginBottom: 1 }}>{ai.skill.toUpperCase().replace(/-/g, ' ')}</div>
            <div style={{ color: '#444', fontSize: 5.5, fontStyle: 'italic', lineHeight: 1.4 }}>{ai.skillDesc}</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 3, marginBottom: 4 }}>
            {[
              { l: 'SK ACC', v: ai.skSamples > 0 ? `${ai.skAccuracy}%` : '—', c: ai.skAccuracy >= 70 ? '#ff8844' : ai.skAccuracy >= 55 ? '#44dd88' : '#dd6644' },
              { l: 'SK SMPLS', v: ai.skSamples > 0 ? String(ai.skSamples) : '—', c: ai.skSamples >= 20 ? '#aaa' : ai.skSamples >= 8 ? '#666' : '#3a3a3a' },
              { l: 'ALL-TIME', v: (() => { const a = calcAccuracy(ai.allTimeCorrect, ai.allTimeWrong); return a > 0 ? `${a}%` : '—'; })(), c: (() => { const a = calcAccuracy(ai.allTimeCorrect, ai.allTimeWrong); return a >= 65 ? '#44dd88' : a >= 55 ? '#88cc44' : a > 0 ? '#dd6644' : '#333'; })() },
            ].map(({ l, v, c }) => (
              <div key={l} style={{ textAlign: 'center' }}>
                <div style={{ color: c, fontSize: 9, fontWeight: 700 }}>{v}</div>
                <div style={{ color: '#2a2a2a', fontSize: 6 }}>{l}</div>
              </div>
            ))}
          </div>
          {ai.simScores.sampleSize > 0 && (
            <div style={{ marginBottom: 4 }}>
              <div style={{ color: '#2a2a2a', fontSize: 5.5, marginBottom: 2 }}>SIM · {ai.simScores.sampleSize} smpls</div>
              <div style={{ display: 'flex', gap: 5 }}>
                <span style={{ color: '#44dd88', fontSize: 7, fontWeight: 700 }}>C {ai.simScores.continuationRate}%</span>
                <span style={{ color: '#ff6644', fontSize: 7, fontWeight: 700 }}>R {ai.simScores.reversalRate}%</span>
                <span style={{ color: '#ddcc44', fontSize: 7, fontWeight: 700 }}>K {ai.simScores.chopRate}%</span>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <span style={{ color: '#2a2a2a', fontSize: 5.5 }}>REGIME VOTE</span>
            <span style={{ color: regColor, fontSize: 7, fontWeight: 700 }}>{ai.regimeVote}</span>
            <span style={{ color: '#2a2a2a', fontSize: 5.5, marginLeft: 4 }}>STATUS</span>
            <span style={{ color: ai.voteStatus === 'HOT' ? '#ff8844' : ai.voteStatus === 'COLD' ? '#4488ff' : '#444', fontSize: 7, fontWeight: 700 }}>{ai.voteStatus}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Trigger Alert Toast ───────────────────────────────────────────────────────

function TriggerAlertToast({ alerts, onDismiss }: { alerts: TriggerAlert[]; onDismiss: (id: string) => void }) {
  if (alerts.length === 0) return null;
  return (
    <div style={{ position: 'fixed', top: 10, right: 10, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 300 }}>
      {alerts.map(alert => {
        const isSw = alert.triggerName.startsWith('SWITCH');
        const isTie = alert.triggerName.startsWith('TIE');
        const borderColor = isSw ? '#ff4444' : isTie ? '#44dd88' : alert.isAuto ? '#ff8844' : '#44aaff';
        const tagColor = isSw ? '#ff4444' : isTie ? '#44dd88' : alert.isAuto ? '#ff8844' : '#44aaff';
        const tag = isSw ? 'SWITCH' : isTie ? 'TIE SAVER' : alert.isAuto ? 'AUTO' : 'SAVED';
        return (
          <div key={alert.id} className="trigger-alert-enter" style={{ background: '#050505', border: `1px solid ${borderColor}55`, borderLeft: `3px solid ${borderColor}`, borderRadius: 3, padding: '6px 8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
              <span style={{ color: tagColor, fontSize: 6, fontWeight: 800, background: `${tagColor}18`, padding: '1px 4px', borderRadius: 2 }}>{tag} TRIGGER</span>
              <button onClick={() => onDismiss(alert.id)} style={{ background: 'transparent', border: 'none', color: '#444', fontSize: 10, cursor: 'pointer', padding: 0 }}>×</button>
            </div>
            <div style={{ color: '#ccc', fontSize: 9, fontWeight: 700, marginBottom: 2 }}>{alert.triggerName}</div>
            <div style={{ color: '#777', fontSize: 8 }}>{alert.message}</div>
            <div style={{ color: '#333', fontSize: 7, marginTop: 2 }}>Hand #{alert.handNumber}</div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Trigger Manager Panel ─────────────────────────────────────────────────────

type DmOp = '>=' | '<=' | '>' | '<' | '==';
const OPS: DmOp[] = ['>=', '<=', '>', '<', '=='];

interface DmField { op: DmOp; val: string }
const emptyDmField = (): DmField => ({ op: '>=', val: '' });

function NumField({ label, field, onChange }: { label: string; field: DmField; onChange: (f: DmField) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ color: '#333', fontSize: 6 }}>{label}</span>
      <div style={{ display: 'flex', gap: 2 }}>
        <select value={field.op} onChange={e => onChange({ ...field, op: e.target.value as DmOp })}
          style={{ background: '#111', border: '1px solid #222', color: '#666', fontSize: 7, padding: '1px 2px', borderRadius: 2, width: 32 }}>
          {OPS.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
        <input value={field.val} onChange={e => onChange({ ...field, val: e.target.value })} placeholder="—"
          style={{ background: '#111', border: '1px solid #222', color: '#888', fontSize: 7, padding: '1px 3px', borderRadius: 2, width: 36, fontFamily: 'inherit' }} />
      </div>
    </div>
  );
}

const TRIGGER_FORM_TYPES: { type: TriggerType; label: string }[] = [
  { type: 'DECISION_MATCH',       label: 'Decision Match (all fields)' },
  { type: 'BANKER_STREAK',        label: 'Banker Streak' },
  { type: 'PLAYER_STREAK',        label: 'Player Streak' },
  { type: 'TIE_APPEARED',         label: 'Tie Appeared' },
  { type: 'CHOP_PATTERN',         label: 'Chop Pattern' },
  { type: 'HOT_AI_COUNT',         label: 'HOT AI Count' },
  { type: 'CONSENSUS_LEVEL',      label: 'Consensus Level' },
  { type: 'SIDE_BIAS',            label: 'Side Bias %' },
  { type: 'STRONG_RECOMMENDATION', label: 'Strong Recommendation' },
];

const VOTES: (AIVote | 'ANY')[] = ['ANY', 'B', 'P', 'T', 'NO_VOTE'];
const CONSENSUS_OPTS: (ConsensusLevel | 'ANY')[] = ['ANY', 'VERY_STRONG', 'STRONG', 'MEDIUM', 'WEAK', 'NO_BET'];

function TriggerManagerPanel({ triggers, onToggle, onDelete, onAdd, recentAlerts, onDismissAlert, autoSaveSwitch, autoSaveTie, onToggleAutoSwitch, onToggleAutoTie }: {
  triggers: Trigger[]; onToggle: (id: string) => void; onDelete: (id: string) => void;
  onAdd: (t: Trigger) => void; recentAlerts: TriggerAlert[]; onDismissAlert: (id: string) => void;
  autoSaveSwitch: boolean; autoSaveTie: boolean;
  onToggleAutoSwitch: () => void; onToggleAutoTie: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [newType, setNewType] = useState<TriggerType>('DECISION_MATCH');
  const [newName, setNewName] = useState('');
  const [newStreak, setNewStreak] = useState(3);
  const [newCount, setNewCount] = useState(3);
  const [newConsensus, setNewConsensus] = useState<ConsensusLevel>('STRONG');
  const [newBias, setNewBias] = useState(60);
  const [newCooldown, setNewCooldown] = useState(3);
  const [dmFinalRec, setDmFinalRec] = useState<AIVote | 'ANY'>('ANY');
  const [dmHighVote, setDmHighVote] = useState<AIVote | 'ANY'>('ANY');
  const [dmConsensus, setDmConsensus] = useState<ConsensusLevel | 'ANY'>('ANY');
  const [dmBanker, setDmBanker] = useState<DmField>(emptyDmField());
  const [dmPlayer, setDmPlayer] = useState<DmField>(emptyDmField());
  const [dmTie, setDmTie] = useState<DmField>(emptyDmField());
  const [dmNoVote, setDmNoVote] = useState<DmField>(emptyDmField());
  const [dmAgree, setDmAgree] = useState<DmField>(emptyDmField());
  const [dmWinVote, setDmWinVote] = useState<DmField>(emptyDmField());
  const [dmEnsemble, setDmEnsemble] = useState<DmField>(emptyDmField());

  function parseDmField(f: DmField): NumericMatcher | undefined {
    const v = parseFloat(f.val);
    if (isNaN(v) || f.val.trim() === '') return undefined;
    return { op: f.op, val: v };
  }

  function handleAdd() {
    const label = TRIGGER_FORM_TYPES.find(t => t.type === newType)?.label ?? newType;
    const name = newName.trim() || label;
    let cond: TriggerCondition = { type: newType };
    if (newType === 'BANKER_STREAK' || newType === 'PLAYER_STREAK') cond.streak = newStreak;
    if (newType === 'HOT_AI_COUNT') cond.count = newCount;
    if (newType === 'CONSENSUS_LEVEL') cond.consensus = newConsensus;
    if (newType === 'SIDE_BIAS') cond.biasPercent = newBias;
    if (newType === 'DECISION_MATCH') {
      const dm: DecisionMatch = {};
      if (dmFinalRec !== 'ANY') dm.finalRecommendation = dmFinalRec;
      if (dmHighVote !== 'ANY') dm.highestVote = dmHighVote;
      if (dmConsensus !== 'ANY') dm.consensus = dmConsensus;
      const b = parseDmField(dmBanker); if (b) dm.banker = b;
      const pl = parseDmField(dmPlayer); if (pl) dm.player = pl;
      const ti = parseDmField(dmTie); if (ti) dm.tie = ti;
      const nv = parseDmField(dmNoVote); if (nv) dm.noVote = nv;
      const ag = parseDmField(dmAgree); if (ag) dm.agree = ag;
      const wv = parseDmField(dmWinVote); if (wv) dm.winVote = wv;
      const en = parseDmField(dmEnsemble); if (en) dm.ensemble = en;
      cond.decisionMatch = dm;
    }
    onAdd({ id: `saved-${Date.now()}`, name, condition: cond, enabled: true, isAuto: false, firedCount: 0, lastFiredHand: -99, cooldownHands: newCooldown });
    setNewName('');
  }

  const systemTriggers = triggers.filter(t => t.isAuto && t.condition.type !== 'SWITCH_SAVER' && t.condition.type !== 'TIE_SAVER');
  const switchSavers  = triggers.filter(t => t.condition.type === 'SWITCH_SAVER');
  const tieSavers     = triggers.filter(t => t.condition.type === 'TIE_SAVER');
  const savedTriggers = triggers.filter(t => !t.isAuto && t.condition.type !== 'SWITCH_SAVER' && t.condition.type !== 'TIE_SAVER');

  function TrigRow({ t, color }: { t: Trigger; color: string }) {
    const snap = t.condition.savedSnapshot;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: t.enabled ? '#111' : '#0c0c0c', borderRadius: 2, padding: '4px 6px', border: `1px solid ${t.enabled ? '#222' : '#161616'}` }}>
        {/* Toggle pill */}
        <div onClick={() => onToggle(t.id)} title={t.enabled ? 'Click to disable' : 'Click to enable'}
          style={{ width: 28, height: 14, borderRadius: 7, background: t.enabled ? color : '#1a1a1a', border: `1px solid ${t.enabled ? color : '#333'}`, cursor: 'pointer', flexShrink: 0, position: 'relative', transition: 'background 0.15s' }}>
          <div style={{ position: 'absolute', top: 2, left: t.enabled ? 15 : 2, width: 8, height: 8, borderRadius: '50%', background: t.enabled ? '#fff' : '#444', transition: 'left 0.15s' }} />
        </div>
        <span style={{ color: t.enabled ? color : '#333', fontSize: 7, fontWeight: 700, flex: 1 }}>{t.name}</span>
        {snap && (
          <span style={{ color: '#444', fontSize: 6, fontFamily: 'monospace' }}>
            {sideLabel(snap.recommendation)[0]}&nbsp;{snap.winVotePct.toFixed(0)}%&nbsp;{snap.consensus.substring(0, 3)}
          </span>
        )}
        <span style={{ color: '#2a2a2a', fontSize: 6, fontFamily: 'monospace' }}>cd:{t.cooldownHands}</span>
        <span style={{ color: t.firedCount > 0 ? color : '#2a2a2a', fontSize: 7 }}>×{t.firedCount}</span>
        <button onClick={() => onDelete(t.id)} style={{ background: 'transparent', border: 'none', color: '#333', fontSize: 9, cursor: 'pointer', padding: 0 }}>✕</button>
      </div>
    );
  }

  return (
    <div style={{ background: '#0a0a0a', border: '1px solid #1a1a1a', borderRadius: 3, padding: '5px 8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ color: '#ff8844', fontSize: 8, fontWeight: 700, letterSpacing: '0.08em' }}>⚡ TRIGGERS</span>
          <span style={{ color: '#333', fontSize: 7 }}>{triggers.filter(t => t.enabled).length}/{triggers.length} active</span>
          {switchSavers.length > 0 && <span style={{ color: '#ff4444', fontSize: 6, background: '#ff444420', padding: '1px 4px', borderRadius: 2 }}>SWITCH:{switchSavers.length}</span>}
          {tieSavers.length > 0 && <span style={{ color: '#44dd88', fontSize: 6, background: '#44dd8820', padding: '1px 4px', borderRadius: 2 }}>TIE:{tieSavers.length}</span>}
          {recentAlerts.length > 0 && <span style={{ color: '#ff8844', fontSize: 7, background: '#ff884422', padding: '1px 5px', borderRadius: 2 }}>{recentAlerts.length} alerts</span>}
        </div>
        <span style={{ color: '#333', fontSize: 9 }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div style={{ marginTop: 8 }}>

          {/* Recent Alerts */}
          {recentAlerts.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ color: '#555', fontSize: 7, marginBottom: 4, letterSpacing: '0.06em' }}>RECENT ALERTS</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {recentAlerts.slice(0, 8).map(a => {
                  const isSw = a.triggerName.startsWith('SWITCH'); const isTie = a.triggerName.startsWith('TIE');
                  const tc = isSw ? '#ff4444' : isTie ? '#44dd88' : a.isAuto ? '#ff8844' : '#44aaff';
                  const tag = isSw ? 'SWITCH' : isTie ? 'TIE' : a.isAuto ? 'AUTO' : 'SAVED';
                  return (
                    <div key={a.id} style={{ display: 'flex', gap: 6, alignItems: 'center', background: '#111', borderRadius: 2, padding: '3px 6px' }}>
                      <span style={{ color: tc, fontSize: 6, fontWeight: 800, background: `${tc}18`, padding: '1px 3px', borderRadius: 2 }}>{tag}</span>
                      <span style={{ color: '#888', fontSize: 7, fontWeight: 700 }}>{a.triggerName}</span>
                      <span style={{ color: '#555', fontSize: 7, flex: 1 }}>{a.message}</span>
                      <span style={{ color: '#333', fontSize: 7 }}>#{a.handNumber}</span>
                      <button onClick={() => onDismissAlert(a.id)} style={{ background: 'transparent', border: 'none', color: '#333', fontSize: 8, cursor: 'pointer', padding: 0 }}>×</button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* System triggers */}
          {systemTriggers.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ color: '#ff8844', fontSize: 7, marginBottom: 4, letterSpacing: '0.06em' }}>SYSTEM TRIGGERS</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {systemTriggers.map(t => <TrigRow key={t.id} t={t} color="#ff8844" />)}
              </div>
            </div>
          )}

          {/* SWITCH Savers */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <div style={{ color: '#ff4444', fontSize: 7, letterSpacing: '0.06em' }}>
                AUTO SWITCH SAVERS ({switchSavers.length}/10)
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ color: autoSaveSwitch ? '#ff4444' : '#333', fontSize: 6, letterSpacing: '0.05em' }}>
                  {autoSaveSwitch ? 'AUTO ON' : 'AUTO OFF'}
                </span>
                <div
                  onClick={onToggleAutoSwitch}
                  title={autoSaveSwitch ? 'Click to stop auto-saving SWITCH patterns' : 'Click to auto-save SWITCH patterns'}
                  style={{
                    width: 28, height: 14, borderRadius: 7, cursor: 'pointer', position: 'relative',
                    background: autoSaveSwitch ? '#ff4444' : '#222', border: `1px solid ${autoSaveSwitch ? '#ff6666' : '#333'}`,
                    transition: 'background 0.2s',
                  }}
                >
                  <div style={{
                    position: 'absolute', top: 2, left: autoSaveSwitch ? 14 : 2,
                    width: 8, height: 8, borderRadius: '50%', background: autoSaveSwitch ? '#fff' : '#555',
                    transition: 'left 0.2s',
                  }} />
                </div>
              </div>
            </div>
            {switchSavers.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {switchSavers.map(t => <TrigRow key={t.id} t={t} color="#ff4444" />)}
              </div>
            )}
          </div>

          {/* TIE Savers */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <div style={{ color: '#44dd88', fontSize: 7, letterSpacing: '0.06em' }}>
                AUTO TIE SAVERS ({tieSavers.length}/10)
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ color: autoSaveTie ? '#44dd88' : '#333', fontSize: 6, letterSpacing: '0.05em' }}>
                  {autoSaveTie ? 'AUTO ON' : 'AUTO OFF'}
                </span>
                <div
                  onClick={onToggleAutoTie}
                  title={autoSaveTie ? 'Click to stop auto-saving TIE patterns' : 'Click to auto-save TIE patterns'}
                  style={{
                    width: 28, height: 14, borderRadius: 7, cursor: 'pointer', position: 'relative',
                    background: autoSaveTie ? '#44dd88' : '#222', border: `1px solid ${autoSaveTie ? '#66ffaa' : '#333'}`,
                    transition: 'background 0.2s',
                  }}
                >
                  <div style={{
                    position: 'absolute', top: 2, left: autoSaveTie ? 14 : 2,
                    width: 8, height: 8, borderRadius: '50%', background: autoSaveTie ? '#fff' : '#555',
                    transition: 'left 0.2s',
                  }} />
                </div>
              </div>
            </div>
            {tieSavers.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {tieSavers.map(t => <TrigRow key={t.id} t={t} color="#44dd88" />)}
              </div>
            )}
          </div>

          {/* Saved triggers */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ color: '#44aaff', fontSize: 7, marginBottom: 4, letterSpacing: '0.06em' }}>SAVED TRIGGERS</div>
            {savedTriggers.length === 0 && <div style={{ color: '#2a2a2a', fontSize: 7, padding: '4px 0' }}>No saved triggers</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {savedTriggers.map(t => <TrigRow key={t.id} t={t} color="#44aaff" />)}
            </div>
          </div>

          {/* Add Trigger Form */}
          <div style={{ borderTop: '1px solid #141414', paddingTop: 8 }}>
            <div style={{ color: '#44aaff', fontSize: 7, marginBottom: 5, letterSpacing: '0.06em' }}>ADD SAVED TRIGGER</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                <select value={newType} onChange={e => setNewType(e.target.value as TriggerType)}
                  style={{ background: '#111', border: '1px solid #222', color: '#888', fontSize: 8, padding: '2px 4px', borderRadius: 2, flex: 1 }}>
                  {TRIGGER_FORM_TYPES.map(t => <option key={t.type} value={t.type}>{t.label}</option>)}
                </select>
                <input placeholder="Name (optional)" value={newName} onChange={e => setNewName(e.target.value)}
                  style={{ background: '#111', border: '1px solid #222', color: '#888', fontSize: 8, padding: '2px 4px', borderRadius: 2, flex: 1, fontFamily: 'inherit' }} />
              </div>

              {/* DECISION MATCH fields */}
              {newType === 'DECISION_MATCH' && (
                <div style={{ background: '#0d0d0d', border: '1px solid #1d1d1d', borderRadius: 3, padding: '8px' }}>
                  <div style={{ color: '#444', fontSize: 7, marginBottom: 6, letterSpacing: '0.06em' }}>MATCH CONDITIONS (leave blank = skip check)</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 6 }}>
                    <div>
                      <div style={{ color: '#333', fontSize: 6, marginBottom: 2 }}>finalRecommendation</div>
                      <select value={dmFinalRec} onChange={e => setDmFinalRec(e.target.value as AIVote | 'ANY')}
                        style={{ background: '#111', border: '1px solid #222', color: '#888', fontSize: 7, padding: '2px 4px', borderRadius: 2, width: '100%' }}>
                        {VOTES.map(v => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </div>
                    <div>
                      <div style={{ color: '#333', fontSize: 6, marginBottom: 2 }}>highestVote</div>
                      <select value={dmHighVote} onChange={e => setDmHighVote(e.target.value as AIVote | 'ANY')}
                        style={{ background: '#111', border: '1px solid #222', color: '#888', fontSize: 7, padding: '2px 4px', borderRadius: 2, width: '100%' }}>
                        {VOTES.map(v => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </div>
                    <div>
                      <div style={{ color: '#333', fontSize: 6, marginBottom: 2 }}>consensus</div>
                      <select value={dmConsensus} onChange={e => setDmConsensus(e.target.value as ConsensusLevel | 'ANY')}
                        style={{ background: '#111', border: '1px solid #222', color: '#888', fontSize: 7, padding: '2px 4px', borderRadius: 2, width: '100%' }}>
                        {CONSENSUS_OPTS.map(v => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, marginBottom: 6 }}>
                    <NumField label="banker" field={dmBanker} onChange={setDmBanker} />
                    <NumField label="player" field={dmPlayer} onChange={setDmPlayer} />
                    <NumField label="tie" field={dmTie} onChange={setDmTie} />
                    <NumField label="noVote" field={dmNoVote} onChange={setDmNoVote} />
                    <NumField label="agree" field={dmAgree} onChange={setDmAgree} />
                    <NumField label="winVote %" field={dmWinVote} onChange={setDmWinVote} />
                  </div>
                  <NumField label="ensemble %" field={dmEnsemble} onChange={setDmEnsemble} />
                </div>
              )}

              {(newType === 'BANKER_STREAK' || newType === 'PLAYER_STREAK') && (
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={{ color: '#444', fontSize: 7 }}>Streak:</span>
                  {[2, 3, 4, 5].map(n => (
                    <button key={n} onClick={() => setNewStreak(n)} style={{ background: newStreak === n ? '#223344' : 'transparent', border: `1px solid ${newStreak === n ? '#4488ff' : '#222'}`, color: newStreak === n ? '#4488ff' : '#444', fontSize: 8, padding: '1px 5px', borderRadius: 2, cursor: 'pointer' }}>{n}</button>
                  ))}
                </div>
              )}
              {newType === 'HOT_AI_COUNT' && (
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={{ color: '#444', fontSize: 7 }}>Min HOT:</span>
                  {[2, 3, 4, 5, 6].map(n => (
                    <button key={n} onClick={() => setNewCount(n)} style={{ background: newCount === n ? '#332200' : 'transparent', border: `1px solid ${newCount === n ? '#ff8844' : '#222'}`, color: newCount === n ? '#ff8844' : '#444', fontSize: 8, padding: '1px 5px', borderRadius: 2, cursor: 'pointer' }}>{n}</button>
                  ))}
                </div>
              )}
              {newType === 'CONSENSUS_LEVEL' && (
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ color: '#444', fontSize: 7 }}>Min level:</span>
                  {(['WEAK', 'MEDIUM', 'STRONG', 'VERY_STRONG'] as ConsensusLevel[]).map(lvl => (
                    <button key={lvl} onClick={() => setNewConsensus(lvl)} style={{ background: newConsensus === lvl ? '#0a1a0a' : 'transparent', border: `1px solid ${newConsensus === lvl ? '#44dd88' : '#222'}`, color: newConsensus === lvl ? '#44dd88' : '#444', fontSize: 7, padding: '1px 4px', borderRadius: 2, cursor: 'pointer' }}>{lvl}</button>
                  ))}
                </div>
              )}
              {newType === 'SIDE_BIAS' && (
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={{ color: '#444', fontSize: 7 }}>Bias %:</span>
                  {[55, 60, 65, 70].map(n => (
                    <button key={n} onClick={() => setNewBias(n)} style={{ background: newBias === n ? '#110022' : 'transparent', border: `1px solid ${newBias === n ? '#aa44ff' : '#222'}`, color: newBias === n ? '#aa44ff' : '#444', fontSize: 8, padding: '1px 5px', borderRadius: 2, cursor: 'pointer' }}>{n}%</button>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <span style={{ color: '#444', fontSize: 7 }}>Cooldown:</span>
                {[1, 2, 3, 5, 8].map(n => (
                  <button key={n} onClick={() => setNewCooldown(n)} style={{ background: newCooldown === n ? '#0d0d1a' : 'transparent', border: `1px solid ${newCooldown === n ? '#4488ff' : '#222'}`, color: newCooldown === n ? '#4488ff' : '#444', fontSize: 8, padding: '1px 5px', borderRadius: 2, cursor: 'pointer' }}>{n}</button>
                ))}
              </div>

              <button onClick={handleAdd} style={{ background: '#0d1a2a', border: '1px solid #4488ff44', color: '#4488ff', fontSize: 8, padding: '3px 8px', borderRadius: 2, cursor: 'pointer', fontFamily: 'inherit', alignSelf: 'flex-start' }}>
                + ADD TRIGGER
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [state, setState] = useState<AppState>(() => buildInitialState(loadState()));
  const [editingBase, setEditingBase] = useState(false);
  const [baseInput, setBaseInput] = useState('');
  const [editingSide, setEditingSide] = useState(false);
  const [sideInput, setSideInput] = useState('');
  const [clearConfirm, setClearConfirm] = useState(false);
  const [visibleAlerts, setVisibleAlerts] = useState<TriggerAlert[]>([]);
  const [pendingPairFlags, setPendingPairFlags] = useState<PairFlags>('none');
  const [pendingNatural, setPendingNatural] = useState(false);

  // ── Proper undo stack: stores COMPLETE state snapshots ──────────────────
  const undoStack = useRef<AppState[]>([]);

  function pushUndo(s: AppState) {
    undoStack.current = [...undoStack.current, s].slice(-8);
  }

  useEffect(() => { saveState(state); }, [state]);

  // Show newly fired alerts as toasts
  const prevAlertsRef = useRef<TriggerAlert[]>([]);
  useEffect(() => {
    const prev = prevAlertsRef.current;
    const newOnes = state.triggerAlerts.filter(a => !prev.find(p => p.id === a.id));
    if (newOnes.length > 0) setVisibleAlerts(v => [...newOnes, ...v].slice(0, 5));
    prevAlertsRef.current = state.triggerAlerts;
  }, [state.triggerAlerts]);

  const { activeShoe, shoeNumber, archivedShoes, voters, finalDecision, globalShoeState, performance, highestVotePerf, pnl, triggers, triggerAlerts, autoSaveSwitch, autoSaveTie } = state;
  const dec = finalDecision;
  const pnlColor = pnl.totalPnL >= 0 ? '#44dd88' : '#ff4444';
  const sesColor = pnl.sessionPnL >= 0 ? '#44dd88' : '#ff4444';

  // ── Add Hand ───────────────────────────────────────────────────────────────
  const addHand = useCallback((side: Side, number: number, pairFlags: PairFlags = 'none', naturalFlag = false) => {
    setState(prev => {
      // Save COMPLETE state before change — full undo restores everything
      pushUndo(prev);

      const newHand: HandResult = { side, number, sideNumber: `${number}${side}`, id: `${Date.now()}-${Math.random()}`, pairFlags, naturalFlag };
      const newActiveShoe = [...prev.activeShoe, newHand];
      const handIndex = newActiveShoe.length;

      let updatedVoters = prev.voters;
      let updatedPerf = { ...prev.performance };
      let updatedHVPerf = { ...prev.highestVotePerf };
      let updatedPnL = { ...prev.pnl };
      let updatedMem: AIStateKeyMemory = prev.aiStateKeyMemory;
      let extraTriggers: Trigger[] = [];

      if (prev.pendingDecision) {
        const pd = prev.pendingDecision;
        updatedVoters = updateVoterStats(prev.voters, side);
        for (const v of prev.voters) {
          if (v.vote !== 'NO_VOTE' && v.stateKey && v.stateKey !== 'ND') {
            updatedMem = recordStateKeyOutcome(updatedMem, v.id, v.stateKey, v.vote, side, handIndex);
          }
        }

        // Performance update
        const rec = pd.recommendation;
        if (rec === 'NO_VOTE') { updatedPerf.skipped++; }
        else { updatedPerf = updatePerfWithResult(updatedPerf, rec, side, side === 'T' && rec !== 'T', false); }

        const hv = pd.highestVote;
        if (hv === 'NO_VOTE') {
          updatedHVPerf.skipped++;
          updatedPnL = { ...updatedPnL, lastBetSide: '', lastBetResult: 'SKIPPED', lastBetAmount: 0, lastMultiplier: 1, lastFinalConfirmed: false };
        } else {
          const hvPush = side === 'T' && hv !== 'T';
          updatedHVPerf = updatePerfWithResult(updatedHVPerf, hv, side, hvPush, false);
          const finalAgrees = rec !== 'NO_VOTE' && rec === hv;
          const { baseBet, sideBet } = prev.pnl;
          // sideBet is the TIE side-bet — always wins ×8 when actual TIE, always lost otherwise
          updatedPnL = { ...updatedPnL, lastBetSide: hv, lastMultiplier: finalAgrees ? 2 : 1, lastFinalConfirmed: finalAgrees };

          if (side === 'T') {
            // TIE hit → TIE side-bet pays ×8; main bet pushes (unless AI voted T)
            const tieSideWin = sideBet * 8;
            if (hv === 'T') {
              // AI bet on TIE and TIE hit → both TIE bet and main bet win
              const mainWin = baseBet * 8;
              const total = tieSideWin + mainWin;
              updatedPnL = { ...updatedPnL, totalPnL: updatedPnL.totalPnL + total, sessionPnL: updatedPnL.sessionPnL + total, lastBetResult: 'WIN', lastBetAmount: total };
            } else {
              // Main bet pushes (B/P), TIE side-bet wins ×8
              updatedPnL = { ...updatedPnL, totalPnL: updatedPnL.totalPnL + tieSideWin, sessionPnL: updatedPnL.sessionPnL + tieSideWin, lastBetResult: 'TIE WIN', lastBetAmount: tieSideWin };
            }
          } else {
            // No TIE — TIE side-bet always lost; resolve main bet normally
            const tieSideLoss = sideBet;
            if (hv === side) {
              const baseWin = hv === 'B' ? baseBet * 0.95 : baseBet;
              const mainWin = finalAgrees ? baseWin * 1 : baseWin;
              const net = mainWin - tieSideLoss;
              updatedPnL = { ...updatedPnL, totalPnL: updatedPnL.totalPnL + net, sessionPnL: updatedPnL.sessionPnL + net, lastBetResult: net >= 0 ? 'WIN' : 'LOSS', lastBetAmount: net };
            } else {
              const loss = (finalAgrees ? baseBet * 1 : baseBet) + tieSideLoss;
              updatedPnL = { ...updatedPnL, totalPnL: updatedPnL.totalPnL - loss, sessionPnL: updatedPnL.sessionPnL - loss, lastBetResult: 'LOSS', lastBetAmount: -loss };
            }
          }
        }

        // ── SWITCH SAVER (req #11): prediction was B/P but actual was opposite ──
        const predBP = pd.recommendation !== 'NO_VOTE' && pd.recommendation !== 'T';
        const actualSwitched = predBP && side !== pd.recommendation && side !== 'T';
        if (actualSwitched && prev.autoSaveSwitch) {
          const existingCount = prev.triggers.filter(t => t.condition.type === 'SWITCH_SAVER').length;
          if (existingCount < 10) {
            extraTriggers.push({
              id: `switch-${Date.now()}`,
              name: `SWITCH #${existingCount + 1}`,
              condition: { type: 'SWITCH_SAVER', savedSnapshot: { ...pd } },
              enabled: true, isAuto: false,
              firedCount: 0, lastFiredHand: -99, cooldownHands: 1,
            });
          }
        }

        // ── TIE SAVER (req #12): actual was TIE ──
        if (side === 'T' && prev.autoSaveTie) {
          const existingTieCount = prev.triggers.filter(t => t.condition.type === 'TIE_SAVER').length;
          if (existingTieCount < 10) {
            extraTriggers.push({
              id: `tie-${Date.now()}`,
              name: `TIE #${existingTieCount + 1}`,
              condition: { type: 'TIE_SAVER', savedSnapshot: { ...pd } },
              enabled: true, isAuto: false,
              firedCount: 0, lastFiredHand: -99, cooldownHands: 1,
            });
          }
        }
      }

      const { voters: newVoters, decision: newDecision, globalShoeState: newGSS } = runVoters(
        newActiveShoe, prev.archivedShoes, updatedVoters, updatedMem
      );

      const allTriggers = [...prev.triggers, ...extraTriggers];
      const { newAlerts, updatedTriggers } = checkTriggers(allTriggers, newActiveShoe, newVoters, newDecision, prev.triggerAlerts);
      const updatedAlerts = newAlerts.length > 0 ? [...newAlerts, ...prev.triggerAlerts].slice(0, 50) : prev.triggerAlerts;

      return {
        ...prev,
        activeShoe: newActiveShoe, voters: newVoters,
        aiStateKeyMemory: updatedMem,
        finalDecision: newDecision, globalShoeState: newGSS,
        pendingDecision: newDecision,
        performance: updatedPerf, highestVotePerf: updatedHVPerf,
        pnl: updatedPnL, triggers: updatedTriggers, triggerAlerts: updatedAlerts,
      };
    });
  }, []);

  // ── Undo — restores ALL data from stack ────────────────────────────────────
  const undoLast = useCallback(() => {
    const stack = undoStack.current;
    if (stack.length > 0) {
      const prevState = stack[stack.length - 1];
      undoStack.current = stack.slice(0, -1);
      setState(prevState);
    }
  }, []);

  // ── Remove Hand ────────────────────────────────────────────────────────────
  const removeHand = useCallback((id: string) => {
    setState(prev => {
      pushUndo(prev);
      const newShoe = prev.activeShoe.filter(h => h.id !== id);
      const { voters: nv, decision: nd, globalShoeState: ng } = runVoters(newShoe, prev.archivedShoes, prev.voters, prev.aiStateKeyMemory);
      return { ...prev, activeShoe: newShoe, voters: nv, finalDecision: nd, globalShoeState: ng, pendingDecision: nd };
    });
  }, []);

  // ── New Shoe ───────────────────────────────────────────────────────────────
  const newShoe = useCallback(() => {
    setState(prev => {
      const total = prev.activeShoe.length;
      let newArchivedShoes = prev.archivedShoes;
      if (total > 0) {
        const bC = prev.activeShoe.filter(h => h.side === 'B').length;
        const pC = prev.activeShoe.filter(h => h.side === 'P').length;
        const tC = prev.activeShoe.filter(h => h.side === 'T').length;
        newArchivedShoes = [{ id: Date.now(), hands: prev.activeShoe, bankerPct: Math.round(bC / total * 100), playerPct: Math.round(pC / total * 100), tiePct: Math.round(tC / total * 100), totalHands: total, timestamp: Date.now() }, ...prev.archivedShoes].slice(0, 20);
      }
      const archivedVoters = archiveVoters(prev.voters);
      const { voters: nv, decision: nd, globalShoeState: ng } = runVoters([], newArchivedShoes, archivedVoters, prev.aiStateKeyMemory);
      return {
        ...prev, activeShoe: [], shoeNumber: prev.shoeNumber + 1,
        archivedShoes: newArchivedShoes, voters: nv, finalDecision: nd, globalShoeState: ng,
        pendingDecision: null, performance: makeInitialPerf(), highestVotePerf: makeInitialPerf(),
        pnl: { ...prev.pnl, sessionPnL: 0, lastBetSide: '', lastBetResult: '', lastBetAmount: 0, lastMultiplier: 1, lastFinalConfirmed: false },
        triggers: prev.triggers.map(t => ({ ...t, lastFiredHand: -99 })),
      };
    });
    undoStack.current = [];
  }, []);

  // ── Archive Shoe ───────────────────────────────────────────────────────────
  const archiveShoe = useCallback(() => {
    setState(prev => {
      if (prev.activeShoe.length === 0) return prev;
      const total = prev.activeShoe.length;
      const bC = prev.activeShoe.filter(h => h.side === 'B').length;
      const pC = prev.activeShoe.filter(h => h.side === 'P').length;
      const tC = prev.activeShoe.filter(h => h.side === 'T').length;
      return { ...prev, archivedShoes: [{ id: Date.now(), hands: prev.activeShoe, bankerPct: Math.round(bC / total * 100), playerPct: Math.round(pC / total * 100), tiePct: Math.round(tC / total * 100), totalHands: total, timestamp: Date.now() }, ...prev.archivedShoes].slice(0, 20) };
    });
  }, []);

  const deleteArchivedShoe = useCallback((id: number) => {
    setState(prev => ({ ...prev, archivedShoes: prev.archivedShoes.filter(s => s.id !== id) }));
  }, []);

  const clearAllMemory = useCallback(() => {
    setState(prev => ({ ...prev, archivedShoes: [], voters: initVoters(), aiStateKeyMemory: {}, finalDecision: makeInitialDecision(), globalShoeState: makeEmptyGSS(), pendingDecision: null, triggerAlerts: [] }));
    setClearConfirm(false);
    undoStack.current = [];
    setVisibleAlerts([]);
  }, []);

  const toggleTrigger = useCallback((id: string) => {
    setState(prev => ({ ...prev, triggers: prev.triggers.map(t => t.id === id ? { ...t, enabled: !t.enabled } : t) }));
  }, []);

  const deleteTrigger = useCallback((id: string) => {
    setState(prev => ({ ...prev, triggers: prev.triggers.filter(t => t.id !== id) }));
  }, []);

  const addTrigger = useCallback((trigger: Trigger) => {
    setState(prev => ({ ...prev, triggers: [...prev.triggers, trigger] }));
  }, []);

  const dismissAlert = useCallback((id: string) => {
    setState(prev => ({ ...prev, triggerAlerts: prev.triggerAlerts.filter(a => a.id !== id) }));
    setVisibleAlerts(v => v.filter(a => a.id !== id));
  }, []);

  const toggleAutoSwitch = useCallback(() => {
    setState(prev => ({ ...prev, autoSaveSwitch: !prev.autoSaveSwitch }));
  }, []);

  const toggleAutoTie = useCallback(() => {
    setState(prev => ({ ...prev, autoSaveTie: !prev.autoSaveTie }));
  }, []);

  const dismissToast = useCallback((id: string) => {
    setVisibleAlerts(v => v.filter(a => a.id !== id));
  }, []);

  useEffect(() => {
    if (visibleAlerts.length === 0) return;
    const t = setTimeout(() => setVisibleAlerts(v => v.slice(0, -1)), 6000);
    return () => clearTimeout(t);
  }, [visibleAlerts]);

  // ── Input rows ─────────────────────────────────────────────────────────────
  function btnRow(side: Side, nums: number[], color: string) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: 3 }}>
        <span style={{ color, fontSize: 10, fontWeight: 700, width: 10, flexShrink: 0 }}>{side}</span>
        <div style={{ display: 'flex', gap: 2 }}>
          {nums.map(n => (
            <button key={n} onClick={() => {
              addHand(side, n, side !== 'T' ? pendingPairFlags : 'none', side !== 'T' && pendingNatural);
              setPendingPairFlags('none');
              setPendingNatural(false);
            }} style={{ background: 'transparent', border: `1px solid ${color}33`, color, width: 22, height: 20, borderRadius: 2, fontSize: 9, fontWeight: 700, cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}
              onMouseEnter={e => { (e.target as HTMLButtonElement).style.background = `${color}22`; }}
              onMouseLeave={e => { (e.target as HTMLButtonElement).style.background = 'transparent'; }}
            >{n}</button>
          ))}
        </div>
      </div>
    );
  }

  const hotVoters = voters.filter(v => v.voteType === 'HOT_ACTIVE' || v.voteType === 'HOT');
  const activeVoters = voters.filter(v => v.vote !== 'NO_VOTE');
  const canUndo = undoStack.current.length > 0;

  const analysisReport = runFullAnalysis(
    activeShoe,
    archivedShoes,
    finalDecision.agreementCount,
    finalDecision.recommendation,
    voters.map(v => ({ id: v.id, allTimeCorrect: v.allTimeCorrect, allTimeWrong: v.allTimeWrong })),
  );
  const truthGate = analysisReport.truthGate;

  return (
    <div style={{ minHeight: '100vh', background: '#060606', padding: '8px 12px' }}>

      <TriggerAlertToast alerts={visibleAlerts} onDismiss={dismissToast} />

      <div style={{ maxWidth: 900, display: 'flex', flexDirection: 'column', gap: 4 }}>

        {/* ── INPUT + SHOE HISTORY ──────────────────────────────────────── */}
        <div style={{ background: '#0a0a0a', border: '1px solid #1a1a1a', borderRadius: 3, padding: '6px 8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
            <div>
              <div style={{ color: '#44dd88', fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 4 }}>■ INPUT</div>
              {btnRow('B', [1, 2, 3, 4, 5, 6, 7, 8, 9], '#ff4444')}
              {btnRow('P', [1, 2, 3, 4, 5, 6, 7, 8, 9], '#4488ff')}
              {btnRow('T', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], '#44dd88')}
              {/* ── Pair / Natural flags ── */}
              <div style={{ display: 'flex', gap: 4, marginTop: 4, alignItems: 'center' }}>
                <span style={{ color: '#333', fontSize: 6.5, fontWeight: 700, letterSpacing: '0.06em' }}>NEXT:</span>
                {(['banker_pair', 'player_pair'] as PairFlags[]).map(flag => {
                  const active = pendingPairFlags === flag;
                  const col = flag === 'banker_pair' ? '#ff4444' : '#4488ff';
                  const label = flag === 'banker_pair' ? 'B-PAIR' : 'P-PAIR';
                  return (
                    <button key={flag} onClick={() => setPendingPairFlags(f => f === flag ? 'none' : flag)}
                      style={{ background: active ? `${col}22` : 'transparent', border: `1px solid ${active ? col : '#2a2a2a'}`, color: active ? col : '#444', fontSize: 6.5, padding: '1px 5px', borderRadius: 2, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700 }}>
                      {label}
                    </button>
                  );
                })}
                <button onClick={() => setPendingNatural(n => !n)}
                  style={{ background: pendingNatural ? '#ddcc4422' : 'transparent', border: `1px solid ${pendingNatural ? '#ddcc44' : '#2a2a2a'}`, color: pendingNatural ? '#ddcc44' : '#444', fontSize: 6.5, padding: '1px 5px', borderRadius: 2, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700 }}>
                  NATURAL
                </button>
                {(pendingPairFlags !== 'none' || pendingNatural) && (
                  <span style={{ color: '#ffaa44', fontSize: 6, marginLeft: 2 }}>
                    {[pendingPairFlags !== 'none' ? (pendingPairFlags === 'banker_pair' ? 'B♦' : 'P♦') : '', pendingNatural ? 'N' : ''].filter(Boolean).join(' ')}
                  </span>
                )}
              </div>
            </div>
            <button onClick={undoLast} disabled={!canUndo} style={{ background: canUndo ? '#0d1a0d' : 'transparent', border: `1px solid ${canUndo ? '#44aa4466' : '#1a1a1a'}`, color: canUndo ? '#44aa44' : '#2a2a2a', fontSize: 8, padding: '3px 6px', borderRadius: 2, cursor: canUndo ? 'pointer' : 'default', fontFamily: 'inherit' }} title={`Undo (${undoStack.current.length} steps)`}>
              ↩ UNDO {undoStack.current.length > 0 ? `(${undoStack.current.length})` : ''}
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 5 }}>
            <span style={{ color: '#444', fontSize: 8 }}>Shoe #{shoeNumber}</span>
            <span style={{ color: '#333', fontSize: 7 }}>· {activeShoe.length} hands</span>
            <div style={{ flex: 1 }} />
            <button onClick={archiveShoe} style={{ background: '#111', border: '1px solid #222', color: '#777', fontSize: 8, padding: '2px 7px', borderRadius: 2, cursor: 'pointer', fontFamily: 'inherit' }}>ARCHIVE</button>
            <button onClick={newShoe} style={{ background: '#0d2244', border: '1px solid #1a4488', color: '#6699dd', fontSize: 8, padding: '2px 7px', borderRadius: 2, cursor: 'pointer', fontFamily: 'inherit' }}>⊕ NEW SHOE</button>
          </div>
          <div style={{ marginBottom: 3 }}>
            <span style={{ color: '#44dd88', fontSize: 8, fontWeight: 700, letterSpacing: '0.08em' }}>■ SHOE HISTORY</span>
          </div>
          <div style={{ height: 148 }}><ShoeHistoryGrid hands={activeShoe} onRemove={removeHand} /></div>
        </div>

        {/* ── BACCARAT SCOREBOARDS ──────────────────────────────────────── */}
        <ScoreboardsPanel hands={activeShoe} />

        {/* ── GLOBAL SHOE STATE (20 AI Consensus) ─────────────────────── */}
        <GlobalShoeStatePanel gss={globalShoeState} />

        {/* ── INTELLIGENCE REPORT ───────────────────────────────────────── */}
        <AnalysisIntelligencePanel report={analysisReport} hands={activeShoe} />

        {/* ── TRUTH GATE DECISION ───────────────────────────────────────── */}
        {(() => {
          const tg = truthGate;
          const verdictColor =
            tg.finalVerdict === 'BANKER' ? '#ff4444' :
            tg.finalVerdict === 'PLAYER' ? '#4488ff' :
            tg.finalVerdict === 'TIE'    ? '#44dd88' :
            tg.finalVerdict === 'SKIP'   ? '#ff8844' : '#444';
          const verdictLabel =
            tg.finalVerdict === 'SKIP' ? 'SKIP' :
            tg.finalVerdict === 'NO_BET' ? 'NO BET' : tg.finalVerdict;
          const isOverridden = tg.finalVerdict !== (
            tg.rawEnsembleVote === 'B' ? 'BANKER' :
            tg.rawEnsembleVote === 'P' ? 'PLAYER' :
            tg.rawEnsembleVote === 'T' ? 'TIE' : 'NO_BET'
          );
          const triggered = tg.conditions.filter(c => c.triggered);
          return (
            <div style={{ background: '#080808', border: `1px solid ${isOverridden ? '#ff884422' : '#1a1a1a'}`, borderRadius: 3, overflow: 'hidden' }}>
              {/* ── HEADER: TRUTH GATE label ── */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px', borderBottom: '1px solid #111', background: '#0a0a0a' }}>
                <span style={{ color: '#ff8844', fontSize: 7, fontWeight: 700, letterSpacing: '0.09em' }}>■ TRUTH GATE</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  {tg.priorityPath.map(p => (
                    <span key={p} style={{ color: '#333', fontSize: 5.5, background: '#111', padding: '1px 4px', borderRadius: 1 }}>{p}</span>
                  ))}
                </div>
              </div>
              {/* ── MAIN: authoritative verdict ── */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ color: '#444', fontSize: 6, letterSpacing: '0.08em', marginBottom: 2 }}>
                    {isOverridden ? 'OVERRIDE VERDICT' : 'AUTHORISED VERDICT'}
                  </div>
                  <div style={{ color: verdictColor, fontSize: 26, fontWeight: 900, letterSpacing: '0.04em', lineHeight: 1 }}>
                    {verdictLabel}
                  </div>
                  {tg.fakeConsensus && (
                    <div style={{ color: '#ff8844', fontSize: 7, fontWeight: 700, marginTop: 2 }}>
                      FAKE CONSENSUS DETECTED
                    </div>
                  )}
                  {tg.roadInvalidated && (
                    <div style={{ color: '#ff4444', fontSize: 7, fontWeight: 700, marginTop: 2 }}>
                      ROAD PREDICTIONS INVALIDATED
                    </div>
                  )}
                </div>
                {/* raw ensemble (de-emphasized if overridden) */}
                <div style={{ textAlign: 'center', opacity: isOverridden ? 0.35 : 0.7 }}>
                  <div style={{ color: '#555', fontSize: 6, marginBottom: 1 }}>ENSEMBLE</div>
                  <div style={{ color: tg.rawEnsembleVote === 'B' ? '#ff4444' : tg.rawEnsembleVote === 'P' ? '#4488ff' : '#333', fontSize: 11, fontWeight: 800, textDecoration: isOverridden ? 'line-through' : 'none' }}>
                    {tg.rawEnsembleVote === 'B' ? 'BANKER' : tg.rawEnsembleVote === 'P' ? 'PLAYER' : tg.rawEnsembleVote === 'T' ? 'TIE' : 'NO VOTE'}
                  </div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ color: '#888', fontSize: 14, fontWeight: 800 }}>{dec.winVotePct.toFixed(0)}%</div>
                  <div style={{ color: '#333', fontSize: 7 }}>WIN VOTE</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ color: consensusColor(dec.consensus), fontSize: 9, fontWeight: 700 }}>{dec.consensus}</div>
                  <div style={{ color: '#333', fontSize: 7 }}>CONSENSUS</div>
                </div>
              </div>
              {/* ── override reason ── */}
              {tg.overrideReason && (
                <div style={{ padding: '3px 8px', background: '#0c0c0c', borderTop: '1px solid #111' }}>
                  <div style={{ color: isOverridden ? '#ff8844' : '#333', fontSize: 6, fontStyle: 'italic' }}>{tg.overrideReason}</div>
                </div>
              )}
              {/* ── triggered conditions ── */}
              {triggered.length > 0 && (
                <div style={{ padding: '4px 8px', borderTop: '1px solid #111', display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ color: '#444', fontSize: 5.5, letterSpacing: '0.07em', marginBottom: 1 }}>TRIGGERED CONDITIONS</div>
                  {triggered.map(c => (
                    <div key={c.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                      <span style={{ color: '#ff4444', fontSize: 6, fontWeight: 700, minWidth: 14 }}>P{c.priority}</span>
                      <span style={{ color: '#ff8844', fontSize: 6, fontWeight: 700, minWidth: 80 }}>{c.label}</span>
                      <span style={{ color: '#ff4444', fontSize: 5.5, background: '#ff222215', padding: '0px 4px', borderRadius: 1 }}>{c.triggeredLabel}</span>
                      <span style={{ color: '#333', fontSize: 5.5, flex: 1, fontStyle: 'italic' }}>{c.detail}</span>
                    </div>
                  ))}
                </div>
              )}
              {/* ── disabled voter summary ── */}
              {tg.disabledVoterIds.length > 0 && (
                <div style={{ padding: '3px 8px', background: '#0c0c0c', borderTop: '1px solid #111' }}>
                  <span style={{ color: '#ff3333', fontSize: 6, fontWeight: 700 }}>{tg.disabledVoterIds.length} MODEL(S) DISABLED: </span>
                  <span style={{ color: '#444', fontSize: 6 }}>{tg.disabledVoterIds.map(id => id.toUpperCase()).join(' · ')}</span>
                </div>
              )}
              {/* ── raw vote breakdown ── */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 8px', borderTop: '1px solid #111' }}>
                {[
                  { v: dec.bankerVotes.toFixed(1), l: 'BANKER',   c: '#ff4444' },
                  { v: dec.playerVotes.toFixed(1), l: 'PLAYER',   c: '#4488ff' },
                  { v: dec.tieVotes.toFixed(1),    l: 'TIE',      c: '#44dd88' },
                  { v: String(dec.noVoteCount),     l: 'NO VOTE',  c: '#444'    },
                  { v: `${dec.agreementCount}/50`,  l: 'AGREE',    c: '#666'    },
                ].map(({ v, l, c }) => (
                  <div key={l} style={{ textAlign: 'center' }}>
                    <div style={{ color: c, fontSize: 11, fontWeight: 700 }}>{v}</div>
                    <div style={{ color: '#333', fontSize: 7 }}>{l}</div>
                  </div>
                ))}
                <div style={{ flex: 1 }} />
                <div style={{ textAlign: 'right' }}>
                  <div style={{ color: '#555', fontSize: 7 }}>HIGHEST VOTE</div>
                  <div style={{ color: dec.highestVote === 'NO_VOTE' ? '#333' : sideColor(dec.highestVote), fontSize: 13, fontWeight: 800 }}>
                    {dec.highestVote === 'NO_VOTE' ? '—' : sideLabel(dec.highestVote)}
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── HOT AIs BANNER ────────────────────────────────────────────── */}
        {hotVoters.length > 0 && (
          <div style={{ background: '#110800', border: '1px solid #ff440022', borderRadius: 3, padding: '4px 8px' }}>
            <div style={{ color: '#ff8844', fontSize: 7, fontWeight: 700, marginBottom: 3 }}>🔥 HOT AIs ({hotVoters.length})</div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {hotVoters.map(v => (
                <span key={v.id} style={{ color: v.voteType === 'HOT_ACTIVE' ? '#ff2244' : '#ff8844', fontSize: 7, background: '#ff44441a', padding: '1px 4px', borderRadius: 2 }}>
                  {v.shortTag} → {sideLabel(v.vote)[0]} ({v.confidence}%)
                </span>
              ))}
            </div>
          </div>
        )}

        {/* ── PERFORMANCE PANELS ────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 4 }}>
          <PerfPanel title="FINAL RESULT"  subtitle="Filtered · Includes NO BET logic" perf={performance}    accentColor="#ffaa44" />
          <PerfPanel title="HIGHEST VOTE" subtitle="Raw · Ignores NO BET filter"     perf={highestVotePerf} accentColor="#44aaff" />
        </div>

        {/* ── P&L ───────────────────────────────────────────────────────── */}
        {(() => {
          const totalRisk = pnl.baseBet + pnl.sideBet;
          const lastColor = pnl.lastBetResult === 'WIN' ? '#44dd88' : pnl.lastBetResult === 'LOSS' ? '#ff4444' : pnl.lastBetResult === 'PUSH' ? '#ddcc44' : '#555';
          function EditField({ label, value, editing, input, onEdit, onInput, onSave }: { label: string; value: number; editing: boolean; input: string; onEdit: () => void; onInput: (v: string) => void; onSave: (v: number) => void; }) {
            return (
              <div style={{ textAlign: 'center' }}>
                {editing ? (
                  <input autoFocus value={input} onChange={e => onInput(e.target.value)} onBlur={() => { const v = parseInt(input); if (!isNaN(v) && v >= 0) onSave(v); }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    style={{ background: '#181818', border: '1px solid #444', color: '#fff', fontSize: 10, width: 60, padding: '1px 4px', borderRadius: 2, fontFamily: 'inherit', textAlign: 'center' }} />
                ) : (
                  <div onClick={onEdit} style={{ color: '#88aaff', fontSize: 12, fontWeight: 700, cursor: 'pointer', textDecoration: 'underline dotted', lineHeight: 1 }}>₱{value.toLocaleString()}</div>
                )}
                <div style={{ color: '#444', fontSize: 7, marginTop: 1 }}>{label}</div>
              </div>
            );
          }
          return (
            <div style={{ background: '#0a0a0a', border: '1px solid #1a1a1a', borderRadius: 3, padding: '5px 8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                <span style={{ color: '#555', fontSize: 8, fontWeight: 700, letterSpacing: '0.08em' }}>P & L</span>
                <span style={{ color: '#44dd88', fontSize: 7, background: '#44dd8815', padding: '1px 5px', borderRadius: 2 }}>TIE BET pays ×8</span>
              </div>
              <div style={{ display: 'flex', gap: 10, marginBottom: 5, alignItems: 'center' }}>
                <EditField label="BASE BET" value={pnl.baseBet} editing={editingBase} input={baseInput}
                  onEdit={() => { setEditingBase(true); setBaseInput(String(pnl.baseBet)); }}
                  onInput={setBaseInput}
                  onSave={v => { setState(p => ({ ...p, pnl: { ...p.pnl, baseBet: v } })); setEditingBase(false); }} />
                <div style={{ color: '#2a2a2a', fontSize: 12 }}>+</div>
                <EditField label="TIE BET (×8)" value={pnl.sideBet} editing={editingSide} input={sideInput}
                  onEdit={() => { setEditingSide(true); setSideInput(String(pnl.sideBet)); }}
                  onInput={setSideInput}
                  onSave={v => { setState(p => ({ ...p, pnl: { ...p.pnl, sideBet: v } })); setEditingSide(false); }} />
                <div style={{ color: '#2a2a2a', fontSize: 12 }}>=</div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ color: '#888', fontSize: 12, fontWeight: 700, lineHeight: 1 }}>₱{totalRisk.toLocaleString()}</div>
                  <div style={{ color: '#444', fontSize: 7, marginTop: 1 }}>TOTAL RISK</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 12, paddingTop: 4, paddingBottom: 5, borderTop: '1px solid #141414', borderBottom: '1px solid #141414', marginBottom: 5, alignItems: 'flex-end' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <div style={{ color: pnlColor, fontSize: 15, fontWeight: 800, lineHeight: 1 }}>₱{pnl.totalPnL >= 0 ? '+' : ''}{pnl.totalPnL.toFixed(0)}</div>
                    <button onClick={() => setState(p => ({ ...p, pnl: { ...p.pnl, totalPnL: 0 } }))} style={{ background: 'transparent', border: '1px solid #2a2a2a', color: '#444', fontSize: 7, padding: '1px 4px', borderRadius: 2, cursor: 'pointer', fontFamily: 'inherit' }}>RESET</button>
                  </div>
                  <div style={{ color: '#444', fontSize: 7, marginTop: 1 }}>TOTAL P&L</div>
                </div>
                <div>
                  <div style={{ color: sesColor, fontSize: 15, fontWeight: 800, lineHeight: 1 }}>₱{pnl.sessionPnL >= 0 ? '+' : ''}{pnl.sessionPnL.toFixed(0)}</div>
                  <div style={{ color: '#444', fontSize: 7, marginTop: 1 }}>SESSION</div>
                </div>
              </div>
              {pnl.lastBetResult && (
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <div style={{ background: `${lastColor}18`, border: `1px solid ${lastColor}44`, borderRadius: 3, padding: '3px 8px' }}>
                    <div style={{ color: lastColor, fontSize: 11, fontWeight: 800 }}>{pnl.lastBetResult}</div>
                    {pnl.lastBetAmount !== 0 && <div style={{ color: lastColor, fontSize: 10, fontWeight: 700 }}>₱{pnl.lastBetAmount > 0 ? '+' : ''}{pnl.lastBetAmount.toFixed(0)}</div>}
                  </div>
                  {pnl.lastBetSide && (
                    <div style={{ color: sideColor(pnl.lastBetSide), fontSize: 9 }}>
                      {sideLabel(pnl.lastBetSide)} {pnl.lastFinalConfirmed && <span style={{ color: '#ffcc44', fontSize: 7 }}>×2</span>}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* ── TRIGGERS ──────────────────────────────────────────────────── */}
        <TriggerManagerPanel
          triggers={triggers} onToggle={toggleTrigger} onDelete={deleteTrigger} onAdd={addTrigger}
          recentAlerts={triggerAlerts} onDismissAlert={dismissAlert}
          autoSaveSwitch={autoSaveSwitch} autoSaveTie={autoSaveTie}
          onToggleAutoSwitch={toggleAutoSwitch} onToggleAutoTie={toggleAutoTie}
        />

        {/* ── ARCHIVED SHOES ────────────────────────────────────────────── */}
        {archivedShoes.length > 0 && (
          <div style={{ background: '#0a0a0a', border: '1px solid #1a1a1a', borderRadius: 3, padding: '5px 8px' }}>
            <div style={{ color: '#444', fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 4 }}>ARCHIVED SHOES ({archivedShoes.length})</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {archivedShoes.slice(0, 5).map(shoe => (
                <div key={shoe.id} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#111', borderRadius: 2, padding: '2px 5px' }}>
                  <span style={{ color: '#333', fontSize: 7 }}>{shoe.totalHands}h</span>
                  <span style={{ color: '#ff4444', fontSize: 7 }}>B{shoe.bankerPct}%</span>
                  <span style={{ color: '#4488ff', fontSize: 7 }}>P{shoe.playerPct}%</span>
                  <span style={{ color: '#44dd88', fontSize: 7 }}>T{shoe.tiePct}%</span>
                  <button onClick={() => deleteArchivedShoe(shoe.id)} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#333', fontSize: 7, cursor: 'pointer', padding: 0 }}>✕</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── CLEAR MEMORY ──────────────────────────────────────────────── */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
          {clearConfirm ? (
            <>
              <button onClick={clearAllMemory} style={{ background: '#2a0505', border: '1px solid #ff4444', color: '#ff4444', fontSize: 8, padding: '2px 8px', borderRadius: 2, cursor: 'pointer', fontFamily: 'inherit' }}>CONFIRM CLEAR</button>
              <button onClick={() => setClearConfirm(false)} style={{ background: 'transparent', border: '1px solid #222', color: '#555', fontSize: 8, padding: '2px 8px', borderRadius: 2, cursor: 'pointer', fontFamily: 'inherit' }}>CANCEL</button>
            </>
          ) : (
            <button onClick={() => setClearConfirm(true)} style={{ background: 'transparent', border: '1px solid #1a1a1a', color: '#333', fontSize: 8, padding: '2px 8px', borderRadius: 2, cursor: 'pointer', fontFamily: 'inherit' }}>CLEAR ALL MEMORY</button>
          )}
        </div>

        {/* ── 50 AI ENSEMBLE ────────────────────────────────────────────── */}
        <div style={{ background: '#0a0a0a', border: '1px solid #1a1a1a', borderRadius: 3, padding: '6px 8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ color: '#44dd88', fontSize: 8, fontWeight: 700, letterSpacing: '0.08em' }}>■ 50 AI ENSEMBLE</span>
            <span style={{ color: '#444', fontSize: 7 }}>{activeVoters.length}/50 active</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 4 }}>
            {voters.map(v => <VoterCard key={v.id} ai={v} disabled={truthGate.disabledVoterIds.includes(v.id)} />)}
          </div>
        </div>

      </div>
    </div>
  );
}
