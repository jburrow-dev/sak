import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ConnectionsView, TrafficFields, TrafficStrip, trafficFromForm, type TrafficForm } from './Integrations.tsx';
import { Check, Failure, RouteLink, TableSkeleton, goBack, hrefFor, hrefWith, navigate, post, useApi, useRoute } from './shared.tsx';

function query(params: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
  return search.toString();
}

interface Crawl { id: string; startUrl: string | null; status: string | null; startedAt: string | null; pages: number; fetched: number; pending: number; issues: number; error: string | null; trafficStatus: string | null; running: boolean }
interface Summary { type: string; severity: string; title: string; fix: string; count: number }
interface PageOf<T> { total: number; offset: number; limit: number; items: T[] }
interface Issue { type: string; severity: string; url: string; detail: string | null }
interface UrlRow { url: string; kind: string; status: number | null; depth: number | null; indexable: number | null; indexability_reason: string | null; title: string | null; word_count: number | null; inlinks: number; issue_count: number; response_ms: number | null; clicks: number | null; impressions: number | null; position: number | null; sessions: number | null; bing_clicks: number | null; error: string | null }
interface Link { url: string; type: string; anchor: string | null; nofollow: number; status: number | null }
interface ElementColumn { key: string; label: string; type: 'url' | 'text' | 'number' | 'status' | 'bytes' | 'yesno' }
interface ElementInfo { key: string; label: string; columns: ElementColumn[]; filters: { key: string; label: string }[] }
interface Settings { paidApis: boolean; monthlyBudgetUsd: number; runBudgetUsd: number; prices: { keywordVolume: number; backlinkSummary: number; rankCheck: number } }

const hostOf = (url: string | null) => { try { return url ? new URL(url).host : 'Unknown'; } catch { return url ?? 'Unknown'; } };
const siteOf = (url: string | null) => hostOf(url).replace(/^www\./, '');
const plural = (count: number, word: string) => `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;

/** Times are stored in UTC. Recent ones read better as "3 hours ago", and the rest in the viewer's own time zone. */
function formatWhen(iso: string | null): string {
  if (!iso) return 'Unknown date';
  const date = new Date(iso);
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes >= 0 && minutes < 1440) {
    const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    return minutes < 60 ? relative.format(-minutes, 'minute') : relative.format(-Math.round(minutes / 60), 'hour');
  }
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Two decimals, except for amounts so small that two would round them away. */
const money = (value: number) => (value > 0 && value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`);

const ROW_FILTERS = ['type', 'sev', 'q', 'sort', 'desc', 'offset', 'el', 'filter', 'kind', 'index', 'before', 'url'];
/** A link that leaves the current list, dropping its filters but staying on this crawl. */
const hrefClearing = (patch: Record<string, string | number | undefined>) => hrefWith({ ...Object.fromEntries(ROW_FILTERS.map((key) => [key, undefined])), ...patch });

/** The typed text updates at once, and the address follows after a pause without adding a history step per letter. */
function useSearchBox(route: URLSearchParams) {
  const applied = route.get('q') ?? '';
  const [text, setText] = useState(applied);
  useEffect(() => setText(applied), [applied]);
  useEffect(() => {
    if (text === applied) return;
    const timer = setTimeout(() => navigate(hrefWith({ q: text, offset: undefined }), { replace: true }), 250);
    return () => clearTimeout(timer);
  }, [text]);
  return { text, setText, applied };
}

function useRouteSort(route: URLSearchParams, fallback = '') {
  const sort = route.get('sort') ?? fallback;
  const desc = route.get('desc') === 'true';
  const toggle = (key: string) => navigate(hrefWith({ sort: key, desc: sort === key ? !desc : false, offset: undefined }));
  return { sort, desc, toggle };
}

const routeOffset = (route: URLSearchParams) => Number(route.get('offset')) || 0;
const toOffset = (offset: number) => navigate(hrefWith({ offset: offset || undefined }));

function Status({ value, error }: { value: number | null; error?: string | null }) {
  if (value === null) return <span className={error ? 'status-bad' : 'subtle'}>{error ? 'failed' : 'none'}</span>;
  return <span className={value < 300 ? 'status-ok' : value < 400 ? 'status-warn' : 'status-bad'}>{value}</span>;
}

function Pager({ page, onOffset }: { page: PageOf<unknown>; onOffset: (offset: number) => void }) {
  if (page.total <= page.limit) return null;
  const end = Math.min(page.offset + page.limit, page.total);
  return (
    <div className="pager">
      <button className="btn" disabled={page.offset === 0} onClick={() => onOffset(Math.max(0, page.offset - page.limit))}>Previous</button>
      <button className="btn" disabled={end >= page.total} onClick={() => onOffset(page.offset + page.limit)}>Next</button>
      <span>{page.offset + 1} to {end} of {page.total}</span>
    </div>
  );
}

