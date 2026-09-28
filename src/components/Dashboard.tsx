import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AGENT_HARNESSES, harnessLabel, isEnded, isRunning } from '../lib/agents';
import { useConfirm, useDismiss, useTick } from '../lib/hooks';
import { api, elapsed, folderName, getState, patchSettings, patchUi, shortModel, useStore } from '../lib/store';
import type { Agent, ModelOption, ReviewAgent, SubagentMode } from '../lib/types';
import { HarnessIcon, Icon } from './Icons';
import { showAgent } from './Canvas';
import { StatusDot } from './Pane';
import { ResizeHandle } from './ResizeHandle';

const MODE_HARNESSES: { id: SubagentMode['harness']; label: string }[] = [...AGENT_HARNESSES.map(h => ({ id: h.id, label: h.short })), { id: 'native', label: 'Native' }];
const REVIEW_HARNESSES: { id: ReviewAgent['harness']; label: string }[] = [{ id: 'mode', label: 'Same' }, ...AGENT_HARNESSES.map(h => ({ id: h.id, label: h.short }))];
const THINKING = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const MAX_RUNNING = [1, 2, 3, 4, 6, 8, 12, 16, 24];

/** The icon row that picks a harness, in the mode and review cards. */
function HarnessRow<T extends string>({ options, value, onPick, titleFor }: { options: { id: T; label: string }[]; value: T; onPick: (id: T) => void; titleFor?: (id: T) => string }) {
  return (
    <div className="seg seg-icons">
      {options.map(h => (
        <button key={h.id} className={value === h.id ? 'on' : ''} onClick={() => onPick(h.id)} title={titleFor?.(h.id) ?? harnessLabel(h.id)}>
          {h.id !== 'mode' && <HarnessIcon id={h.id} size={13} />}
          {h.label}
        </button>
      ))}
    </div>
  );
}

