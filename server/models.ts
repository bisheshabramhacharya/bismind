/**
 * Model suggestions per harness, read from each CLI's own catalog so the picker only
 * offers models that are actually connected. Free-typed models are always allowed.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { HOME, readJson } from './config.ts';
import { harnesses } from './harnesses.ts';

export interface ModelOption {
  id: string;
  label: string;
  group: string;
}

const TTL = 10 * 60_000;
const cache = new Map<string, { at: number; models: ModelOption[] }>();

function run(bin: string, args: string[]): Promise<string> {
  return new Promise(resolve => execFile(bin, args, { timeout: 25_000, maxBuffer: 8 * 1024 * 1024 }, (_e, out) => resolve(out ?? '')));
}

async function load(id: string): Promise<ModelOption[]> {
  const bin = harnesses().find(h => h.id === id)?.bin;
  if (!bin) return [];
  switch (id) {
    case 'pi': {
      const out = await run(bin, ['--list-models']);
      return out
        .split('\n')
        .slice(1)
        .map(l => l.trim().split(/\s+/))
        .filter(cols => cols.length >= 2 && cols[0] !== 'provider')
        .map(([provider, model]) => ({ id: `${provider}/${model}`, label: model, group: provider }));
    }
    case 'codex': {
      const data = readJson<{ models?: { slug?: string; display_name?: string }[] }>(join(HOME, '.codex', 'models_cache.json'), {});
      const list = (data.models ?? []).map(m => m.slug).filter((s): s is string => Boolean(s));
      return list.map(slug => ({ id: slug, label: slug, group: 'OpenAI' }));
    }
    case 'claude':
      return [
        ['opus', 'Opus (latest)'],
        ['sonnet', 'Sonnet (latest)'],
        ['haiku', 'Haiku (latest)'],
        ['claude-opus-5-5', 'Claude Opus 5.5'],
        ['claude-fable-5-1', 'Claude Fable 5.1'],
        ['claude-sonnet-5', 'Claude Sonnet 5'],
        ['claude-haiku-4-5', 'Claude Haiku 4.5'],
      ].map(([mid, label]) => ({ id: mid, label, group: 'Anthropic' }));
    case 'devin': {
      const out = await run(bin, ['models', 'list', '--format', 'json']);
      try {
        const data = JSON.parse(out) as { families: { family_label: string; variants: { model_uid: string; label: string }[] }[] };
        return data.families.flatMap(f => f.variants.map(v => ({ id: v.model_uid, label: v.label, group: f.family_label })));
      } catch {
        return [];
      }
    }
    default:
      return [];
  }
}

export async function modelsFor(id: string, refresh = false): Promise<ModelOption[]> {
  const hit = cache.get(id);
  if (hit && !refresh && Date.now() - hit.at < TTL) return hit.models;
  const models = await load(id);
  cache.set(id, { at: Date.now(), models });
  return models;
}
