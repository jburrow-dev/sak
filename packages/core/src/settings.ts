import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sakHome } from './db.ts';

export interface Settings {
  /** When false, nothing may call a paid API. Cached results still work. */
  paidApis: boolean;
}

const DEFAULTS: Settings = { paidApis: true };

export function readSettings(): Settings {
  let raw: string;
  try {
    raw = readFileSync(join(sakHome(), 'settings.json'), 'utf8');
  } catch {
    return { ...DEFAULTS };
  }
  try {
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // A damaged file must not turn spending back on.
    return { ...DEFAULTS, paidApis: false };
  }
}

export function writeSettings(patch: Partial<Settings>): Settings {
  const next = { ...readSettings(), ...patch };
  mkdirSync(sakHome(), { recursive: true });
  const path = join(sakHome(), 'settings.json');
  writeFileSync(`${path}.tmp`, JSON.stringify(next, null, 2));
  renameSync(`${path}.tmp`, path);
  return next;
}