function ThinkingSelect({ value, onChange }: { value: string | null; onChange: (t: string | null) => void }) {
  return (
    <label className="setting">
      <span className="setting-label">Thinking</span>
      <select className="field" value={value ?? ''} onChange={e => onChange(e.target.value || null)}>
        {THINKING.map(t => (
          <option key={t} value={t}>
            {t || 'default'}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Interactive droid has no model or thinking flag; it runs the model set in Droid itself. */
const DROID_NOTE = "Droid runs the model set in Droid's own settings.";

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

  useDismiss(box, useCallback(() => setOpen(false), []), open);

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
      <HarnessRow
        options={MODE_HARNESSES}
        value={mode.harness}
        onPick={id => set({ harness: id, model: id === mode.harness ? mode.model : null })}
        titleFor={id => (id === 'native' ? "Each harness's own built-in sub-agents" : harnessLabel(id))}
      />
      {mode.harness === 'native' ? (
        <p className="mode-line">Each harness uses its own built-in sub-agents (no panes).</p>
      ) : (
        <>
          {mode.harness === 'droid' ? <p className="mode-line">{DROID_NOTE}</p> : <ModelPicker harness={mode.harness} value={mode.model} onChange={model => set({ model })} />}
          {more && (
            <div className="row2">
              {mode.harness !== 'droid' && <ThinkingSelect value={mode.thinking} onChange={thinking => set({ thinking })} />}
              <label className="setting">
                <span className="setting-label">Run at once</span>
                <select className="field" value={settings.maxRunning} onChange={e => void patchSettings({ maxRunning: Number(e.target.value) })}>
                  {MAX_RUNNING.map(n => (
                    <option key={n} value={n}>
                      {n}
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
            {mode.model && mode.harness !== 'droid' ? (
              <>
                {' · '}
                <strong>{shortModel(mode.model)}</strong>
              </>
            ) : null}
            {mode.thinking && mode.harness !== 'droid' ? ` · ${mode.thinking}` : ''}.
          </p>
        </>
      )}
    </div>
  );
}

// A row moves to another section when its agent's status changes, which remounts it.
// Keep what the user typed and which rows they opened outside the component so neither is lost.
const drafts = new Map<string, string>();
const expanded = new Set<string>();

function Reply({ agent }: { agent: Agent }) {
  const [text, setTextState] = useState(() => drafts.get(agent.id) ?? '');
  const setText = (t: string) => {
    if (t) drafts.set(agent.id, t);
    else drafts.delete(agent.id);
    setTextState(t);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/agents/${agent.id}/message`, { body: { text } });
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
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
      {error && <p className="note reply-error">Not sent: {error}</p>}
    </>
  );
}

function stateText(a: Agent): string {
  const t = elapsed(a);
  switch (a.status) {
    case 'waiting':
      return `Needs you ${t}`;
    case 'queued':
      return 'Queued';
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
  const [open, setOpenState] = useState(agent.status === 'waiting' || expanded.has(agent.id));
  const setOpen = (next: boolean | ((o: boolean) => boolean)) =>
    setOpenState(o => {
      const v = typeof next === 'function' ? next(o) : next;
      if (v) expanded.add(agent.id);
      else expanded.delete(agent.id);
      return v;
    });
  const [confirmClose, setConfirmClose] = useConfirm();
  const running = !isEnded(agent);
  useEffect(() => {
    if (agent.status === 'waiting') setOpen(true);
  }, [agent.status]);
  const sub = agent.role === 'sub';
  const title = sub ? (agent.task?.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '') ?? agent.name) : agent.title || harnessLabel(agent.harness);
  const subtitle = [
    sub ? agent.name : folderName(agent.cwd),
    `${harnessLabel(agent.harness)}${agent.model ? ` · ${shortModel(agent.model)}` : ''}`,
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
          <span className="row-sub">{agent.progress && isRunning(agent) ? agent.progress : subtitle}</span>
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
          {agent.result ? <pre className="result">{agent.result}</pre> : sub && <p className="note">{isRunning(agent) ? 'Working. The report shows up here when it finishes.' : 'No report.'}</p>}
          {agent.worktree && (
            <p className="note">
              <Icon.Branch size={12} /> {agent.worktree.branch}
            </p>
          )}
          {running && <Reply agent={agent} />}
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
      <HarnessRow
        options={REVIEW_HARNESSES}
        value={review.harness}
        onPick={id => set({ harness: id, model: id === review.harness ? review.model : null })}
        titleFor={id => (id === 'mode' ? 'Same as the sub-agent mode' : harnessLabel(id))}
      />
      {!same && (review.harness === 'droid' ? <p className="mode-line">{DROID_NOTE}</p> : <ModelPicker harness={review.harness} value={review.model} onChange={model => set({ model })} />)}
      {more && (
        <>
          {!same && review.harness !== 'droid' && <ThinkingSelect value={review.thinking} onChange={thinking => set({ thinking })} />}
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
        {!same && review.model && review.harness !== 'droid' ? (
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
  useTick(agents.some(isRunning));
  // Forget drafts and open rows of agents that are gone.
  useEffect(() => {
    const ids = new Set(agents.map(a => a.id));
    for (const id of drafts.keys()) if (!ids.has(id)) drafts.delete(id);
    for (const id of expanded) if (!ids.has(id)) expanded.delete(id);
  }, [agents]);
  const needs = agents.filter(a => a.status === 'waiting');
  const working = agents.filter(isRunning);
  const queued = agents.filter(a => a.status === 'queued');
  const done = agents.filter(a => a.role === 'sub' && a.status === 'done');
  const idle = agents.filter(a => a.role === 'main' && ['idle', 'done'].includes(a.status));
  const ended = agents.filter(isEnded);
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
      <ResizeHandle panel="dash" />
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
        {group('Queued', queued)}
        {group('Done', done)}
        {group('Idle', idle)}
        {group('Ended', ended)}
      </div>
    </aside>
  );
}