const formatBytes = (value: number) => (value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`);

function SortHeader({ label, name, numeric, sort, onSort }: { label: string; name: string; numeric?: boolean; sort: { sort: string; desc: boolean }; onSort: (key: string) => void }) {
  const active = sort.sort === name;
  return (
    <th className={`sortable ${numeric ? 'num' : ''}`} aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button className="th-button" onClick={() => onSort(name)}>{label}{active ? (sort.desc ? ' ↓' : ' ↑') : ''}</button>
    </th>
  );
}

const SEVERITY_RANK: Record<string, number> = { error: 0, warning: 1, notice: 2 };

const ResultCount = ({ total }: { total: number }) => <p className="sr-only" role="status">{plural(total, 'result')}</p>;

function IssuesView({ crawl, summary, route }: { crawl: string; summary: Summary[]; route: URLSearchParams }) {
  const type = route.get('type');
  const severity = route.get('sev') ?? '';
  const offset = routeOffset(route);
  const { text, setText, applied } = useSearchBox(route);
  const sort = useRouteSort(route, type ? '' : 'severity');
  const { data, error, stale } = useApi<PageOf<Issue>>(type ? `/api/crawls/${crawl}/issues?${query({ type, offset, limit: 100, search: applied, sort: sort.sort, desc: sort.desc })}` : null, 0, type ?? undefined);

  if (type) {
    const definition = summary.find((s) => s.type === type);
    return (
      <>
        <div className="toolbar">
          <RouteLink className="btn" href={hrefClearing({ sev: severity || undefined })}>All issues</RouteLink>
          <b>{definition?.title}</b>
          <input aria-label="Search this issue" placeholder="Search URL or detail" value={text} onChange={(e) => setText(e.target.value)} />
          <a className="btn push-right" href={`/api/crawls/${crawl}/issues.csv?${query({ type, search: applied, sort: sort.sort, desc: sort.desc })}`} download>Export CSV</a>
        </div>
        {definition?.fix && <p className="subtle">{definition.fix}</p>}
        {error && <Failure message={error} />}
        {!data && !error && <TableSkeleton />}
        {data && (
          <>
            <ResultCount total={data.total} />
            <div className={`panel table-scroll ${stale ? 'stale' : ''}`} aria-busy={stale}>
              <table>
                <thead><tr><SortHeader label="URL" name="url" sort={sort} onSort={sort.toggle} /><SortHeader label="Detail" name="detail" sort={sort} onSort={sort.toggle} /></tr></thead>
                <tbody>{data.items.map((issue, i) => (
                  <tr key={i} className="clickable" onClick={() => navigate(hrefWith({ url: issue.url }))}>
                    <td className="url"><RouteLink className="row-link" href={hrefWith({ url: issue.url })}>{issue.url}</RouteLink></td><td className="url">{issue.detail}</td>
                  </tr>
                ))}</tbody>
              </table>
              {data.items.length === 0 && <div className="empty">Nothing matches.</div>}
            </div>
            <Pager page={data} onOffset={toOffset} />
          </>
        )}
      </>
    );
  }
  if (summary.length === 0) return <div className="panel empty">No issues recorded yet.</div>;
  const order = (a: Summary, b: Summary) => {
    if (sort.sort === 'count') return a.count - b.count;
    if (sort.sort === 'title') return a.title.localeCompare(b.title);
    return (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) || b.count - a.count;
  };
  const shown = summary.filter((row) => !severity || row.severity === severity).sort((a, b) => (sort.desc ? order(b, a) : order(a, b)));
  return (
    <>
      <div className="toolbar">
        <div className="chips" role="group" aria-label="Filter by severity">
          {['', 'error', 'warning', 'notice'].map((value) => (
            <button key={value} className={`chip ${severity === value ? 'active' : ''}`} aria-pressed={severity === value} onClick={() => navigate(hrefWith({ sev: value }))}>
              {value ? `${value[0].toUpperCase()}${value.slice(1)}s` : 'All'} <span>{summary.filter((row) => !value || row.severity === value).reduce((sum, row) => sum + row.count, 0).toLocaleString('en-US')}</span>
            </button>
          ))}
        </div>
        <a className="btn push-right" href={`/api/crawls/${crawl}/issues.csv?${query({ severity })}`} download>Export CSV</a>
      </div>
      <div className="panel table-scroll">
        <table>
          <thead><tr><SortHeader label="Severity" name="severity" sort={sort} onSort={sort.toggle} /><SortHeader label="Issue" name="title" sort={sort} onSort={sort.toggle} /><SortHeader label="URLs" name="count" numeric sort={sort} onSort={sort.toggle} /></tr></thead>
          <tbody>{shown.map((row) => {
            const href = hrefWith({ type: row.type, sort: undefined, desc: undefined, offset: undefined, q: undefined });
            return (
              <tr key={row.type} className="clickable" onClick={() => navigate(href)}>
                <td><span className={`sev ${row.severity}`}>{row.severity}</span></td>
                <td><RouteLink className="row-link" href={href}>{row.title}</RouteLink><small className="subtle block">{row.fix}</small></td>
                <td className="num">{row.count.toLocaleString('en-US')}</td>
              </tr>
            );
          })}</tbody>
        </table>
        {shown.length === 0 && <div className="empty">No {severity} issues.</div>}
      </div>
    </>
  );
}

function ElementCell({ column, row }: { column: ElementColumn; row: Record<string, any> }) {
  const value = row[column.key];
  switch (column.type) {
    case 'status': return <td className="num"><Status value={value} error={row.error} /></td>;
    case 'number': return <td className="num">{value}</td>;
    case 'bytes': return <td className="num">{value === null || value === undefined ? '' : formatBytes(value)}</td>;
    case 'yesno': return <td>{value === 1 ? 'Yes' : value === 0 ? 'No' : ''}</td>;
    case 'url': return <td className="url">{value === row.url ? <RouteLink className="row-link" href={hrefWith({ url: row.url })}>{value}</RouteLink> : value}</td>;
    default: return <td className="text-cell">{value}</td>;
  }
}

const ELEMENT_GROUPS: { label: string; keys: string[] }[] = [
  { label: 'Technical', keys: ['internal', 'external', 'response', 'canonical', 'directives', 'hreflang', 'javascript', 'links', 'images', 'css', 'scripts'] },
  { label: 'On-page', keys: ['title', 'meta', 'h1', 'h2', 'head'] },
  { label: 'Content', keys: ['content', 'schema'] },
  { label: 'AI', keys: ['ai-readiness', 'ai-bots', 'ai-citations', 'ai-traffic', 'ai-search', 'ai-queries'] },
  { label: 'Search data', keys: ['search', 'queries', 'index-status', 'not-in-crawl', 'speed', 'gbp'] },
];

/** These views stay empty until their data is collected, and most of that can't be started from this screen yet. */
function elementHint(key: string, crawl: string): ReactNode {
  const code = (command: string) => <code>{command}</code>;
  const fromPull = 'Choose Add search and analytics data above this tab bar to collect this.';
  switch (key) {
    case 'gbp': return <>Collect this from the command line. It costs money and asks first: {code(`sak gbp ${crawl} "Business name" --location <code> --yes`)}</>;
    case 'speed': return <>Collect this from the command line: {code(`sak psi ${crawl}`)} and {code(`sak crux ${crawl}`)}</>;
    case 'ai-search': case 'ai-queries': return <>Export the report as a CSV, then run: {code(`sak ai-import ${crawl} --source gsc|bing --file report.csv`)}</>;
    case 'ai-citations': return <>Start a crawl from the command line with {code('--ai-overview')} or {code('--llm')}. These cost money and ask first.</>;
    case 'search': case 'queries': case 'index-status': case 'not-in-crawl': case 'ai-traffic': return fromPull;
    default: return null;
  }
}

function ElementsView({ crawl, refresh, route }: { crawl: string; refresh: number; route: URLSearchParams }) {
  const { data: catalog, error: catalogError } = useApi<ElementInfo[]>('/api/elements');
  const key = route.get('el') ?? 'title';
  const filter = route.get('filter') ?? 'all';
  const offset = routeOffset(route);
  const { text, setText, applied } = useSearchBox(route);
  const sort = useRouteSort(route);
  const params = query({ filter, search: applied, sort: sort.sort, desc: sort.desc });
  const { data, error, stale } = useApi<{ counts: Record<string, number>; page: PageOf<Record<string, any>> }>(`/api/crawls/${crawl}/elements/${key}?${params}&${query({ offset, limit: 100 })}`, refresh, key);
  if (catalogError) return <Failure message={catalogError} />;
  if (!catalog) return <TableSkeleton />;
  const element = catalog.find((e) => e.key === key);
  if (!element) return <Failure message={`There is no element view called ${key}.`} />;
  const known = new Set(ELEMENT_GROUPS.flatMap((group) => group.keys));
  const groups = [...ELEMENT_GROUPS, { label: 'Other', keys: catalog.map((e) => e.key).filter((k) => !known.has(k)) }];
  const hint = data && data.page.total === 0 && filter === 'all' && !applied ? elementHint(key, crawl) : null;
  return (
    <div className="elements">
      <nav className="element-rail" aria-label="SEO elements">
        {groups.map((group) => (
          <div key={group.label} className="contents">
            {group.keys.length > 0 && <div className="rail-heading">{group.label}</div>}
            {group.keys.map((k) => catalog.find((e) => e.key === k)).filter((e) => e !== undefined).map((e) => (
              <RouteLink key={e.key} className={`element-item ${e.key === key ? 'active' : ''}`} current={e.key === key} href={hrefWith({ el: e.key, filter: undefined, q: undefined, sort: undefined, desc: undefined, offset: undefined })}>{e.label}</RouteLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="element-main">
        <div className="chips" role="group" aria-label={`Filter ${element.label}`}>
          {element.filters.map((f) => (
            <button key={f.key} className={`chip ${filter === f.key ? 'active' : ''}`} aria-pressed={filter === f.key} onClick={() => navigate(hrefWith({ filter: f.key === 'all' ? undefined : f.key, offset: undefined }))}>
              {f.label} <span>{data?.counts[f.key]?.toLocaleString('en-US') ?? ''}</span>
            </button>
          ))}
        </div>
        <div className="toolbar">
          <input aria-label={`Search ${element.label}`} placeholder={`Search ${element.label.toLowerCase()}`} value={text} onChange={(e) => setText(e.target.value)} />
          <a className="btn" href={`/api/crawls/${crawl}/elements/${key}.csv?${params}`} download>Export CSV</a>
        </div>
        {error && <Failure message={error} />}
        {!data && !error && <TableSkeleton />}
        {data && (
          <>
            <ResultCount total={data.page.total} />
            <div className={`panel table-scroll ${stale ? 'stale' : ''}`} aria-busy={stale}>
              <table>
                <thead><tr>{element.columns.map((c) => <SortHeader key={c.key} label={c.label} name={c.key} numeric={c.type === 'number' || c.type === 'status' || c.type === 'bytes'} sort={sort} onSort={sort.toggle} />)}</tr></thead>
                <tbody>{data.page.items.map((row) => (
                  <tr key={row.id} className="clickable" onClick={() => navigate(hrefWith({ url: row.url }))}>{element.columns.map((c) => <ElementCell key={c.key} column={c} row={row} />)}</tr>
                ))}</tbody>
              </table>
              {data.page.items.length === 0 && (hint ? <p className="hint">{hint}</p> : <div className="empty">Nothing matches.</div>)}
            </div>
            <Pager page={data.page} onOffset={toOffset} />
          </>
        )}
      </div>
    </div>
  );
}

const COLUMNS: { key: string; label: string; numeric?: boolean; source?: string; fixed?: boolean }[] = [
  { key: 'url', label: 'URL', fixed: true }, { key: 'status', label: 'Status', numeric: true }, { key: 'title', label: 'Title' }, { key: 'depth', label: 'Depth', numeric: true },
  { key: 'inlinks', label: 'Inlinks', numeric: true }, { key: 'word_count', label: 'Words', numeric: true }, { key: 'issue_count', label: 'Issues', numeric: true },
  { key: 'clicks', label: 'GSC clicks', numeric: true, source: 'gsc' }, { key: 'impressions', label: 'GSC impressions', numeric: true, source: 'gsc' }, { key: 'position', label: 'GSC position', numeric: true, source: 'gsc' },
  { key: 'sessions', label: 'GA4 sessions', numeric: true, source: 'ga4' }, { key: 'bing_clicks', label: 'Bing clicks', numeric: true, source: 'bing' },
];

const HIDDEN_COLUMNS_KEY = 'sak.hiddenUrlColumns';

function readHiddenColumns(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HIDDEN_COLUMNS_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function UrlCell({ name, row }: { name: string; row: UrlRow }) {
  switch (name) {
    case 'url': return <td className="url"><RouteLink className="row-link" href={hrefWith({ url: row.url })}>{row.url}</RouteLink></td>;
    case 'status': return <td className="num"><Status value={row.status} error={row.error} /></td>;
    case 'title': return <td className="url">{row.title}</td>;
    case 'position': return <td className="num">{row.position === null ? '' : row.position.toFixed(1)}</td>;
    default: return <td className="num">{row[name as keyof UrlRow]}</td>;
  }
}

function UrlsView({ crawl, refresh, route }: { crawl: string; refresh: number; route: URLSearchParams }) {
  const { text, setText, applied } = useSearchBox(route);
  const kind = route.get('kind') ?? 'page';
  const indexable = route.get('index') ?? '';
  const sort = useRouteSort(route, 'id');
  const offset = routeOffset(route);
  const [hidden, setHidden] = useState(readHiddenColumns);
  const { data, error, stale } = useApi<PageOf<UrlRow>>(`/api/crawls/${crawl}/urls?${query({ search: applied, kind: kind === 'all' ? '' : kind, indexable, sort: sort.sort, desc: sort.desc, offset, limit: 100 })}`, refresh, 'urls');
  const { data: traffic } = useApi<{ pulls: { source: string }[] }>(`/api/crawls/${crawl}/traffic`, refresh);
  const pulled = new Set(traffic?.pulls.map((pull) => pull.source));
  const available = COLUMNS.filter((column) => !column.source || pulled.has(column.source));
  const shown = available.filter((column) => column.fixed || !hidden.includes(column.key));
  const toggleColumn = (key: string, show: boolean) => {
    const next = show ? hidden.filter((name) => name !== key) : [...hidden, key];
    setHidden(next);
    try { localStorage.setItem(HIDDEN_COLUMNS_KEY, JSON.stringify(next)); } catch { /* The choice just won't be remembered. */ }
  };
  const params = query({ search: applied, kind: kind === 'all' ? '' : kind, indexable, sort: sort.sort === 'id' ? '' : sort.sort, desc: sort.desc });
  return (
    <>
      <div className="toolbar">
        <input aria-label="Search URLs and titles" placeholder="Search URL or title" value={text} onChange={(e) => setText(e.target.value)} />
        <select aria-label="URL type" value={kind} onChange={(e) => navigate(hrefWith({ kind: e.target.value === 'page' ? undefined : e.target.value, offset: undefined }))}>
          <option value="page">Internal</option><option value="external">External</option><option value="image">Images</option><option value="css">CSS</option><option value="script">Scripts</option><option value="all">All</option>
        </select>
        <select aria-label="Indexability" value={indexable} onChange={(e) => navigate(hrefWith({ index: e.target.value, offset: undefined }))}>
          <option value="">Any indexability</option><option value="true">Indexable</option><option value="false">Non-indexable</option>
        </select>
        <details className="column-picker push-right">
          <summary className="btn">Columns</summary>
          <div className="panel column-options">
            {available.filter((column) => !column.fixed).map((column) => <Check key={column.key} checked={!hidden.includes(column.key)} onChange={(show) => toggleColumn(column.key, show)}>{column.label}</Check>)}
          </div>
        </details>
        <a className="btn" href={`/api/crawls/${crawl}/urls.csv?${params}`} download>Export CSV</a>
      </div>
      {error && <Failure message={error} />}
      {!data && !error && <TableSkeleton />}
      {data && (
        <>
          <ResultCount total={data.total} />
          <div className={`panel table-scroll freeze-first ${stale ? 'stale' : ''}`} aria-busy={stale}>
            <table>
              <thead><tr>{shown.map((c) => (
                <SortHeader key={c.key} label={c.label} name={c.key} numeric={c.numeric} sort={sort} onSort={sort.toggle} />
              ))}</tr></thead>
              <tbody>{data.items.map((row) => (
                <tr key={row.url} className="clickable" onClick={() => navigate(hrefWith({ url: row.url }))}>
                  {shown.map((c) => <UrlCell key={c.key} name={c.key} row={row} />)}
                </tr>
              ))}</tbody>
            </table>
            {data.items.length === 0 && <div className="empty">No URLs match.</div>}
          </div>
          <Pager page={data} onOffset={toOffset} />
        </>
      )}
    </>
  );
}

function LinkTable({ crawl, url, direction }: { crawl: string; url: string; direction: 'in' | 'out' }) {
  const [offset, setOffset] = useState(0);
  const { data } = useApi<PageOf<Link>>(`/api/crawls/${crawl}/links?${query({ url, direction, offset, limit: 25 })}`, 0, direction);
  if (!data) return null;
  if (data.total === 0) return <p className="subtle">None.</p>;
  return (
    <>
      <div className="panel">
        <table>
          <thead><tr><th>URL</th><th>Type</th><th>Anchor</th><th className="num">Status</th></tr></thead>
          <tbody>{data.items.map((link, i) => (
            <tr key={i} className="clickable" onClick={() => navigate(hrefWith({ url: link.url }))}>
              <td className="url"><RouteLink className="row-link" href={hrefWith({ url: link.url })}>{link.url}</RouteLink></td><td>{link.type}{link.nofollow ? ' (nofollow)' : ''}</td><td>{link.anchor}</td>
              <td className="num"><Status value={link.status} /></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <Pager page={data} onOffset={setOffset} />
    </>
  );
}

function UrlDetail({ crawl, url, summary }: { crawl: string; url: string; summary: Summary[] }) {
  const { data, error } = useApi<any>(`/api/crawls/${crawl}/url?${query({ url })}`);
  const back = <button className="btn" onClick={() => goBack(hrefWith({ url: undefined }))}>Back</button>;
  if (error) return <>{back}<Failure message={error} /></>;
  if (data === null) return <>{back}<p className="subtle">This URL is not in the crawl.</p></>;
  if (!data) return <TableSkeleton />;
  const list = (value: string[] | undefined) => (value?.length ? value.join(' | ') : 'None');
  const definition = (type: string) => summary.find((row) => row.type === type);
  const searchData = data.clicks !== null || data.sessions !== null || data.bing_clicks !== null || data.inspection || data.pagespeed?.length > 0;
  return (
    <div className="detail">
      {back}
      <h2 className="url detail-url">{url} <a href={url} target="_blank" rel="noreferrer noopener">Open</a></h2>
      <h3>Issues ({data.issues.length})</h3>
      {data.issues.length === 0 ? <p className="subtle">None.</p> : (
        <div className="panel"><table><tbody>{data.issues.map((issue: any, i: number) => (
          <tr key={i}>
            <td><span className={`sev ${issue.severity}`}>{issue.severity}</span></td>
            <td>{definition(issue.type)?.title ?? issue.type}{definition(issue.type)?.fix && <small className="subtle block">{definition(issue.type)?.fix}</small>}</td>
            <td className="url">{issue.detail}</td>
          </tr>
        ))}</tbody></table></div>
      )}
      <h3>Response</h3>
      <dl className="kv">
        <dt>Status</dt><dd><Status value={data.status} error={data.error} />{data.error ? ` ${data.error}` : ''}</dd>
        <dt>Indexable</dt><dd>{data.indexable === 1 ? 'Yes' : data.indexable === 0 ? `No (${data.indexability_reason})` : 'Not assessed'}</dd>
        <dt>Canonical</dt><dd>{data.canonical ?? 'None'}</dd>
        <dt>Meta robots</dt><dd>{list(data.elements?.meta_robots)}</dd>
        <dt>Depth</dt><dd>{data.depth ?? 'Not linked from the start URL'}</dd>
        <dt>Response time</dt><dd>{data.response_ms ?? 'None'}{data.response_ms !== null ? ' ms' : ''}</dd>
        {data.bytes !== null && <><dt>Size</dt><dd>{formatBytes(data.bytes)}</dd></>}
        {data.rendering?.rendered === 1 && <><dt>JS-only links</dt><dd>{data.rendering.js_only_links}</dd></>}
        {data.rendering?.render_error && <><dt>Render error</dt><dd>{data.rendering.render_error}</dd></>}
      </dl>
      <h3>On-page</h3>
      <dl className="kv">
        <dt>Title</dt><dd>{list(data.elements?.titles)}</dd>
        <dt>Meta description</dt><dd>{list(data.elements?.meta_descriptions)}</dd>
        <dt>H1</dt><dd>{list(data.elements?.h1s)}</dd>
        {data.elements?.h2s?.length > 0 && <><dt>H2</dt><dd><ul className="plain-rows">{data.elements.h2s.map((heading: string, i: number) => <li key={i}>{heading}</li>)}</ul></dd></>}
        <dt>Words</dt><dd>{data.word_count ?? 'None'}{data.rendering?.rendered ? ` rendered, ${data.rendering.raw_word_count} as served` : ''}</dd>
      </dl>
      {searchData && (
        <>
          <h3>Search data</h3>
          <dl className="kv">
            {data.clicks !== null && <><dt>Search Console</dt><dd>{data.clicks} clicks, {data.impressions} impressions, CTR {((data.ctr ?? 0) * 100).toFixed(1)}%, average position {data.position?.toFixed(1)}</dd></>}
            {data.sessions !== null && <><dt>GA4</dt><dd>{data.sessions} sessions, {data.engaged_sessions} engaged, {data.users ?? 'no'} users, {data.views ?? 'no'} views, {data.key_events ?? 'no'} key events</dd></>}
            {data.bing_clicks !== null && <><dt>Bing</dt><dd>{data.bing_clicks} clicks, {data.bing_impressions} impressions, average position {data.bing_position?.toFixed(1)}</dd></>}
            {data.inspection && <><dt>Google index status</dt><dd>{data.inspection.error ?? `${data.inspection.coverage_state ?? data.inspection.verdict}${data.inspection.last_crawl_time ? `, last crawled ${data.inspection.last_crawl_time.slice(0, 10)}` : ''}`}</dd></>}
            {data.inspection?.google_canonical && <><dt>Google canonical</dt><dd>{data.inspection.google_canonical}</dd></>}
            {data.pagespeed?.map((p: any) => <span key={p.strategy} className="contents"><dt>PageSpeed ({p.strategy})</dt><dd>{p.performance}, LCP {Math.round(p.lcp_ms ?? 0)} ms, CLS {p.cls?.toFixed(3)}</dd></span>)}
          </dl>
        </>
      )}
      {data.top_queries.length > 0 && (
        <><h3>Top queries</h3><div className="panel"><table><thead><tr><th>Query</th><th className="num">Clicks</th><th className="num">Impressions</th><th className="num">Position</th></tr></thead>
          <tbody>{data.top_queries.map((q: any) => <tr key={q.query}><td>{q.query}</td><td className="num">{q.clicks}</td><td className="num">{q.impressions}</td><td className="num">{q.position.toFixed(1)}</td></tr>)}</tbody></table></div></>
      )}
      {data.redirect_chain.length > 0 && (
        <><h3>Redirect path</h3><ol>{data.redirect_chain.map((hop: any) => <li key={hop.hop} className="url">{hop.url} {hop.status && <Status value={hop.status} />}</li>)}</ol></>
      )}
      {data.hreflang.length > 0 && (
        <><h3>Hreflang</h3><ul>{data.hreflang.map((h: any, i: number) => <li key={i} className="url">{h.lang}: {h.href}</li>)}</ul></>
      )}
      <h3>Inlinks</h3>
      <LinkTable key={`in-${url}`} crawl={crawl} url={url} direction="in" />
      <h3>Outlinks</h3>
      <LinkTable key={`out-${url}`} crawl={crawl} url={url} direction="out" />
    </div>
  );
}

const runLabel = (crawl: Crawl) => `${formatWhen(crawl.startedAt)} · ${plural(crawl.pages, 'URL')}`;

function CompareView({ crawl, crawls, route, summary }: { crawl: string; crawls: Crawl[]; route: URLSearchParams; summary: Summary[] }) {
  const current = crawls.find((c) => c.id === crawl);
  const others = crawls.filter((c) => c.id !== crawl);
  const site = siteOf(current?.startUrl ?? null);
  const sameSite = others.filter((c) => siteOf(c.startUrl) === site);
  const otherSites = others.filter((c) => siteOf(c.startUrl) !== site);
  // The list is newest first, so the first older run of this site is the natural "before".
  const previous = sameSite.find((c) => (c.startedAt ?? '') < (current?.startedAt ?? ''));
  const before = route.get('before') ?? previous?.id ?? '';
  const { data, error, loading } = useApi<any>(before ? `/api/compare?${query({ before, after: crawl })}` : null);
  if (others.length === 0) return <div className="panel empty">Run a second crawl to compare it with this one.</div>;
  const open = (url: string) => hrefWith({ url });
  const section = (title: string, items: any[], render: (item: any) => string, urlOf?: (item: any) => string) => (
    <>
      <h3>{title} ({items.length.toLocaleString('en-US')})</h3>
      {items.length > 0 && <div className="panel"><table><tbody>{items.slice(0, 500).map((item, i) => (
        <tr key={i}><td className="url">{urlOf ? <RouteLink className="row-link" href={open(urlOf(item))}>{render(item)}</RouteLink> : render(item)}</td></tr>
      ))}</tbody></table></div>}
      {items.length > 500 && <p className="subtle">Showing the first 500. Use the CLI for all of them.</p>}
    </>
  );
  const issueName = (type: string) => summary.find((row) => row.type === type)?.title ?? type;
  return (
    <div className="detail">
      <div className="toolbar">
        <label htmlFor="before">Compare this crawl with:</label>
        <select id="before" value={before} onChange={(e) => navigate(hrefWith({ before: e.target.value }))}>
          <option value="">Choose a crawl</option>
          {sameSite.length > 0 && <optgroup label={site}>{sameSite.map((c) => <option key={c.id} value={c.id}>{runLabel(c)}</option>)}</optgroup>}
          {otherSites.length > 0 && <optgroup label="Other sites">{otherSites.map((c) => <option key={c.id} value={c.id}>{siteOf(c.startUrl)} · {runLabel(c)}</option>)}</optgroup>}
        </select>
      </div>
      {error && <Failure message={error} />}
      {loading && <TableSkeleton />}
      {data && (
        <>
          <div className="stats">
            <div className="stat"><b>{data.urlsAdded.length.toLocaleString('en-US')}</b><span>URLs added</span></div>
            <div className="stat"><b>{data.urlsRemoved.length.toLocaleString('en-US')}</b><span>URLs removed</span></div>
            <div className="stat"><b>{data.changed.length.toLocaleString('en-US')}</b><span>Changes</span></div>
            <div className="stat"><b>{data.issuesAdded.length.toLocaleString('en-US')}</b><span>New issues</span></div>
            <div className="stat"><b>{data.issuesResolved.length.toLocaleString('en-US')}</b><span>Resolved issues</span></div>
          </div>
          {section('URLs added', data.urlsAdded, (u) => u, (u) => u)}
          {section('URLs removed', data.urlsRemoved, (u) => u)}
          {section('Changes', data.changed, (c) => `${c.url}: ${c.field} changed from ${c.before} to ${c.after}`, (c) => c.url)}
          {section('New issues', data.issuesAdded, (i) => `${issueName(i.type)}: ${i.url}${i.detail ? ` (${i.detail})` : ''}`, (i) => i.url)}
          {section('Resolved issues', data.issuesResolved, (i) => `${issueName(i.type)}: ${i.url}${i.detail ? ` (${i.detail})` : ''}`)}
        </>
      )}
    </div>
  );
}

function PaidValue({ kind, value }: { kind: string; value: any }) {
  if (kind === 'backlinks') return <span>{value.backlinks ?? 'No'} backlinks from {value.referring_domains ?? 0} domains, rank {value.rank ?? 'none'}{value.spam_score !== null ? `, spam score ${value.spam_score}` : ''}</span>;
  if (kind === 'ai_overview') return <span>Cited in AI Overviews for {value.total ?? value.keywords?.length ?? 0} keywords. See AI citations in the Elements tab.</span>;
  if (kind === 'llm_pages') return <span>{(value as any[]).filter((row) => row.own).length} of your pages among {(value as any[]).length} cited pages.</span>;
  if (kind === 'llm_citations') {
    return <ul className="plain-list">{(value as any[]).map((row) => <li key={row.target}>{row.target}: {row.mentions ?? 'no'} citations</li>)}</ul>;
  }
  if (kind === 'ai_mode') {
    return <ul className="plain-list">{(value as any[]).map((row) => <li key={row.keyword}>{row.keyword}: {row.cited ? 'cited' : row.answer ? 'answered, not cited' : 'no AI answer'}</li>)}</ul>;
  }
  return (
    <ul className="plain-list">{(value as any[]).map((row) => (
      <li key={row.keyword}>{row.keyword}: {kind === 'rank' ? `${row.position ? `position ${row.position}` : 'not in the top 10'}${row.ai_cited ? ', cited in the AI Overview' : row.ai_overview ? ', AI Overview without you' : ''}` : `${row.search_volume ?? 'no'} searches a month`}</li>
    ))}</ul>
  );
}

function SearchDataView({ crawl, refresh }: { crawl: string; refresh: number }) {
  const { data, error } = useApi<{ kind: string; key: string; value: any; cost: number; cached: number; error: string | null }[]>(`/api/crawls/${crawl}/paid`, refresh);
  const labels: Record<string, string> = { backlinks: 'Backlinks', volume: 'Search volume', rank: 'Google rank', ai_overview: 'AI Overview keywords', ai_mode: 'AI Mode', llm_citations: 'AI citations', llm_pages: 'AI-cited pages', budget: 'Spending limit' };
  if (error) return <Failure message={error} />;
  if (!data) return <TableSkeleton />;
  if (data.length === 0) return <div className="panel empty">This crawl did not collect any backlink, rank or AI citation data. Turn on paid data in the New crawl form to collect it.</div>;
  return (
    <div className="panel"><table><thead><tr><th>Data</th><th>Result</th><th className="num">Cost</th></tr></thead>
      <tbody>{data.map((row) => (
        <tr key={`${row.kind}-${row.key}`}>
          <td>{labels[row.kind] ?? row.kind}</td>
          <td>{row.error ? <span className="status-bad">{row.error}</span> : <PaidValue kind={row.kind} value={row.value} />}</td>
          <td className="num">{row.cached ? 'Cached' : money(row.cost)}</td>
        </tr>
      ))}</tbody></table></div>
  );
}

function endpointLabel(endpoint: string): string {
  const known: [RegExp, string][] = [
    [/search_volume\/live$/, 'Search volume'], [/^backlinks\/summary/, 'Backlink summary'], [/^serp\/google\/organic/, 'Google rank'],
    [/ranked_keywords/, 'AI Overview keywords'], [/^serp\/google\/ai_mode/, 'AI Mode'], [/llm_mentions\/target_metrics/, 'AI citations'],
    [/llm_mentions\/multi_target_metrics/, 'AI citations, compared'], [/top_mentioned_pages/, 'AI-cited pages'], [/ai_keyword_data/, 'AI search volume'],
    [/llm_responses/, 'AI model prompt'],
  ];
  return known.find(([pattern]) => pattern.test(endpoint))?.[1] ?? endpoint;
}

function UsageView() {
  const [changes, setChanges] = useState(0);
  const { data, error } = useApi<any>('/api/costs', changes);
  const { data: settings } = useApi<Settings>('/api/settings', changes);
  const [saveError, setSaveError] = useState<string | null>(null);
  if (error) return <Failure message={error} />;
  if (!data) return <TableSkeleton />;
  const setPaid = (paidApis: boolean) => {
    setSaveError(null);
    post('/api/settings', { paidApis }).then(() => setChanges((n) => n + 1), (e) => setSaveError(e.message));
  };
  return (
    <div className="usage">
      <h1>Usage</h1>
      <p className="subtle">Spending across all crawls, the command line and Claude.</p>
      <div className="panel switch-row">
        <label className="switch">
          <input type="checkbox" role="switch" checked={settings?.paidApis ?? false} disabled={!settings} onChange={(e) => setPaid(e.target.checked)} />
          <span><b>Allow DataForSEO spending</b><br /><span className="subtle">{settings?.paidApis ? 'On. Crawls that ask for paid data, and sak kw, backlinks and rank, can spend after you agree to an estimate.' : 'Off. Nothing can spend, from the UI, the CLI or Claude. Cached results still work.'}</span></span>
        </label>
      </div>
      {saveError && <Failure message={saveError} />}
      <div className="stats">
        <div className="stat"><b>{money(data.total)}</b><span>Spent through SSAK</span></div>
        <div className="stat"><b>{data.calls}</b><span>Paid calls</span></div>
        <div className="stat"><b>{data.balance === null ? (settings?.paidApis === false ? 'Not checked' : 'None') : money(data.balance)}</b><span>DataForSEO balance</span></div>
        {settings && <div className="stat"><b>{money(settings.runBudgetUsd)}</b><span>Limit per run</span></div>}
        {settings && <div className="stat"><b>{money(settings.monthlyBudgetUsd)}</b><span>Limit per month</span></div>}
      </div>
      <p className="subtle">Change the limits with <code>sak budget --run 10 --monthly 100</code></p>
      {data.balanceError && <Failure message={data.balanceError} />}
      <h3>Spend by service</h3>
      {data.byEndpoint.length === 0 ? <p className="subtle">Nothing spent yet.</p> : (
        <div className="panel"><table><thead><tr><th>Service</th><th className="num">Calls</th><th className="num">Cost</th></tr></thead>
          <tbody>{data.byEndpoint.map((row: any) => (
            <tr key={row.endpoint}>
              <td>{endpointLabel(row.endpoint)}<small className="subtle block">{row.endpoint}</small></td>
              <td className="num">{row.calls}</td><td className="num">{money(row.cost)}</td>
            </tr>
          ))}</tbody></table></div>
      )}
    </div>
  );
}

const lines = (value: string) => value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);

type SavedRun = { config: Record<string, any>; traffic: any };

function NewCrawl({ from }: { from: string | null }) {
  const { data, error } = useApi<SavedRun>(from ? `/api/crawls/${from}/config` : null);
  if (error) return <Failure message={`Could not copy that crawl's settings: ${error}`} />;
  if (from && !data) return <TableSkeleton />;
  return <NewCrawlForm key={from ?? 'new'} saved={data ?? null} />;
}

