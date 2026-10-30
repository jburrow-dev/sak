import { useEffect, useState } from 'react';

async function api<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed: ${response.status}`);
  return data as T;
}

function useApi<T>(path: string | null) {
  const [state, setState] = useState<{ path: string | null; data?: T; error?: string }>({ path: null });
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>(path).then((data) => live && setState({ path, data }), (error) => live && setState({ path, error: error.message }));
    return () => { live = false; };
  }, [path]);
  const current = state.path === path;
  return { data: current ? state.data : undefined, error: current ? state.error : undefined, loading: Boolean(path) && !current };
}

function query(params: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
  return search.toString();
}

interface Crawl { id: string; startUrl: string | null; status: string | null; startedAt: string | null; pages: number; fetched: number; pending: number; issues: number }
interface Summary { type: string; severity: string; title: string; fix: string; count: number }
interface PageOf<T> { total: number; offset: number; limit: number; items: T[] }
interface Issue { type: string; severity: string; url: string; detail: string | null }
interface UrlRow { url: string; kind: string; status: number | null; depth: number | null; indexable: number | null; indexability_reason: string | null; title: string | null; word_count: number | null; inlinks: number; issue_count: number; response_ms: number | null; clicks: number | null; impressions: number | null; sessions: number | null; error: string | null }
interface Link { url: string; type: string; anchor: string | null; nofollow: number; status: number | null }

const hostOf = (url: string | null) => { try { return url ? new URL(url).host : 'Unknown'; } catch { return url ?? 'Unknown'; } };

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

const Failure = ({ message }: { message: string }) => <div className="panel error-box" role="alert">{message}</div>;

function IssuesView({ crawl, summary, onOpenUrl }: { crawl: string; summary: Summary[]; onOpenUrl: (url: string) => void }) {
  const [type, setType] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const { data, error } = useApi<PageOf<Issue>>(type ? `/api/crawls/${crawl}/issues?${query({ type, offset, limit: 100 })}` : null);

  if (type) {
    const definition = summary.find((s) => s.type === type);
    return (
      <>
        <div className="toolbar"><button className="btn" onClick={() => { setType(null); setOffset(0); }}>All issues</button><b>{definition?.title}</b></div>
        {definition?.fix && <p className="subtle">{definition.fix}</p>}
        {error && <Failure message={error} />}
        {data && (
          <>
            <div className="panel">
              <table>
                <thead><tr><th>URL</th><th>Detail</th></tr></thead>
                <tbody>{data.items.map((issue, i) => (
                  <tr key={i} className="clickable" onClick={() => onOpenUrl(issue.url)}><td className="url">{issue.url}</td><td className="url">{issue.detail}</td></tr>
                ))}</tbody>
              </table>
            </div>
            <Pager page={data} onOffset={setOffset} />
          </>
        )}
      </>
    );
  }
  if (summary.length === 0) return <div className="panel empty">No issues recorded yet.</div>;
  return (
    <div className="panel">
      <table>
        <thead><tr><th>Severity</th><th>Issue</th><th className="num">URLs</th></tr></thead>
        <tbody>{summary.map((row) => (
          <tr key={row.type} className="clickable" onClick={() => setType(row.type)}>
            <td><span className={`sev ${row.severity}`}>{row.severity}</span></td>
            <td>{row.title}</td>
            <td className="num">{row.count}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

const COLUMNS: { key: string; label: string; numeric?: boolean }[] = [
  { key: 'url', label: 'URL' }, { key: 'status', label: 'Status', numeric: true }, { key: 'title', label: 'Title' }, { key: 'depth', label: 'Depth', numeric: true },
  { key: 'inlinks', label: 'Inlinks', numeric: true }, { key: 'word_count', label: 'Words', numeric: true }, { key: 'issue_count', label: 'Issues', numeric: true },
  { key: 'clicks', label: 'Clicks', numeric: true }, { key: 'sessions', label: 'Sessions', numeric: true },
];

function UrlsView({ crawl, onOpenUrl }: { crawl: string; onOpenUrl: (url: string) => void }) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [kind, setKind] = useState('page');
  const [indexable, setIndexable] = useState('');
  const [sort, setSort] = useState('id');
  const [desc, setDesc] = useState(false);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => { setDebounced(search); setOffset(0); }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const { data, error } = useApi<PageOf<UrlRow>>(`/api/crawls/${crawl}/urls?${query({ search: debounced, kind, indexable, sort, desc, offset, limit: 100 })}`);
  const toggleSort = (key: string) => {
    if (sort === key) setDesc(!desc);
    else { setSort(key); setDesc(false); }
    setOffset(0);
  };
  return (
    <>
      <div className="toolbar">
        <input aria-label="Search URLs and titles" placeholder="Search URL or title" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="URL type" value={kind} onChange={(e) => { setKind(e.target.value); setOffset(0); }}>
          <option value="page">Internal</option><option value="external">External</option><option value="image">Images</option><option value="">All</option>
        </select>
        <select aria-label="Indexability" value={indexable} onChange={(e) => { setIndexable(e.target.value); setOffset(0); }}>
          <option value="">Any indexability</option><option value="true">Indexable</option><option value="false">Non-indexable</option>
        </select>
      </div>
      {error && <Failure message={error} />}
      {data && (
        <>
          <div className="panel">
            <table>
              <thead><tr>{COLUMNS.map((c) => (
                <th key={c.key} className={`sortable ${c.numeric ? 'num' : ''}`} aria-sort={sort === c.key ? (desc ? 'descending' : 'ascending') : 'none'} onClick={() => toggleSort(c.key)}>
                  {c.label}{sort === c.key ? (desc ? ' ↓' : ' ↑') : ''}
                </th>
              ))}</tr></thead>
              <tbody>{data.items.map((row) => (
                <tr key={row.url} className="clickable" onClick={() => onOpenUrl(row.url)}>
                  <td className="url">{row.url}</td>
                  <td className="num"><Status value={row.status} error={row.error} /></td>
                  <td className="url">{row.title}</td>
                  <td className="num">{row.depth}</td>
                  <td className="num">{row.inlinks}</td>
                  <td className="num">{row.word_count}</td>
                  <td className="num">{row.issue_count}</td>
                  <td className="num">{row.clicks}</td>
                  <td className="num">{row.sessions}</td>
                </tr>
              ))}</tbody>
            </table>
            {data.items.length === 0 && <div className="empty">No URLs match.</div>}
          </div>
          <Pager page={data} onOffset={setOffset} />
        </>
      )}
    </>
  );
}

function LinkTable({ crawl, url, direction, onOpenUrl }: { crawl: string; url: string; direction: 'in' | 'out'; onOpenUrl: (url: string) => void }) {
  const [offset, setOffset] = useState(0);
  const { data } = useApi<PageOf<Link>>(`/api/crawls/${crawl}/links?${query({ url, direction, offset, limit: 25 })}`);
  if (!data) return null;
  if (data.total === 0) return <p className="subtle">None.</p>;
  return (
    <>
      <div className="panel">
        <table>
          <thead><tr><th>URL</th><th>Type</th><th>Anchor</th><th className="num">Status</th></tr></thead>
          <tbody>{data.items.map((link, i) => (
            <tr key={i} className="clickable" onClick={() => onOpenUrl(link.url)}>
              <td className="url">{link.url}</td><td>{link.type}{link.nofollow ? ' (nofollow)' : ''}</td><td>{link.anchor}</td>
              <td className="num"><Status value={link.status} /></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <Pager page={data} onOffset={setOffset} />
    </>
  );
}

function UrlDetail({ crawl, url, onBack, onOpenUrl }: { crawl: string; url: string; onBack: () => void; onOpenUrl: (url: string) => void }) {
  const { data, error } = useApi<any>(`/api/crawls/${crawl}/url?${query({ url })}`);
  if (error) return <Failure message={error} />;
  if (data === null) return <><button className="btn" onClick={onBack}>Back</button><p className="subtle">This URL is not in the crawl.</p></>;
  if (!data) return null;
  const list = (value: string[] | undefined) => (value?.length ? value.join(' | ') : 'None');
  return (
    <div className="detail">
      <button className="btn" onClick={onBack}>Back</button>
      <h2 className="url" style={{ fontSize: 15 }}>{url} <a href={url} target="_blank" rel="noreferrer noopener">Open</a></h2>
      <dl className="kv">
        <dt>Status</dt><dd><Status value={data.status} error={data.error} />{data.error ? ` ${data.error}` : ''}</dd>
        <dt>Indexable</dt><dd>{data.indexable === 1 ? 'Yes' : data.indexable === 0 ? `No (${data.indexability_reason})` : 'Not assessed'}</dd>
        <dt>Depth</dt><dd>{data.depth ?? 'Not linked from the start URL'}</dd>
        <dt>Response time</dt><dd>{data.response_ms ?? 'None'}{data.response_ms !== null ? ' ms' : ''}</dd>
        <dt>Title</dt><dd>{list(data.elements?.titles)}</dd>
        <dt>Meta description</dt><dd>{list(data.elements?.meta_descriptions)}</dd>
        <dt>H1</dt><dd>{list(data.elements?.h1s)}</dd>
        <dt>Canonical</dt><dd>{data.canonical ?? 'None'}</dd>
        <dt>Meta robots</dt><dd>{list(data.elements?.meta_robots)}</dd>
        <dt>Words</dt><dd>{data.word_count ?? 'None'}</dd>
        {data.clicks !== null && <><dt>Search Console</dt><dd>{data.clicks} clicks, {data.impressions} impressions</dd></>}
        {data.sessions !== null && <><dt>GA4 sessions</dt><dd>{data.sessions}</dd></>}
        {data.pagespeed?.map((p: any) => <span key={p.strategy} style={{ display: 'contents' }}><dt>PageSpeed ({p.strategy})</dt><dd>{p.performance}, LCP {Math.round(p.lcp_ms ?? 0)} ms, CLS {p.cls?.toFixed(3)}</dd></span>)}
      </dl>
      {data.redirect_chain.length > 0 && (
        <><h3>Redirect path</h3><ol>{data.redirect_chain.map((hop: any) => <li key={hop.hop} className="url">{hop.url} {hop.status && <Status value={hop.status} />}</li>)}</ol></>
      )}
      {data.hreflang.length > 0 && (
        <><h3>Hreflang</h3><ul>{data.hreflang.map((h: any, i: number) => <li key={i} className="url">{h.lang}: {h.href}</li>)}</ul></>
      )}
      <h3>Issues ({data.issues.length})</h3>
      {data.issues.length === 0 ? <p className="subtle">None.</p> : (
        <div className="panel"><table><tbody>{data.issues.map((issue: any, i: number) => (
          <tr key={i}><td><span className={`sev ${issue.severity}`}>{issue.severity}</span></td><td>{issue.type}</td><td className="url">{issue.detail}</td></tr>
        ))}</tbody></table></div>
      )}
      <h3>Inlinks</h3>
      <LinkTable key={`in-${url}`} crawl={crawl} url={url} direction="in" onOpenUrl={onOpenUrl} />
      <h3>Outlinks</h3>
      <LinkTable key={`out-${url}`} crawl={crawl} url={url} direction="out" onOpenUrl={onOpenUrl} />
    </div>
  );
}

function CompareView({ crawl, crawls }: { crawl: string; crawls: Crawl[] }) {
  const others = crawls.filter((c) => c.id !== crawl);
  const [before, setBefore] = useState('');
  const { data, error, loading } = useApi<any>(before ? `/api/compare?${query({ before, after: crawl })}` : null);
  if (others.length === 0) return <div className="panel empty">Run a second crawl to compare it with this one.</div>;
  const section = (title: string, items: any[], render: (item: any) => string) => (
    <>
      <h3>{title} ({items.length})</h3>
      {items.length > 0 && <div className="panel"><table><tbody>{items.slice(0, 500).map((item, i) => <tr key={i}><td className="url">{render(item)}</td></tr>)}</tbody></table></div>}
      {items.length > 500 && <p className="subtle">Showing the first 500. Use the CLI for all of them.</p>}
    </>
  );
  return (
    <div className="detail">
      <div className="toolbar">
        <label htmlFor="before">Compare this crawl with an earlier one:</label>
        <select id="before" value={before} onChange={(e) => setBefore(e.target.value)}>
          <option value="">Choose a crawl</option>
          {others.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}
        </select>
      </div>
      {error && <Failure message={error} />}
      {loading && <p className="subtle">Comparing...</p>}
      {data && (
        <>
          {section('URLs added', data.urlsAdded, (u) => u)}
          {section('URLs removed', data.urlsRemoved, (u) => u)}
          {section('Changes', data.changed, (c) => `${c.url}: ${c.field} changed from ${c.before} to ${c.after}`)}
          {section('New issues', data.issuesAdded, (i) => `${i.type}: ${i.url}${i.detail ? ` (${i.detail})` : ''}`)}
          {section('Resolved issues', data.issuesResolved, (i) => `${i.type}: ${i.url}${i.detail ? ` (${i.detail})` : ''}`)}
        </>
      )}
    </div>
  );
}

function CostsView() {
  const { data, error } = useApi<any>('/api/costs');
  if (error) return <Failure message={error} />;
  if (!data) return null;
  const labels: Record<string, string> = { dataforseo: 'DataForSEO', pagespeed: 'PageSpeed Insights key', 'google-client': 'Google OAuth client', 'google-tokens': 'Google sign-in' };
  return (
    <div className="detail">
      <div className="stats">
        <div className="stat"><b>${data.total.toFixed(4)}</b><span>Spent through SAK</span></div>
        <div className="stat"><b>{data.calls}</b><span>Paid calls</span></div>
        <div className="stat"><b>{data.balance === null ? 'None' : `$${data.balance}`}</b><span>DataForSEO balance</span></div>
      </div>
      {data.balanceError && <Failure message={data.balanceError} />}
      <h3>Connections</h3>
      <div className="panel"><table><tbody>{Object.entries(labels).map(([key, label]) => (
        <tr key={key}><td>{label}</td><td>{data.keys[key] ? <span className="status-ok">Connected</span> : <span className="subtle">Not set up</span>}</td></tr>
      ))}</tbody></table></div>
      <h3>Spend by endpoint</h3>
      {data.byEndpoint.length === 0 ? <p className="subtle">Nothing spent yet.</p> : (
        <div className="panel"><table><thead><tr><th>Endpoint</th><th className="num">Calls</th><th className="num">Cost</th></tr></thead>
          <tbody>{data.byEndpoint.map((row: any) => <tr key={row.endpoint}><td>{row.endpoint}</td><td className="num">{row.calls}</td><td className="num">${row.cost.toFixed(4)}</td></tr>)}</tbody></table></div>
      )}
    </div>
  );
}

type Tab = 'issues' | 'urls' | 'compare' | 'costs';

export function App() {
  const { data: crawls, error } = useApi<Crawl[]>('/api/crawls');
  const [crawlId, setCrawlId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('issues');
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const active = crawlId ?? crawls?.[0]?.id ?? null;
  const { data: detail } = useApi<{ overview: Crawl; summary: Summary[] }>(active ? `/api/crawls/${active}` : null);

  const count = (severity: string) => detail?.summary.filter((s) => s.severity === severity).reduce((sum, s) => sum + s.count, 0) ?? 0;

  return (
    <div className="layout">
      <nav className="sidebar" aria-label="Crawls">
        <div className="brand">SAK</div>
        {error && <div className="error-box">{error}</div>}
        {crawls?.map((crawl) => (
          <button key={crawl.id} className={`crawl-item ${crawl.id === active ? 'active' : ''}`} onClick={() => { setCrawlId(crawl.id); setOpenUrl(null); }}>
            <span className="crawl-host">{hostOf(crawl.startUrl)}</span>
            <span className="crawl-sub">{crawl.startedAt?.slice(0, 16).replace('T', ' ')} · {crawl.pages} URLs · {crawl.status}</span>
          </button>
        ))}
      </nav>
      <main className="main">
        {crawls?.length === 0 && <div className="panel empty">No crawls yet. Start one with: sak crawl https://example.com</div>}
        {active && detail && (
          <>
            <h1>{detail.overview.startUrl}</h1>
            <div className="subtle">{detail.overview.status}{detail.overview.pending > 0 ? `, ${detail.overview.pending} URLs still queued` : ''}</div>
            <div className="stats">
              <div className="stat"><b>{detail.overview.pages}</b><span>Internal URLs</span></div>
              <div className="stat"><b>{count('error')}</b><span>Errors</span></div>
              <div className="stat"><b>{count('warning')}</b><span>Warnings</span></div>
              <div className="stat"><b>{count('notice')}</b><span>Notices</span></div>
            </div>
            <div className="tabs" role="tablist">
              {(['issues', 'urls', 'compare', 'costs'] as Tab[]).map((name) => (
                <button key={name} role="tab" aria-selected={tab === name} className={`tab ${tab === name ? 'active' : ''}`} onClick={() => { setTab(name); setOpenUrl(null); }}>
                  {name === 'urls' ? 'URLs' : name[0].toUpperCase() + name.slice(1)}
                </button>
              ))}
            </div>
            {openUrl ? (
              <UrlDetail crawl={active} url={openUrl} onBack={() => setOpenUrl(null)} onOpenUrl={setOpenUrl} />
            ) : tab === 'issues' ? (
              <IssuesView key={active} crawl={active} summary={detail.summary} onOpenUrl={setOpenUrl} />
            ) : tab === 'urls' ? (
              <UrlsView key={active} crawl={active} onOpenUrl={setOpenUrl} />
            ) : tab === 'compare' ? (
              <CompareView key={active} crawl={active} crawls={crawls ?? []} />
            ) : (
              <CostsView />
            )}
          </>
        )}
      </main>
    </div>
  );
}
