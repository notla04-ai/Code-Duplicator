import { useState, useRef, useEffect } from 'react';
import { Drawer } from 'vaul';
import type { VoterOut, AgentOverride, AgentOverrides } from './lib/types';
import { calcAccuracy } from './lib/ai-engine';

const ENGINE_MODES = [
  'RAW_SEQUENCE',
  'ROAD_STRUCTURE',
  'PRESSURE_TRANSITION',
  'STOCHASTIC_TEST',
  'ADVERSARIAL_CRITIC',
  'CONSENSUS_JUDGE',
] as const;

const VIEW_FLAGS = [
  'side_sequence',
  'final_number',
  'pressure_score',
  'chop_rate',
  'streak_data',
  'regime_state',
  'entropy_measure',
  'road_position',
  'volatility',
  'window_conflict',
];

function deriveDefaultEngineMode(agentGroup: string): string {
  const g = agentGroup.toLowerCase();
  if (g.includes('adv') || g.startsWith('n')) return 'ADVERSARIAL_CRITIC';
  if (g.includes('regime') || g.includes('road') || g.startsWith('g')) return 'ROAD_STRUCTURE';
  if (g.includes('entropy') || g.includes('stoch') || g.startsWith('f')) return 'STOCHASTIC_TEST';
  if (g.includes('trans') || g.startsWith('e')) return 'PRESSURE_TRANSITION';
  if (g.includes('chop') || g.startsWith('d') || g.startsWith('c')) return 'RAW_SEQUENCE';
  return 'PRESSURE_TRANSITION';
}

type Tab = 'skill' | 'views' | 'engine' | 'memory' | 'debug';

const C = {
  bg: '#060606',
  surface: '#0d0d0d',
  border: '#1c1c1c',
  text: '#666',
  textBright: '#aaa',
  accent: '#ff8844',
  green: '#44dd88',
  red: '#ff4444',
  blue: '#4488ff',
  yellow: '#ddcc44',
};

const inp: React.CSSProperties = {
  background: '#111',
  border: `1px solid ${C.border}`,
  color: C.textBright,
  fontSize: 9,
  padding: '4px 7px',
  borderRadius: 2,
  width: '100%',
  fontFamily: 'monospace',
  outline: 'none',
  boxSizing: 'border-box',
};

function Lbl({ text }: { text: string }) {
  return (
    <div style={{ color: C.text, fontSize: 7, fontWeight: 700, letterSpacing: '0.12em', marginBottom: 4 }}>
      {text}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
      padding: '5px 0', borderBottom: `1px solid #111`,
    }}>
      <span style={{ color: C.text, fontSize: 8, flexShrink: 0, marginRight: 8 }}>{label}</span>
      <span style={{ color: C.textBright, fontSize: 8, fontWeight: 700, textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}

function TabBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        background: 'transparent',
        border: 'none',
        borderBottom: active ? `2px solid ${C.accent}` : '2px solid transparent',
        color: active ? C.accent : C.text,
        fontSize: 8, fontWeight: 700, letterSpacing: '0.1em',
        padding: '7px 4px', cursor: 'pointer', fontFamily: 'inherit',
        transition: 'color 0.15s',
      }}
    >{label}</button>
  );
}

interface Props {
  agentId: string | null;
  voter: VoterOut | null;
  overrides: AgentOverrides;
  onSave: (agentId: string, override: AgentOverride) => void;
  onReset: (agentId: string) => void;
  onClose: () => void;
}

