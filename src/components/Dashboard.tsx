import { useEffect, useMemo, useRef, useState } from 'react';
import { api, elapsed, getState, patchSettings, patchUi, shortModel, tildify, useStore } from '../lib/store';
import type { Agent, ModelOption, ReviewAgent, SubagentMode } from '../lib/types';
import { HarnessIcon, Icon } from './Icons';
import { showAgent } from './Canvas';
import { StatusDot, useTick } from './Pane';

const HARNESSES: { id: SubagentMode['harness']; label: string }[] = [
  { id: 'pi', label: 'Pi' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
  { id: 'devin', label: 'Devin' },
  { id: 'native', label: 'Native' },
];
const REVIEW_HARNESSES: { id: ReviewAgent['harness']; label: string }[] = [
  { id: 'mode', label: 'Same' },
  { id: 'pi', label: 'Pi' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
  { id: 'devin', label: 'Devin' },
];
const THINKING = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi', devin: 'Devin', shell: 'Terminal' };

function ModelPicker({ harness, value, onChange }: { harness: string; value: string | null; onChange: (m: string | null) => void }) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api<{ models: ModelOption[] }>(`/api/models?harness=${harness}`)
      .then(r => live && setModels(r.models))
      .catch(() => live && setModels([]))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [harness]);

  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return models.filter(m => !q || m.id.toLowerCase().includes(q) || m.group.toLowerCase().includes(q)).slice(0, 150);
  }, [models, query]);
  const groups = useMemo(() => {
    const map = new Map<string, ModelOption[]>();
    for (const m of filtered) map.set(m.group, [...(map.get(m.group) ?? []), m]);
    return [...map];
  }, [filtered]);

  return (
    <div className="model-picker" ref={box}>
      <button className="field" onClick={() => setOpen(o => !o)}>
        <span className="field-value">{value ?? 'Harness default'}</span>
        <Icon.Chevron size={12} className="rot90" />
      </button>
      {open && (
        <div className="model-pop">
          <input
            autoFocus
            placeholder={loading ? 'Loading models…' : `Search ${models.length} models or type an id`}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && query.trim()) {
                onChange(filtered[0]?.id ?? query.trim());
                setOpen(false);
              }
              if (e.key === 'Escape') setOpen(false);
            }}
          />
          <div className="model-list">
            <button className={!value ? 'on' : ''} onClick={() => (onChange(null), setOpen(false))}>
              Harness default
            </button>
            {groups.map(([group, list]) => (
              <div key={group}>
                <div className="model-group">{group}</div>
                {list.map(m => (
                  <button key={m.id} className={value === m.id ? 'on' : ''} onClick={() => (onChange(m.id), setOpen(false))}>
                    {m.label}
                  </button>
                ))}
              </div>
            ))}
            {!loading && query && !filtered.length && <button onClick={() => (onChange(query.trim()), setOpen(false))}>Use “{query.trim()}”</button>}
          </div>
        </div>
      )}
    </div>
  );
}

function ModeCard() {
  const settings = useStore(s => s.settings);
  const [more, setMore] = useState(false);
  if (!settings) return null;
  const mode = settings.mode;
  // Merge into the latest settings, not this render's, so two quick changes don't undo each other.
  const set = (patch: Partial<SubagentMode>) => void patchSettings({ mode: { ...getState().settings!.mode, ...patch } });
  return (
    <div className="mode">
      <div className="mode-head">
        <span className="mode-title">Sub-agent mode</span>
        <button className="mode-more" onClick={() => setMore(m => !m)}>
          {more ? 'Less' : 'More'}
        </button>
      </div>
      <div className="seg seg-icons">
        {HARNESSES.map(h => (
          <button key={h.id} className={mode.harness === h.id ? 'on' : ''} onClick={() => set({ harness: h.id, model: h.id === mode.harness ? mode.model : null })} title={h.label}>
            <HarnessIcon id={h.id} size={13} />
            {h.label}
          </button>
        ))}
      </div>
      {mode.harness === 'native' ? (
        <p className="mode-line">Each harness uses its own built-in sub-agents (no panes).</p>
      ) : (
        <>
          <ModelPicker harness={mode.harness} value={mode.model} onChange={model => set({ model })} />
          {more && (
            <div className="row2">
              <label className="setting">
                <span className="setting-label">Thinking</span>
                <select className="field" value={mode.thinking ?? ''} onChange={e => set({ thinking: e.target.value || null })}>
                  {THINKING.map(t => (
                    <option key={t} value={t}>
                      {t || 'default'}
                    </option>
                  ))}
                </select>
              </label>
              <div className="setting">
                <span className="setting-label">Sub-agent panes</span>
                <div className="seg">
                  <button className={settings.ui.showSubagents ? 'on' : ''} onClick={() => patchUi({ showSubagents: true })}>
                    Show
                  </button>
                  <button className={!settings.ui.showSubagents ? 'on' : ''} onClick={() => patchUi({ showSubagents: false })}>
                    Hide
                  </button>
                </div>
              </div>
            </div>
          )}
          <p className="mode-line">
            When an agent here uses sub-agents, they run as <strong>{mode.harness}</strong>
            {mode.model ? (
              <>
                {' · '}
                <strong>{shortModel(mode.model)}</strong>
              </>
            ) : null}
            {mode.thinking ? ` · ${mode.thinking}` : ''}.
          </p>
        </>
      )}
    </div>
  );
}

