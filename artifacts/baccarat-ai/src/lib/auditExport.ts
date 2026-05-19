import JSZip from 'jszip';
import type { HandResult, VoterOut, AppState, AgentOverrides } from './types';
import { buildBeadRoad, buildBigRoad, buildBigEyeBoy, buildSmallRoad, buildCockroachPig } from './scoreboards';
import { runVoters, initVoters, calcAccuracy, initPatternTypeMemory } from './ai-engine';

type Snapshot = {
  handNumber: number;
  hand: HandResult;
  voters: VoterOut[];
  decision: {
    recommendation: string;
    bankerVotes: number;
    playerVotes: number;
    tieVotes: number;
    noVoteCount: number;
    consensus: string;
    patternType: string;
    ensembleConfidence: number;
    winVotePct: number;
  };
};

function winLoss(rec: string, actual: string): string {
  if (rec === 'NO_VOTE') return 'SKIP';
  if (actual === 'T' && rec !== 'T') return 'PUSH';
  return rec === actual ? 'WIN' : 'LOSS';
}

export async function generateAuditZip(
  state: AppState,
  agentOverrides: AgentOverrides,
): Promise<Blob> {
  const {
    shoeNumber, activeShoe, voters: currentVoters,
    performance, globalShoeState, archivedShoes, patternTypeMemory,
  } = state;

  // Replay shoe hand-by-hand to reconstruct per-hand agent states
  const snapshots: Snapshot[] = [];
  let prevVoters = initVoters();
  const replayPtm = initPatternTypeMemory();

  for (let i = 0; i < activeShoe.length; i++) {
    const { voters: newVoters, decision } = runVoters(
      activeShoe.slice(0, i),
      archivedShoes,
      prevVoters,
      {},
      replayPtm,
    );
    snapshots.push({
      handNumber: i + 1,
      hand: activeShoe[i],
      voters: newVoters,
      decision,
    });
    prevVoters = newVoters;
  }

  const zip = new JSZip();
  const total = activeShoe.length;
  const bC = activeShoe.filter(h => h.side === 'B').length;
  const pC = activeShoe.filter(h => h.side === 'P').length;
  const tC = activeShoe.filter(h => h.side === 'T').length;

  // ── 1. shoe_summary.json ──────────────────────────────────────────────────
  zip.file('shoe_summary.json', JSON.stringify({
    shoe_id: shoeNumber,
    export_timestamp: new Date().toISOString(),
    total_hands: total,
    banker_count: bC,
    player_count: pC,
    tie_count: tC,
    banker_pct: total ? Math.round(bC / total * 100) : 0,
    player_pct: total ? Math.round(pC / total * 100) : 0,
    tie_pct: total ? Math.round(tC / total * 100) : 0,
    ai_performance: {
      correct: performance.correct,
      wrong: performance.wrong,
      push: performance.push,
      skipped: performance.skipped,
      accuracy: calcAccuracy(performance.correct, performance.wrong),
    },
    global_shoe_state: globalShoeState,
    pattern_type_memory: patternTypeMemory,
    active_agent_overrides: Object.keys(agentOverrides).length,
  }, null, 2));

  // ── 2. every_hand_log.json ────────────────────────────────────────────────
  zip.file('every_hand_log.json', JSON.stringify(
    snapshots.map(s => ({
      hand_number: s.handNumber,
      actual_result: s.hand.side,
      final_number: s.hand.number,
      pair_flags: s.hand.pairFlags,
      natural_flag: s.hand.naturalFlag,
      final_consensus_signal: s.decision.recommendation,
      banker_votes: s.decision.bankerVotes,
      player_votes: s.decision.playerVotes,
      no_vote_count: s.decision.noVoteCount,
      consensus_level: s.decision.consensus,
      pattern_type: s.decision.patternType,
      ensemble_confidence: s.decision.ensembleConfidence,
      win_loss_skip_result: winLoss(s.decision.recommendation, s.hand.side),
    })),
    null, 2,
  ));

  // ── 3. consensus_decisions.csv ────────────────────────────────────────────
  zip.file('consensus_decisions.csv', [
    'hand_number,actual_result,recommendation,banker_votes,player_votes,no_vote_count,consensus,pattern_type,ensemble_confidence,win_loss',
    ...snapshots.map(s => [
      s.handNumber,
      s.hand.side,
      s.decision.recommendation,
      s.decision.bankerVotes,
      s.decision.playerVotes,
      s.decision.noVoteCount,
      s.decision.consensus,
      s.decision.patternType,
      s.decision.ensembleConfidence,
      winLoss(s.decision.recommendation, s.hand.side),
    ].join(',')),
  ].join('\n'));

  // ── 4. agent_50_everyhand_votes.csv ───────────────────────────────────────
  zip.file('agent_50_everyhand_votes.csv', [
    'hand_number,actual_result,agent_id,agent_name,agent_group,vote,confidence,pressure_score,number_pressure,rejection_reason,vote_type,hot_cold,sk_accuracy,sk_samples',
    ...snapshots.flatMap(s =>
      s.voters.map(v => [
        s.handNumber,
        s.hand.side,
        v.id,
        `"${v.name}"`,
        v.agentGroup,
        v.vote,
        v.confidence,
        v.pressureScore,
        v.numberPressure,
        `"${v.rejectionReason}"`,
        v.voteType,
        v.hotCold,
        v.skAccuracy,
        v.skSamples,
      ].join(','))
    ),
  ].join('\n'));

  // ── 5. agent_50_everyhand_features.json ───────────────────────────────────
  zip.file('agent_50_everyhand_features.json', JSON.stringify(
    snapshots.map(s => ({
      hand_number: s.handNumber,
      actual_result: s.hand.side,
      agents: s.voters.map(v => ({
        agent_id: v.id,
        agent_name: v.name,
        agent_group: v.agentGroup,
        vote: v.vote,
        confidence: v.confidence,
        pressure_score: v.pressureScore,
        number_pressure: v.numberPressure,
        rejection_reason: v.rejectionReason,
        vote_type: v.voteType,
        state_key: v.stateKey,
        sk_accuracy: v.skAccuracy,
        sk_samples: v.skSamples,
        hot_cold: v.hotCold,
        uncertainty_score: v.uncertaintyScore,
        fake_pattern_risk: v.fakePatternRisk,
        entropy_warning: v.entropyWarning,
        side_only_warning: v.sideOnlyWarning,
        contradiction_warning: v.contradictionWarning,
      })),
    })),
    null, 2,
  ));

  // ── 6. scorecard_roads.json ───────────────────────────────────────────────
  const bigRoad = buildBigRoad(activeShoe);
  zip.file('scorecard_roads.json', JSON.stringify({
    bead_road: buildBeadRoad(activeShoe),
    big_road: bigRoad,
    big_eye_boy: buildBigEyeBoy(bigRoad),
    small_road: buildSmallRoad(bigRoad),
    cockroach_pig: buildCockroachPig(bigRoad),
  }, null, 2));

  // ── 7. statistical_tests.json ─────────────────────────────────────────────
  const highConfWrong = snapshots.filter(s =>
    s.decision.recommendation !== 'NO_VOTE' &&
    s.decision.recommendation !== s.hand.side &&
    s.decision.ensembleConfidence >= 70,
  );

  const agentStats = currentVoters.map(v => ({
    agent_id: v.id,
    agent_name: v.name,
    agent_group: v.agentGroup,
    current_shoe: {
      correct: v.correct,
      wrong: v.wrong,
      push: v.push,
      accuracy: calcAccuracy(v.correct, v.wrong),
    },
    all_time: {
      correct: v.allTimeCorrect,
      wrong: v.allTimeWrong,
      accuracy: calcAccuracy(v.allTimeCorrect, v.allTimeWrong),
    },
  })).sort((a, b) => b.current_shoe.accuracy - a.current_shoe.accuracy);

  zip.file('statistical_tests.json', JSON.stringify({
    agent_stats: agentStats,
    pattern_type_memory: patternTypeMemory,
    high_confidence_wrong: {
      count: highConfWrong.length,
      hands: highConfWrong.map(s => ({
        hand_number: s.handNumber,
        actual: s.hand.side,
        predicted: s.decision.recommendation,
        confidence: s.decision.ensembleConfidence,
      })),
    },
    performance_summary: {
      correct: performance.correct,
      wrong: performance.wrong,
      push: performance.push,
      skipped: performance.skipped,
      win_rate_pct: calcAccuracy(performance.correct, performance.wrong),
    },
  }, null, 2));

  // ── 8. improvement_gaps.json ──────────────────────────────────────────────
  const highConfWrongByAgent: Record<string, number> = {};
  const agentGroupVotes: Record<string, { B: number; P: number; NO_VOTE: number }> = {};

  for (const s of snapshots) {
    for (const v of s.voters) {
      if (v.vote !== 'NO_VOTE' && v.vote !== s.hand.side && v.confidence >= 70) {
        highConfWrongByAgent[v.id] = (highConfWrongByAgent[v.id] ?? 0) + 1;
      }
      const g = v.agentGroup ?? 'UNKNOWN';
      if (!agentGroupVotes[g]) agentGroupVotes[g] = { B: 0, P: 0, NO_VOTE: 0 };
      agentGroupVotes[g]!.B += v.vote === 'B' ? 1 : 0;
      agentGroupVotes[g]!.P += v.vote === 'P' ? 1 : 0;
      agentGroupVotes[g]!.NO_VOTE += v.vote !== 'B' && v.vote !== 'P' ? 1 : 0;
    }
  }

  // Detect agents sharing same state key structure (potential duplicate signals)
  const skPrefixMap: Record<string, string[]> = {};
  for (const v of currentVoters) {
    const prefix = v.stateKey?.split('|')[0] ?? 'ND';
    if (!skPrefixMap[prefix]) skPrefixMap[prefix] = [];
    skPrefixMap[prefix].push(v.id);
  }
  const duplicateSignalGroups = Object.entries(skPrefixMap)
    .filter(([, ids]) => ids.length > 3)
    .map(([key, ids]) => ({ state_key_prefix: key, agent_count: ids.length, agents: ids }));

  // Agents wrong despite high confidence
  const topWrongConfident = Object.entries(highConfWrongByAgent)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([id, count]) => ({ agent_id: id, high_conf_wrong_count: count }));

  zip.file('improvement_gaps.json', JSON.stringify({
    agents_wrong_despite_high_confidence: topWrongConfident,
    group_vote_totals: agentGroupVotes,
    potential_duplicate_signal_agents: duplicateSignalGroups,
    recommendations: [
      'Upload this ZIP to an LLM for agent parameter optimization',
      'Agents in agents_wrong_despite_high_confidence are overconfident — consider adding adversarial critics for their pattern type',
      'Check group_vote_totals for unbalanced group contribution',
      'Agents sharing state key prefixes (potential_duplicate_signal_agents) may be redundant',
    ],
  }, null, 2));

  // ── 9. agent_configs.json ─────────────────────────────────────────────────
  zip.file('agent_configs.json', JSON.stringify({
    exported_at: new Date().toISOString(),
    shoe_id: shoeNumber,
    overrides: agentOverrides,
    agents: currentVoters.map(v => ({
      id: v.id,
      name: v.name,
      short_tag: v.shortTag,
      skill: v.skill,
      skill_tag: v.skillTag,
      skill_desc: v.skillDesc,
      agent_group: v.agentGroup,
      reaction_speed: v.reactionSpeed,
      start_hand: v.startHand,
      current_accuracy: calcAccuracy(v.correct, v.wrong),
      all_time_accuracy: calcAccuracy(v.allTimeCorrect, v.allTimeWrong),
    })),
  }, null, 2));

  return zip.generateAsync({ type: 'blob' });
}