export function AgentEditorDrawer({ agentId, voter, overrides, onSave, onReset, onClose }: Props) {
  const existing = agentId ? (overrides[agentId] ?? null) : null;

  const [tab, setTab] = useState<Tab>('skill');
  const [enabled, setEnabled] = useState(true);
  const [customName, setCustomName] = useState('');
  const [customDesc, setCustomDesc] = useState('');
  const [customNotes, setCustomNotes] = useState('');
  const [engineMode, setEngineMode] = useState('PRESSURE_TRANSITION');
  const [viewFlags, setViewFlags] = useState<Record<string, boolean>>(
    Object.fromEntries(VIEW_FLAGS.map(f => [f, true]))
  );

  const fileRef = useRef<HTMLInputElement>(null);
  const isOpen = !!agentId && !!voter;

  // Sync form state when agent changes
  useEffect(() => {
    if (!voter) return;
    setTab('skill');
    setEnabled(existing?.enabled ?? true);
    setCustomName(existing?.customName ?? voter.name);
    setCustomDesc(existing?.customSkillDesc ?? voter.skillDesc);
    setCustomNotes(existing?.customNotes ?? '');
    setEngineMode(existing?.engineMode ?? deriveDefaultEngineMode(voter?.agentGroup ?? ''));
    setViewFlags(existing?.viewFlags ?? Object.fromEntries(VIEW_FLAGS.map(f => [f, true])));
  }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!voter) return null;

  const acc = calcAccuracy(voter.correct, voter.wrong);
  const atAcc = calcAccuracy(voter.allTimeCorrect, voter.allTimeWrong);

  const handleSave = () => {
    if (!agentId) return;
    onSave(agentId, {
      enabled,
      customName: customName !== voter.name ? customName : undefined,
      customSkillDesc: customDesc !== voter.skillDesc ? customDesc : undefined,
      customNotes: customNotes || undefined,
      engineMode,
      viewFlags,
    });
    onClose();
  };

  const handleExport = () => {
    if (!agentId) return;
    const payload = {
      agent_id: agentId,
      exported_at: new Date().toISOString(),
      override: { enabled, customName, customSkillDesc: customDesc, customNotes, engineMode, viewFlags },
      current_stats: {
        vote: voter.vote,
        confidence: voter.confidence,
        correct: voter.correct,
        wrong: voter.wrong,
        accuracy: acc,
        state_key: voter.stateKey,
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agent_${agentId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        const ov: Partial<AgentOverride & { customSkillDesc: string }> = data.override ?? data;
        if (typeof ov.enabled === 'boolean') setEnabled(ov.enabled);
        if (typeof ov.customName === 'string') setCustomName(ov.customName);
        if (typeof ov.customSkillDesc === 'string') setCustomDesc(ov.customSkillDesc);
        if (typeof ov.customNotes === 'string') setCustomNotes(ov.customNotes);
        if (typeof ov.engineMode === 'string') setEngineMode(ov.engineMode);
        if (ov.viewFlags && typeof ov.viewFlags === 'object') setViewFlags(ov.viewFlags as Record<string, boolean>);
      } catch {
        alert('Invalid JSON config file');
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  };

  const toggleView = (flag: string) => {
    setViewFlags(prev => ({ ...prev, [flag]: !prev[flag] }));
  };

  const voteColor = voter.vote === 'B' ? C.blue : voter.vote === 'P' ? C.red : C.text;

  return (
    <Drawer.Root open={isOpen} onOpenChange={o => { if (!o) onClose(); }} direction="right">
      <Drawer.Portal>
        <Drawer.Overlay style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9000 }} />
        <Drawer.Content
          aria-label={`Agent Editor: ${voter.shortTag}`}
          style={{
            position: 'fixed', top: 0, right: 0, bottom: 0,
            width: 320, background: C.bg,
            borderLeft: `1px solid ${C.border}`,
            display: 'flex', flexDirection: 'column', zIndex: 9001,
            overflowY: 'hidden', fontFamily: 'monospace',
          }}
        >
          {/* ── Header ─────────────────────────────────────────────────────── */}
          <div style={{ padding: '10px 12px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ color: C.accent, fontSize: 12, fontWeight: 800 }}>{voter.shortTag}</span>
                <span style={{ background: '#ff884415', color: C.accent, fontSize: 6, padding: '1px 5px', borderRadius: 2 }}>{voter.agentGroup}</span>
              </div>
              <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#444', fontSize: 16, cursor: 'pointer', lineHeight: 1, padding: '0 2px' }}>×</button>
            </div>
            <div style={{ color: '#333', fontSize: 7, marginBottom: 7, letterSpacing: '0.05em' }}>{voter.id}</div>
            <button
              onClick={() => setEnabled(e => !e)}
              style={{
                background: enabled ? '#0a1f0a' : '#1f0a0a',
                border: `1px solid ${enabled ? C.green + '44' : C.red + '44'}`,
                color: enabled ? C.green : C.red,
                fontSize: 8, fontWeight: 700, padding: '4px 12px',
                borderRadius: 2, cursor: 'pointer', fontFamily: 'inherit',
                letterSpacing: '0.08em',
              }}
            >
              {enabled ? '● ENABLED' : '○ DISABLED'}
            </button>
            {!enabled && (
              <div style={{ color: C.red, fontSize: 7, marginTop: 4 }}>→ forces NO_BET from next hand</div>
            )}
          </div>

          {/* ── Tab bar ────────────────────────────────────────────────────── */}
          <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
            {(['skill', 'views', 'engine', 'memory', 'debug'] as Tab[]).map(t => (
              <TabBtn key={t} label={t.toUpperCase()} active={tab === t} onClick={() => setTab(t)} />
            ))}
          </div>

          {/* ── Tab content ────────────────────────────────────────────────── */}
          <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>

            {/* SKILL */}
            {tab === 'skill' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                <div>
                  <Lbl text="AGENT NAME" />
                  <input value={customName} onChange={e => setCustomName(e.target.value)} style={inp} />
                </div>
                <div>
                  <Lbl text="SKILL DESCRIPTION" />
                  <textarea
                    value={customDesc}
                    onChange={e => setCustomDesc(e.target.value)}
                    rows={4}
                    style={{ ...inp, resize: 'vertical' as const }}
                  />
                </div>
                <div>
                  <Lbl text="SKILL TAG" />
                  <input value={voter.skillTag} readOnly style={{ ...inp, color: C.text }} />
                </div>
                <div>
                  <Lbl text="AGENT GROUP / ASSIGNED ROLE" />
                  <input value={voter.agentGroup} readOnly style={{ ...inp, color: C.text }} />
                </div>
                <div>
                  <Lbl text="REJECTION RULES / NOTES" />
                  <textarea
                    value={customNotes}
                    onChange={e => setCustomNotes(e.target.value)}
                    rows={3}
                    placeholder="Personal notes, observed failure patterns..."
                    style={{ ...inp, resize: 'vertical' as const, color: C.textBright }}
                  />
                </div>
              </div>
            )}

            {/* VIEWS */}
            {tab === 'views' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <div style={{ color: C.text, fontSize: 7, marginBottom: 8, lineHeight: 1.5 }}>
                  Feature views conceptually available to this agent. Toggle to annotate relevance for audit export.
                </div>
                {VIEW_FLAGS.map(flag => (
                  <div
                    key={flag}
                    onClick={() => toggleView(flag)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 9,
                      padding: '5px 6px', cursor: 'pointer', borderRadius: 2,
                      background: viewFlags[flag] ? '#0a1a0a' : 'transparent',
                      border: `1px solid ${viewFlags[flag] ? '#44dd8822' : '#111'}`,
                      marginBottom: 3,
                    }}
                  >
                    <div style={{
                      width: 11, height: 11, borderRadius: 2, flexShrink: 0,
                      background: viewFlags[flag] ? C.green : '#222',
                      border: `1px solid ${viewFlags[flag] ? C.green + '88' : '#333'}`,
                    }} />
                    <span style={{ color: viewFlags[flag] ? C.textBright : C.text, fontSize: 8, letterSpacing: '0.05em' }}>
                      {flag.replace(/_/g, ' ').toUpperCase()}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* ENGINE */}
            {tab === 'engine' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <Lbl text="MAIN ENGINE MODE" />
                  <select
                    value={engineMode}
                    onChange={e => setEngineMode(e.target.value)}
                    style={{ ...inp, cursor: 'pointer' }}
                  >
                    {ENGINE_MODES.map(m => (
                      <option key={m} value={m} style={{ background: '#111' }}>{m}</option>
                    ))}
                  </select>
                  <div style={{ color: C.text, fontSize: 7, marginTop: 5, lineHeight: 1.5 }}>
                    Engine mode labels the agent for audit export routing and future optimization. It does not alter the current voting algorithm.
                  </div>
                </div>
                <div style={{ background: '#0d0d0d', borderRadius: 3, padding: 10, border: `1px solid ${C.border}` }}>
                  <Lbl text="COMPILED PROPERTIES" />
                  <Row label="Agent Group" value={voter.agentGroup} />
                  <Row label="Reaction Speed" value={voter.reactionSpeed} />
                  <Row label="Start Hand" value={voter.startHand} />
                  <Row label="Skill" value={voter.skill} />
                </div>
              </div>
            )}

            {/* MEMORY */}
            {tab === 'memory' && (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <div style={{ color: C.text, fontSize: 7, fontWeight: 700, letterSpacing: '0.12em', marginBottom: 6 }}>STATE KEY MEMORY</div>
                <Row label="State Key" value={<span style={{ fontFamily: 'monospace', fontSize: 7, wordBreak: 'break-all' }}>{voter.stateKey || '—'}</span>} />
                <Row label="SK Samples" value={voter.skSamples || '—'} />
                <Row label="SK Accuracy" value={voter.skSamples > 0 ? `${voter.skAccuracy}%` : '—'} />
                <Row label="Hot / Cold" value={
                  <span style={{ color: voter.hotCold === 'hot' ? '#ff6633' : voter.hotCold === 'cold' ? C.blue : C.text }}>
                    {voter.hotCold}
                  </span>
                } />
                <Row label="Vote Status" value={voter.voteStatus} />

                <div style={{ color: C.text, fontSize: 7, fontWeight: 700, letterSpacing: '0.12em', marginTop: 10, marginBottom: 6 }}>THIS SHOE</div>
                <Row label="Correct" value={<span style={{ color: C.green }}>{voter.correct}</span>} />
                <Row label="Wrong" value={<span style={{ color: C.red }}>{voter.wrong}</span>} />
                <Row label="Push" value={<span style={{ color: C.yellow }}>{voter.push}</span>} />
                <Row label="Skipped" value={voter.skipped} />
                <Row label="Accuracy" value={
                  <span style={{ color: acc >= 55 ? C.green : acc > 0 ? '#ff6644' : C.text }}>
                    {acc > 0 ? `${acc}%` : '—'}
                  </span>
                } />

                <div style={{ color: C.text, fontSize: 7, fontWeight: 700, letterSpacing: '0.12em', marginTop: 10, marginBottom: 6 }}>ALL TIME</div>
                <Row label="Correct" value={voter.allTimeCorrect} />
                <Row label="Wrong" value={voter.allTimeWrong} />
                <Row label="Accuracy" value={
                  <span style={{ color: atAcc >= 60 ? C.green : atAcc > 0 ? '#ff6644' : C.text }}>
                    {atAcc > 0 ? `${atAcc}%` : '—'}
                  </span>
                } />
              </div>
            )}

            {/* DEBUG */}
            {tab === 'debug' && (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <div style={{ color: C.text, fontSize: 7, fontWeight: 700, letterSpacing: '0.12em', marginBottom: 6 }}>LAST HAND OUTPUT</div>
                <Row label="Vote" value={<span style={{ color: voteColor, fontWeight: 800 }}>{voter.vote}</span>} />
                <Row label="Confidence" value={voter.confidence > 0 ? `${voter.confidence}%` : '—'} />
                <Row label="Pressure Score" value={voter.pressureScore} />
                <Row label="Number Pressure" value={voter.numberPressure} />
                <Row label="Vote Type" value={voter.voteType} />
                <Row label="Agent Strength" value={voter.agentStrength} />
                {voter.rejectionReason && (
                  <Row label="Rejection" value={<span style={{ color: C.red, fontSize: 7 }}>{voter.rejectionReason}</span>} />
                )}

                <div style={{ color: C.text, fontSize: 7, fontWeight: 700, letterSpacing: '0.12em', marginTop: 10, marginBottom: 6 }}>SELF-AWARENESS</div>
                <Row label="Uncertainty" value={voter.uncertaintyScore} />
                <Row label="Fake Pattern Risk" value={voter.fakePatternRisk} />
                <Row label="Entropy Warning" value={voter.entropyWarning ? <span style={{ color: C.yellow }}>⚠ YES</span> : 'no'} />
                <Row label="Side Only Warning" value={voter.sideOnlyWarning ? <span style={{ color: C.yellow }}>⚠ YES</span> : 'no'} />
                <Row label="Contradiction" value={voter.contradictionWarning ? <span style={{ color: C.yellow }}>⚠ YES</span> : 'no'} />

                <div style={{ color: C.text, fontSize: 7, fontWeight: 700, letterSpacing: '0.12em', marginTop: 10, marginBottom: 6 }}>PEER REVIEW</div>
                <Row label="Changed Vote" value={voter.peerReviewChanged ? <span style={{ color: C.accent }}>YES</span> : 'no'} />
                {voter.peerReviewReason && (
                  <Row label="PR Reason" value={<span style={{ fontSize: 7 }}>{voter.peerReviewReason}</span>} />
                )}
              </div>
            )}
          </div>

          {/* ── Footer actions ─────────────────────────────────────────────── */}
          <div style={{ padding: '10px 12px', borderTop: `1px solid ${C.border}`, flexShrink: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 7 }}>
              <button
                onClick={handleExport}
                style={{ background: '#0a1525', border: `1px solid ${C.blue}33`, color: C.blue, fontSize: 8, padding: '5px', borderRadius: 2, cursor: 'pointer', fontFamily: 'inherit' }}
              >EXPORT JSON</button>
              <button
                onClick={() => fileRef.current?.click()}
                style={{ background: '#1a1a08', border: `1px solid ${C.yellow}33`, color: C.yellow, fontSize: 8, padding: '5px', borderRadius: 2, cursor: 'pointer', fontFamily: 'inherit' }}
              >IMPORT JSON</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <button
                onClick={() => { if (agentId) { onReset(agentId); onClose(); } }}
                style={{ background: '#1f0a0a', border: `1px solid ${C.red}33`, color: C.red, fontSize: 8, padding: '5px', borderRadius: 2, cursor: 'pointer', fontFamily: 'inherit' }}
              >RESET AGENT</button>
              <button
                onClick={handleSave}
                style={{ background: '#0a1f0a', border: `1px solid ${C.green}55`, color: C.green, fontSize: 8, fontWeight: 700, padding: '5px', borderRadius: 2, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.05em' }}
              >SAVE CHANGES</button>
            </div>
            <input ref={fileRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImport} />
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