function NewCrawlForm({ saved }: { saved: SavedRun | null }) {
  const { data: settings } = useApi<Settings>('/api/settings');
  const config = saved?.config;
  const [url, setUrl] = useState<string>(config?.startUrl ?? '');
  const [renderJs, setRenderJs] = useState<boolean>(config?.renderJs ?? false);
  const [checkResources, setCheckResources] = useState<boolean>(config?.checkResources ?? true);
  const [checkImages, setCheckImages] = useState<boolean>(config?.checkImages ?? true);
  const [checkExternal, setCheckExternal] = useState<boolean>(config?.checkExternal ?? true);
  const [useSitemaps, setUseSitemaps] = useState<boolean>(config?.useSitemaps ?? true);
  const [crawlSubdomains, setCrawlSubdomains] = useState<boolean>(config?.crawlSubdomains ?? false);
  const [maxUrls, setMaxUrls] = useState<string>(config?.maxUrls ? String(config.maxUrls) : '');
  const [rate, setRate] = useState<string>(config?.requestsPerSecond ? String(config.requestsPerSecond) : '');
  const [seeds, setSeeds] = useState<string>((config?.seeds ?? []).join('\n'));
  const [exclude, setExclude] = useState<string>((config?.exclude ?? []).join('\n'));
  const [paidOn, setPaidOn] = useState(false);
  const [backlinks, setBacklinks] = useState(true);
  const [volume, setVolume] = useState(false);
  const [rank, setRank] = useState(false);
  const [keywords, setKeywords] = useState('');
  const [traffic, setTraffic] = useState<TrafficForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const keywordList = lines(keywords);
  const prices = settings?.prices;
  const estimate = paidOn && prices
    ? (backlinks ? prices.backlinkSummary : 0) + (volume && keywordList.length ? prices.keywordVolume : 0) + (rank ? keywordList.length * prices.rankCheck : 0)
    : 0;
  const allowed = settings?.paidApis ?? false;
  const spends = allowed && estimate > 0;
  const blocker = !url.trim() ? 'Enter a start URL to continue.' : traffic !== null && !traffic.ready ? 'Choose a property for each selected data source, or turn the source off.' : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    post<{ id: string }>('/api/crawls', {
      url, renderJs, checkResources, checkImages, checkExternal, useSitemaps, crawlSubdomains,
      maxUrls: maxUrls || undefined, requestsPerSecond: rate || undefined, seeds: lines(seeds), exclude: lines(exclude), include: config?.include,
      ...(spends ? { paid: { backlinks, volume, rank, keywords: keywordList }, confirmed: true } : {}),
      ...(traffic ? { traffic: trafficFromForm(traffic) } : {}),
    }).then(({ id }) => navigate(hrefFor({ crawl: id }), { replace: true }), (e) => { setError(e.message); setBusy(false); });
  };

  return (
    <form className="new-crawl" onSubmit={submit}>
      <h1>{saved ? 'Run again' : 'New crawl'}</h1>
      {saved && <p className="subtle">These settings are copied from the earlier crawl. Paid data isn't copied, so turn it on below if you want it again.</p>}
      <div className="field">
        <label htmlFor="start-url">Start URL</label>
        <input id="start-url" type="text" inputMode="url" required autoFocus placeholder="https://example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
      <fieldset>
        <legend>What to crawl</legend>
        <Check checked={renderJs} onChange={setRenderJs} note="Slower. Uses your installed Chrome and blocks analytics and ad requests, so crawling doesn't add visits to the site's reports.">Render JavaScript</Check>
        <Check checked={checkResources} onChange={setCheckResources}>CSS and scripts</Check>
        <Check checked={checkImages} onChange={setCheckImages}>Images</Check>
        <Check checked={checkExternal} onChange={setCheckExternal}>External links</Check>
        <Check checked={useSitemaps} onChange={setUseSitemaps}>Sitemaps</Check>
        <Check checked={crawlSubdomains} onChange={setCrawlSubdomains}>Include subdomains</Check>
      </fieldset>
      <details open={Boolean(saved)}>
        <summary>Limits and scope</summary>
        <div className="field-row">
          <div className="field"><label htmlFor="max-urls">Maximum internal URLs</label><input id="max-urls" type="number" min="1" placeholder="10000" value={maxUrls} onChange={(e) => setMaxUrls(e.target.value)} /></div>
          <div className="field"><label htmlFor="rate">Requests per second</label><input id="rate" type="number" min="0.1" max="20" step="0.1" placeholder="2" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
        </div>
        <div className="field"><label htmlFor="seeds">Extra start URLs, one per line</label><textarea id="seeds" rows={2} value={seeds} onChange={(e) => setSeeds(e.target.value)} /></div>
        <div className="field"><label htmlFor="exclude">Exclude URLs matching these patterns, one per line</label><textarea id="exclude" rows={2} value={exclude} onChange={(e) => setExclude(e.target.value)} /></div>
      </details>
      <fieldset>
        <legend>Search and analytics data</legend>
        <TrafficFields url={url} subdomains={crawlSubdomains} initial={saved?.traffic} onChange={setTraffic} onConnections={() => navigate(hrefFor({ view: 'connections' }))} />
      </fieldset>
      <fieldset>
        <legend>Paid data</legend>
        <Check checked={paidOn && allowed} disabled={!allowed} onChange={setPaidOn} note={allowed ? 'Off by default. A crawl on its own never spends.' : 'DataForSEO spending is switched off.'}>Collect DataForSEO data when the crawl finishes</Check>
        {!allowed && settings && <RouteLink className="fit" href={hrefFor({ view: 'usage' })}>Change this in Usage</RouteLink>}
        {paidOn && allowed && (
          <div className="paid-options">
            <Check checked={backlinks} onChange={setBacklinks}>Backlink summary for this domain</Check>
            <Check checked={volume} onChange={setVolume}>Search volume for the keywords below</Check>
            <Check checked={rank} onChange={setRank}>Google rank for the keywords below</Check>
            {(volume || rank) && <div className="field"><label htmlFor="keywords">Keywords, one per line</label><textarea id="keywords" rows={3} value={keywords} onChange={(e) => setKeywords(e.target.value)} /></div>}
          </div>
        )}
      </fieldset>
      {error && <Failure message={error} />}
      <div className="toolbar">
        <button className="btn primary" disabled={busy || blocker !== null}>{spends ? `Start crawl and spend up to ${money(estimate)}` : 'Start crawl'}</button>
        <button type="button" className="btn" onClick={() => goBack(hrefFor())}>Cancel</button>
        {blocker && <span className="subtle">{blocker}</span>}
      </div>
      {spends && <p className="subtle">Cached results are free, so it may cost less.</p>}
    </form>
  );
}

