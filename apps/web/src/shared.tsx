import { useEffect, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';

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

/**
 * Keeps showing the current data while a refresh for the same path is in flight.
 * With `keep`, data also stays on screen, marked `stale`, while another path with the same `keep` value loads.
 */
export function useApi<T>(path: string | null, refresh: number = 0, keep?: string) {
  const [state, setState] = useState<{ path: string | null; keep?: string; data?: T; error?: string }>({ path: null });
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>(path).then((data) => live && setState({ path, keep, data }), (error) => live && setState({ path, keep, error: error.message }));
    return () => { live = false; };
  }, [path, refresh]);
  const current = state.path === path;
  const stale = !current && Boolean(path) && keep !== undefined && state.keep === keep && state.data !== undefined;
  return { data: current || stale ? state.data : undefined, error: current ? state.error : undefined, loading: Boolean(path) && !current, stale };
}

type RouteParams = Record<string, string | number | boolean | undefined | null>;

const subscribe = (listener: () => void) => {
  window.addEventListener('popstate', listener);
  window.addEventListener('sak:navigate', listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener('sak:navigate', listener);
  };
};

/** The address holds the view, so reloads, bookmarks and the browser's Back button all work. */
export function useRoute() {
  return new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search));
}

function hrefOf(search: URLSearchParams, patch: RouteParams) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null || value === '' || value === false) search.delete(key);
    else search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : window.location.pathname;
}

/** A link to a different view, with nothing carried over from this one. */
export const hrefFor = (params: RouteParams = {}) => hrefOf(new URLSearchParams(), params);
/** A link to this view with some values changed. */
export const hrefWith = (patch: RouteParams) => hrefOf(new URLSearchParams(window.location.search), patch);

export function navigate(href: string, options: { replace?: boolean } = {}) {
  if (options.replace) window.history.replaceState(window.history.state, '', href);
  else window.history.pushState({ internal: true }, '', href);
  window.dispatchEvent(new Event('sak:navigate'));
}

/** Goes back one step, or to `fallback` when this page was opened directly and there's nothing here to go back to. */
export function goBack(fallback: string) {
  if (window.history.state?.internal) window.history.back();
  else navigate(fallback, { replace: true });
}

export function RouteLink({ href, className, children, title, current }: { href: string; className?: string; children: ReactNode; title?: string; current?: boolean }) {
  const open = (event: MouseEvent) => {
    event.stopPropagation(); // Rows that are links as well shouldn't navigate twice.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  };
  return <a href={href} className={className} title={title} aria-current={current ? 'page' : undefined} onClick={open}>{children}</a>;
}

export function useDebounced(value: string, onChange?: () => void) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => { setDebounced(value); onChange?.(); }, 250);
    return () => clearTimeout(timer);
  }, [value]);
  return debounced;
}

export const TableSkeleton = () => (
  <div className="panel skeleton" role="status" aria-label="Loading">{[0, 1, 2, 3, 4, 5].map((row) => <div key={row} />)}</div>
);

export const Failure = ({ message }: { message: string }) => <div className="panel error-box" role="alert">{message}</div>;

export function Check({ checked, onChange, disabled, children, note }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; children: string; note?: string }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}{note && <small className="subtle">{note}</small>}</span>
    </label>
  );
}
