import { useEffect, useState } from 'react';

async function api<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed: ${response.status}`);
  return data as T;
}

export async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Request failed: ${response.status}`);
  return data as T;
}

/** Keeps showing the current data while a refresh for the same path is in flight. */
export function useApi<T>(path: string | null, refresh: number = 0) {
  const [state, setState] = useState<{ path: string | null; data?: T; error?: string }>({ path: null });
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>(path).then((data) => live && setState({ path, data }), (error) => live && setState({ path, error: error.message }));
    return () => { live = false; };
  }, [path, refresh]);
  const current = state.path === path;
  return { data: current ? state.data : undefined, error: current ? state.error : undefined, loading: Boolean(path) && !current };
}

export function useDebounced(value: string, onChange?: () => void) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => { setDebounced(value); onChange?.(); }, 250);
    return () => clearTimeout(timer);
  }, [value]);
  return debounced;
}

export const Failure = ({ message }: { message: string }) => <div className="panel error-box" role="alert">{message}</div>;

export function Check({ checked, onChange, disabled, children, note }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; children: string; note?: string }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}{note && <small className="subtle">{note}</small>}</span>
    </label>
  );
}