function CrawlControls({ overview, onChanged }: { overview: Crawl; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const act = (action: 'pause' | 'resume') => {
    setError(null);
    post(`/api/crawls/${overview.id}/${action}`, {}).then(onChanged, (e) => setError(e.message));
  };
  const remove = () => {
    if (!window.confirm(`Delete this crawl of ${hostOf(overview.startUrl)} from ${formatWhen(overview.startedAt)}? This can't be undone.`)) return;
    setError(null);
    post(`/api/crawls/${overview.id}/delete`, {}).then(() => { navigate(hrefFor(), { replace: true }); onChanged(); }, (e) => setError(e.message));
  };
  const total = overview.fetched + overview.pending;
  const canResume = !overview.running && overview.status !== 'finished' && overview.pending > 0;
  const crawling = overview.running && overview.status === 'running';
  const pulling = overview.running && overview.trafficStatus === 'running';
  const interrupted = overview.status === 'running' && !overview.running;
  const status = pulling ? 'pulling data' : interrupted ? 'interrupted' : overview.status;
  return (
    <div className="crawl-state">
      <span className={`badge ${pulling ? 'running' : interrupted ? 'paused' : overview.status ?? ''}`}>{status ? `${status[0].toUpperCase()}${status.slice(1)}` : 'Unknown'}</span>
      <span className="subtle" aria-live="polite">
        {interrupted ? 'Or still running in another window. ' : ''}{overview.pending > 0 ? `${overview.fetched.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} URLs fetched · ` : ''}{formatWhen(overview.startedAt)}
      </span>
      {crawling && <progress max={Math.max(total, 1)} value={overview.fetched} aria-label="Crawl progress" />}
      {crawling && <button className="btn" onClick={() => act('pause')}>Pause</button>}
      {canResume && <button className="btn" onClick={() => act('resume')}>Resume</button>}
      {error && <span className="status-bad">{error}</span>}
      <div className="crawl-actions">
        <RouteLink className="btn" href={hrefFor({ view: 'new', from: overview.id })}>Run again</RouteLink>
        {!overview.running && <button className="btn" onClick={remove}>Delete</button>}
      </div>
    </div>
  );
}

const BANNER_MIN_PAGES = 5;
const BANNER_SHARE = 0.8;

/** A problem on nearly every page usually means one cause, or results that can't be trusted, so it shouldn't read as one row among many. */
function CrawlHealth({ crawl, overview, summary }: { crawl: string; overview: Crawl; summary: Summary[] }) {
  const render = summary.find((row) => row.type === 'render_failed' && row.count >= overview.pages * BANNER_SHARE);
  const { data: sample } = useApi<PageOf<Issue>>(render ? `/api/crawls/${crawl}/issues?${query({ type: render.type, limit: 1 })}` : null);
  if (overview.pages < BANNER_MIN_PAGES) return null;
  const systemic = summary.filter((row) => row.severity !== 'notice' && row.type !== 'render_failed' && row.count >= overview.pages * BANNER_SHARE);
  const of = (count: number) => `${count.toLocaleString('en-US')} of ${overview.pages.toLocaleString('en-US')}`;
  return (
    <>
      {render && (
        <div className="banner error" role="alert">
          <p><b>Rendering failed on {of(render.count)} pages.</b> These results come from the HTML as served, so anything JavaScript adds is missing.{sample?.items[0]?.detail ? <small className="subtle block">First cause: {sample.items[0].detail}</small> : null}</p>
          <RouteLink className="btn" href={hrefFor({ crawl, tab: 'issues', type: render.type })}>See pages</RouteLink>
          <RouteLink className="btn" href={hrefFor({ view: 'new', from: crawl })}>Run again</RouteLink>
        </div>
      )}
      {systemic.slice(0, 2).map((row) => (
        <div className={`banner ${row.severity}`} key={row.type}>
          <p><b>{row.title}: {of(row.count)} pages.</b> <span className="subtle">{row.fix}</span></p>
          <RouteLink className="btn" href={hrefFor({ crawl, tab: 'issues', type: row.type })}>See pages</RouteLink>
        </div>
      ))}
    </>
  );
}

function CrawlList({ crawls, active }: { crawls: Crawl[]; active: string | null }) {
  const [search, setSearch] = useState('');
  const [opened, setOpened] = useState<string[]>([]);
  const route = useRoute();
  const tab = route.get('tab') ?? undefined;
  const sites = new Map<string, Crawl[]>();
  for (const crawl of crawls) {
    const site = siteOf(crawl.startUrl);
    sites.set(site, [...(sites.get(site) ?? []), crawl]);
  }
  const shown = [...sites].filter(([site]) => site.toLowerCase().includes(search.trim().toLowerCase()));
  const state = (crawl: Crawl) => (crawl.running ? ' · running' : crawl.status === 'finished' ? '' : ` · ${crawl.status}`);
  const item = (crawl: Crawl, heading: boolean) => (
    <RouteLink key={crawl.id} className={`crawl-item ${crawl.id === active ? 'active' : ''}`} current={crawl.id === active} title={crawl.startedAt ?? undefined} href={hrefFor({ crawl: crawl.id, tab })}>
      {heading && <span className="crawl-host">{hostOf(crawl.startUrl)}</span>}
      <span className="crawl-sub">{runLabel(crawl)}{state(crawl)}</span>
    </RouteLink>
  );
  return (
    <>
      {sites.size > 5 && <input className="crawl-search" aria-label="Search sites" placeholder="Search sites" value={search} onChange={(e) => setSearch(e.target.value)} />}
      {shown.map(([site, runs]) => {
        const [latest, ...earlier] = runs;
        const open = opened.includes(site) || earlier.some((run) => run.id === active);
        return (
          <div key={site}>
            {item(latest, true)}
            {earlier.length > 0 && (
              <button className="runs-toggle" aria-expanded={open} onClick={() => setOpened(open ? opened.filter((name) => name !== site) : [...opened, site])}>
                {open ? 'Hide' : 'Show'} {plural(earlier.length, 'earlier run')}
              </button>
            )}
            {open && earlier.length > 0 && <div className="runs">{earlier.map((run) => item(run, false))}</div>}
          </div>
        );
      })}
      {shown.length === 0 && <p className="subtle">No sites match.</p>}
    </>
  );
}

const TABS: { key: string; label: string }[] = [
  { key: 'issues', label: 'Issues' }, { key: 'elements', label: 'Elements' }, { key: 'urls', label: 'URLs' }, { key: 'data', label: 'Search data' }, { key: 'compare', label: 'Compare' },
];

function Stat({ value, label, severity, href }: { value: number; label: string; severity?: string; href: string }) {
  return (
    <RouteLink className={`stat ${severity ?? ''} ${severity && value === 0 ? 'zero' : ''}`} href={href}>
      <b>{value.toLocaleString('en-US')}</b><span>{label}</span>
    </RouteLink>
  );
}

export function App() {
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((n) => n + 1);
  const route = useRoute();
  const { data: crawls, error } = useApi<Crawl[]>('/api/crawls', tick);
  const view = route.get('view');
  const openUrl = route.get('url');
  const tab = route.get('tab') ?? 'issues';
  const active = view ? null : route.get('crawl') ?? crawls?.[0]?.id ?? null;
  const { data: detail, error: detailError } = useApi<{ overview: Crawl; summary: Summary[] }>(active ? `/api/crawls/${active}` : null, tick);
  const anyRunning = crawls?.some((crawl) => crawl.running) ?? false;
  const creating = view === 'new';

  useEffect(() => {
    if (!anyRunning) {
      refresh(); // One last read, so a crawl that just finished shows its final results.
      return;
    }
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [anyRunning]);

  // A crawl started here should appear in the list as soon as the address moves to it.
  const known = !active || crawls?.some((crawl) => crawl.id === active);
  useEffect(() => { if (!known) refresh(); }, [known]);

  useEffect(() => { if (openUrl) window.scrollTo(0, 0); }, [openUrl]);

  const host = detail ? hostOf(detail.overview.startUrl) : null;
  useEffect(() => { document.title = host && active ? `${host} · SSAK` : 'SSAK'; }, [host, active]);

  const count = (severity: string) => detail?.summary.filter((s) => s.severity === severity).reduce((sum, s) => sum + s.count, 0) ?? 0;

  return (
    <div className="layout">
      <nav className="sidebar" aria-label="Crawls">
        <div className="brand">SSAK</div>
        <RouteLink className="btn primary new-crawl-button center" current={creating} href={hrefFor({ view: 'new' })}>New crawl</RouteLink>
        <RouteLink className={`btn new-crawl-button center ${view === 'connections' ? 'active' : ''}`} current={view === 'connections'} href={hrefFor({ view: 'connections' })}>Connections</RouteLink>
        <RouteLink className={`btn new-crawl-button center ${view === 'usage' ? 'active' : ''}`} current={view === 'usage'} href={hrefFor({ view: 'usage' })}>Usage</RouteLink>
        {error && <div className="error-box">{error}</div>}
        {crawls && <CrawlList crawls={crawls} active={active} />}
      </nav>
      <main className="main">
        {view === 'connections' ? (
          <ConnectionsView />
        ) : view === 'usage' ? (
          <UsageView />
        ) : creating ? (
          <NewCrawl from={route.get('from')} />
        ) : (
          <>
            {crawls?.length === 0 && <div className="panel empty">No crawls yet. Choose New crawl to start one.</div>}
            {detailError && <Failure message={detailError} />}
            {active && !detail && !detailError && <TableSkeleton />}
            {active && detail && (
              <>
                <h1>{detail.overview.startUrl}</h1>
                <CrawlControls overview={detail.overview} onChanged={refresh} />
                {detail.overview.error && detail.overview.status === 'failed' && <Failure message={detail.overview.error} />}
                <CrawlHealth key={`health-${active}`} crawl={active} overview={detail.overview} summary={detail.summary} />
                <div className="stats">
                  <Stat value={detail.overview.pages} label="Internal URLs" href={hrefFor({ crawl: active, tab: 'urls' })} />
                  <div className="stat-divider" aria-hidden="true" />
                  <Stat value={count('error')} label="Errors" severity="error" href={hrefFor({ crawl: active, tab: 'issues', sev: 'error' })} />
                  <Stat value={count('warning')} label="Warnings" severity="warning" href={hrefFor({ crawl: active, tab: 'issues', sev: 'warning' })} />
                  <Stat value={count('notice')} label="Notices" severity="notice" href={hrefFor({ crawl: active, tab: 'issues', sev: 'notice' })} />
                </div>
                <TrafficStrip key={`traffic-${active}`} crawl={active} overview={detail.overview} refresh={tick} onChanged={refresh} onConnections={() => navigate(hrefFor({ view: 'connections' }))} />
                <nav className="tabs" aria-label="Crawl sections">
                  {TABS.map(({ key, label }) => (
                    <RouteLink key={key} className={`tab ${tab === key ? 'active' : ''}`} current={tab === key} href={hrefFor({ crawl: route.get('crawl') ?? undefined, tab: key === 'issues' ? undefined : key })}>{label}</RouteLink>
                  ))}
                </nav>
                {openUrl && <UrlDetail key={openUrl} crawl={active} url={openUrl} summary={detail.summary} />}
                {/* Stays mounted behind a URL's details, so Back returns to the same scroll position. */}
                <div hidden={Boolean(openUrl)}>
                  {tab === 'elements' ? (
                    <ElementsView key={active} crawl={active} refresh={tick} route={route} />
                  ) : tab === 'urls' ? (
                    <UrlsView key={active} crawl={active} refresh={tick} route={route} />
                  ) : tab === 'data' ? (
                    <SearchDataView key={active} crawl={active} refresh={tick} />
                  ) : tab === 'compare' ? (
                    <CompareView key={active} crawl={active} crawls={crawls ?? []} route={route} summary={detail.summary} />
                  ) : (
                    <IssuesView key={active} crawl={active} summary={detail.summary} route={route} />
                  )}
                </div>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