function Reply({ agent }: { agent: Agent }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api(`/api/agents/${agent.id}/message`, { body: { text } });
      setText('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="reply">
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && void send()}
        placeholder={agent.status === 'waiting' ? `Answer ${agent.name}…` : `Message ${agent.name}…`}
        disabled={busy}
      />
      <button className="icon-btn" onClick={() => void send()} disabled={busy || !text.trim()}>
        <Icon.Send size={14} />
      </button>
    </div>
  );
}

function stateText(a: Agent): string {
  const t = elapsed(a);
  switch (a.status) {
    case 'waiting':
      return `Needs you ${t}`;
    case 'working':
    case 'starting':
      return `Working ${t}`;
    case 'done':
      return `Done ${t}`;
    case 'error':
      return 'Error';
    case 'exited':
      return 'Exited';
    default:
      return 'Idle';
  }
}

function Row({ agent, parent }: { agent: Agent; parent: Agent | null }) {
  const [open, setOpen] = useState(agent.status === 'waiting');
  const [confirmClose, setConfirmClose] = useState(false);
  useEffect(() => {
    if (!confirmClose) return;
    const t = setTimeout(() => setConfirmClose(false), 3000);
    return () => clearTimeout(t);
  }, [confirmClose]);
  const running = !['exited', 'error'].includes(agent.status);
  useEffect(() => {
    if (agent.status === 'waiting') setOpen(true);
  }, [agent.status]);
  const sub = agent.role === 'sub';
  const title = sub ? (agent.task?.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '') ?? agent.name) : LABEL[agent.harness];
  const subtitle = [
    sub ? agent.name : tildify(agent.cwd).split('/').pop(),
    `${LABEL[agent.harness]}${agent.model ? ` · ${shortModel(agent.model)}` : ''}`,
    parent ? `from ${parent.name}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={`row ${open ? 'row-open' : ''}`}>
      <button className="row-head" onClick={() => setOpen(o => !o)}>
        <span className="row-icon">
          <HarnessIcon id={agent.harness} size={15} />
        </span>
        <span className="row-text">
          <span className="row-title">{title}</span>
          <span className="row-sub">{agent.progress && ['working', 'starting'].includes(agent.status) ? agent.progress : subtitle}</span>
        </span>
        <span className={`state state-${agent.status}`}>
          <StatusDot status={agent.status} />
          {stateText(agent)}
        </span>
      </button>
      {open && (
        <div className="row-body">
          {agent.question && agent.status === 'waiting' && (
            <div className="question">
              <b>{agent.name} asks</b>
              <br />
              {agent.question}
            </div>
          )}
          {sub && agent.task && (
            <details>
              <summary>Brief</summary>
              <pre>{agent.task}</pre>
            </details>
          )}
          {agent.result ? <pre className="result">{agent.result}</pre> : sub && <p className="note">{['working', 'starting'].includes(agent.status) ? 'Working. The report shows up here when it finishes.' : 'No report.'}</p>}
          {agent.worktree && (
            <p className="note">
              <Icon.Branch size={12} /> {agent.worktree.branch}
            </p>
          )}
          {!['exited', 'error'].includes(agent.status) && <Reply agent={agent} />}
          <div className="row-actions">
            <button onClick={() => showAgent(agent)}>Open pane</button>
            {running && <button onClick={() => void api(`/api/agents/${agent.id}/stop`, { body: {} })}>Stop</button>}
            <button onClick={() => (running && !confirmClose ? setConfirmClose(true) : void api(`/api/agents/${agent.id}`, { method: 'DELETE' }))}>{confirmClose ? 'Close? It stops the agent' : 'Close'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewCard() {
  const settings = useStore(s => s.settings);
  const [more, setMore] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  if (!settings) return null;
  const review = settings.review;
  const set = (patch: Partial<ReviewAgent>) => void patchSettings({ review: { ...getState().settings!.review, ...patch } });
  const same = review.harness === 'mode';
  return (
    <div className="mode">
      <div className="mode-head">
        <span className="mode-title">Review agent</span>
        <button className="mode-more" onClick={() => setMore(m => !m)}>
          {more ? 'Less' : 'More'}
        </button>
      </div>
      <div className="seg seg-icons">
        {REVIEW_HARNESSES.map(h => (
          <button
            key={h.id}
            className={review.harness === h.id ? 'on' : ''}
            onClick={() => set({ harness: h.id, model: h.id === review.harness ? review.model : null })}
            title={h.id === 'mode' ? 'Same as the sub-agent mode' : h.label}
          >
            {h.id !== 'mode' && <HarnessIcon id={h.id} size={13} />}
            {h.label}
          </button>
        ))}
      </div>
      {!same && <ModelPicker harness={review.harness} value={review.model} onChange={model => set({ model })} />}
      {more && (
        <>
          {!same && (
            <label className="setting">
              <span className="setting-label">Thinking</span>
              <select className="field" value={review.thinking ?? ''} onChange={e => set({ thinking: e.target.value || null })}>
                {THINKING.map(t => (
                  <option key={t} value={t}>
                    {t || 'default'}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="setting">
            <span className="setting-label">Instructions for every review</span>
            <textarea
              className="field review-instructions"
              rows={3}
              placeholder="e.g. Use the code-review skill. Run pnpm test."
              value={draft ?? review.instructions}
              onChange={e => setDraft(e.target.value)}
              onBlur={() => {
                if (draft !== null && draft !== review.instructions) set({ instructions: draft });
                setDraft(null);
              }}
            />
          </label>
        </>
      )}
      <p className="mode-line">
        Reviews run as <strong>{same ? 'your sub-agent mode' : review.harness}</strong>
        {!same && review.model ? (
          <>
            {' · '}
            <strong>{shortModel(review.model)}</strong>
          </>
        ) : null}
        {review.instructions.trim() ? ', with your instructions' : ''}. Start them with <strong>Review</strong> under a main agent.
      </p>
    </div>
  );
}

export function Dashboard() {
  const agents = useStore(s => s.agents);
  useTick(agents.some(a => ['working', 'starting', 'waiting'].includes(a.status)));
  const needs = agents.filter(a => a.status === 'waiting');
  const working = agents.filter(a => ['working', 'starting'].includes(a.status));
  const done = agents.filter(a => a.role === 'sub' && a.status === 'done');
  const idle = agents.filter(a => a.role === 'main' && ['idle', 'done'].includes(a.status));
  const ended = agents.filter(a => ['exited', 'error'].includes(a.status));
  const parentOf = (a: Agent) => (a.parentId ? (agents.find(p => p.id === a.parentId) ?? null) : null);
  const group = (title: string, list: Agent[]) =>
    list.length > 0 && (
      <section key={title}>
        <div className="group-title">
          {title} {list.length}
        </div>
        {list.map(a => (
          <Row key={a.id} agent={a} parent={parentOf(a)} />
        ))}
      </section>
    );

  return (
    <aside className="dash surface">
      <div className="dash-strip">
        <span className="dash-pill">
          <Icon.Grid size={13} /> Dashboard {needs.length > 0 && <span className="count count-amber">{needs.length}</span>}
        </span>
        <button className="icon-btn" title="Hide  ⇧⌘B" onClick={() => patchUi({ dashboard: false })}>
          <Icon.Close size={13} />
        </button>
      </div>
      <div className="dash-scroll">
        <ModeCard />
        <ReviewCard />
        <div className="stats">
          <div className="stat">
            <span className="stat-label">
              <StatusDot status="waiting" /> Needs you
            </span>
            <div className="stat-value">{needs.length}</div>
          </div>
          <div className="stat">
            <span className="stat-label">
              <StatusDot status="working" /> Working
            </span>
            <div className="stat-value">{working.length}</div>
          </div>
          <div className="stat">
            <span className="stat-label">
              <StatusDot status="idle" /> Idle
            </span>
            <div className="stat-value">{idle.length + done.length}</div>
          </div>
        </div>
        {!agents.length && (
          <p className="empty-note">
            Open an agent, then ask it for sub-agents, e.g. <em>“use 3 sub-agents to build the billing page”</em>. They show up here and on the canvas.
          </p>
        )}
        {group('Needs you', needs)}
        {group('Working', working)}
        {group('Done', done)}
        {group('Idle', idle)}
        {group('Ended', ended)}
      </div>
    </aside>
  );
}
