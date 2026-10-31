import { useEffect, useState, type FormEvent } from 'react';
import { ConnectionsView, TrafficFields, TrafficStrip, trafficFromForm, type TrafficForm } from './Integrations.tsx';
import { Check, Failure, post, useApi, useDebounced } from './shared.tsx';

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
interface Settings { paidApis: boolean; prices: { keywordVolume: number; backlinkSummary: number; rankCheck: number } }

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

const formatBytes = (value: number) => (value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`);

function useSort(initial = '', initialDesc = false) {
  const [sort, setSort] = useState(initial);
  const [desc, setDesc] = useState(initialDesc);
  const toggle = (key: string) => {
    if (sort === key) setDesc(!desc);
    else { setSort(key); setDesc(false); }
  };
  const reset = () => { setSort(''); setDesc(false); };
  return { sort, desc, toggle, reset };
}

function SortHeader({ label, name, numeric, sort, onSort }: { label: string; name: string; numeric?: boolean; sort: { sort: string; desc: boolean }; onSort: (key: string) => void }) {
  const active = sort.sort === name;
  return (
    <th className={`sortable ${numeric ? 'num' : ''}`} aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button className="th-button" onClick={() => onSort(name)}>{label}{active ? (sort.desc ? ' ↓' : ' ↑') : ''}</button>
    </th>
  );
}

const SEVERITY_RANK: Record<string, number> = { error: 0, warning: 1, notice: 2 };

function IssuesView({ crawl, summary, onOpenUrl }: { crawl: string; summary: Summary[]; onOpenUrl: (url: string) => void }) {
  const [type, setType] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [severity, setSeverity] = useState('');
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, () => setOffset(0));
  const list = useSort('severity');
  const detail = useSort();
  const { data, error } = useApi<PageOf<Issue>>(type ? `/api/crawls/${crawl}/issues?${query({ type, offset, limit: 100, search: debounced, sort: detail.sort, desc: detail.desc })}` : null);

  if (type) {
    const definition = summary.find((s) => s.type === type);
    const sortDetail = (key: string) => { detail.toggle(key); setOffset(0); };
    return (
      <>
        <div className="toolbar">
          <button className="btn" onClick={() => { setType(null); setOffset(0); setSearch(''); }}>All issues</button>
          <b>{definition?.title}</b>
          <input aria-label="Search this issue" placeholder="Search URL or detail" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {definition?.fix && <p className="subtle">{definition.fix}</p>}
        {error && <Failure message={error} />}
        {data && (
          <>
            <div className="panel">
              <table>
                <thead><tr><SortHeader label="URL" name="url" sort={detail} onSort={sortDetail} /><SortHeader label="Detail" name="detail" sort={detail} onSort={sortDetail} /></tr></thead>
                <tbody>{data.items.map((issue, i) => (
                  <tr key={i} className="clickable" onClick={() => onOpenUrl(issue.url)}><td className="url">{issue.url}</td><td className="url">{issue.detail}</td></tr>
                ))}</tbody>
              </table>
              {data.items.length === 0 && <div className="empty">Nothing matches.</div>}
            </div>
            <Pager page={data} onOffset={setOffset} />
          </>
        )}
      </>
    );
  }
  if (summary.length === 0) return <div className="panel empty">No issues recorded yet.</div>;
  const order = (a: Summary, b: Summary) => {
    if (list.sort === 'count') return a.count - b.count;
    if (list.sort === 'title') return a.title.localeCompare(b.title);
    return (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) || b.count - a.count;
  };
  const shown = summary.filter((row) => !severity || row.severity === severity).sort((a, b) => (list.desc ? order(b, a) : order(a, b)));
  return (
    <>
      <div className="chips" role="group" aria-label="Filter by severity">
        {['', 'error', 'warning', 'notice'].map((value) => (
          <button key={value} className={`chip ${severity === value ? 'active' : ''}`} aria-pressed={severity === value} onClick={() => setSeverity(value)}>
            {value ? `${value[0].toUpperCase()}${value.slice(1)}s` : 'All'} <span>{summary.filter((row) => !value || row.severity === value).reduce((sum, row) => sum + row.count, 0)}</span>
          </button>
        ))}
      </div>
      <div className="panel">
        <table>
          <thead><tr><SortHeader label="Severity" name="severity" sort={list} onSort={list.toggle} /><SortHeader label="Issue" name="title" sort={list} onSort={list.toggle} /><SortHeader label="URLs" name="count" numeric sort={list} onSort={list.toggle} /></tr></thead>
          <tbody>{shown.map((row) => (
            <tr key={row.type} className="clickable" onClick={() => setType(row.type)}>
              <td><span className={`sev ${row.severity}`}>{row.severity}</span></td>
              <td>{row.title}</td>
              <td className="num">{row.count}</td>
            </tr>
          ))}</tbody>
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
    case 'url': return <td className="url">{value}</td>;
    default: return <td className="text-cell">{value}</td>;
  }
}

function ElementsView({ crawl, refresh, onOpenUrl }: { crawl: string; refresh: number; onOpenUrl: (url: string) => void }) {
  const { data: catalog, error: catalogError } = useApi<ElementInfo[]>('/api/elements');
  const [key, setKey] = useState('title');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const debounced = useDebounced(search, () => setOffset(0));
  const sort = useSort();
  const params = query({ filter, search: debounced, sort: sort.sort, desc: sort.desc });
  const { data, error } = useApi<{ counts: Record<string, number>; page: PageOf<Record<string, any>> }>(`/api/crawls/${crawl}/elements/${key}?${params}&${query({ offset, limit: 100 })}`, refresh);
  if (catalogError) return <Failure message={catalogError} />;
  const element = catalog?.find((e) => e.key === key);
  if (!element) return null;
  const choose = (next: string) => { setKey(next); setFilter('all'); setSearch(''); setOffset(0); sort.reset(); };
  return (
    <div className="elements">
      <nav className="element-rail" aria-label="SEO elements">
        {catalog!.map((e) => <button key={e.key} className={`element-item ${e.key === key ? 'active' : ''}`} aria-current={e.key === key} onClick={() => choose(e.key)}>{e.label}</button>)}
      </nav>
      <div className="element-main">
        <div className="chips" role="group" aria-label={`Filter ${element.label}`}>
          {element.filters.map((f) => (
            <button key={f.key} className={`chip ${filter === f.key ? 'active' : ''}`} aria-pressed={filter === f.key} onClick={() => { setFilter(f.key); setOffset(0); }}>
              {f.label} <span>{data?.counts[f.key] ?? ''}</span>
            </button>
          ))}
        </div>
        <div className="toolbar">
          <input aria-label={`Search ${element.label}`} placeholder={`Search ${element.label.toLowerCase()}`} value={search} onChange={(e) => setSearch(e.target.value)} />
          <a className="btn" href={`/api/crawls/${crawl}/elements/${key}.csv?${params}`} download>Export CSV</a>
        </div>
        {error && <Failure message={error} />}
        {data && (
          <>
            <div className="panel">
              <table>
                <thead><tr>{element.columns.map((c) => <SortHeader key={c.key} label={c.label} name={c.key} numeric={c.type === 'number' || c.type === 'status' || c.type === 'bytes'} sort={sort} onSort={(name) => { sort.toggle(name); setOffset(0); }} />)}</tr></thead>
                <tbody>{data.page.items.map((row) => (
                  <tr key={row.id} className="clickable" onClick={() => onOpenUrl(row.url)}>{element.columns.map((c) => <ElementCell key={c.key} column={c} row={row} />)}</tr>
                ))}</tbody>
              </table>
              {data.page.items.length === 0 && <div className="empty">Nothing matches.</div>}
            </div>
            <Pager page={data.page} onOffset={setOffset} />
          </>
        )}
      </div>
    </div>
  );
}

const COLUMNS: { key: string; label: string; numeric?: boolean }[] = [
  { key: 'url', label: 'URL' }, { key: 'status', label: 'Status', numeric: true }, { key: 'title', label: 'Title' }, { key: 'depth', label: 'Depth', numeric: true },
  { key: 'inlinks', label: 'Inlinks', numeric: true }, { key: 'word_count', label: 'Words', numeric: true }, { key: 'issue_count', label: 'Issues', numeric: true },
  { key: 'clicks', label: 'GSC clicks', numeric: true }, { key: 'impressions', label: 'GSC impressions', numeric: true }, { key: 'position', label: 'GSC position', numeric: true },
  { key: 'sessions', label: 'GA4 sessions', numeric: true }, { key: 'bing_clicks', label: 'Bing clicks', numeric: true },
];

function UrlsView({ crawl, refresh, onOpenUrl }: { crawl: string; refresh: number; onOpenUrl: (url: string) => void }) {
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('page');
  const [indexable, setIndexable] = useState('');
  const [sort, setSort] = useState('id');
  const [desc, setDesc] = useState(false);
  const [offset, setOffset] = useState(0);
  const debounced = useDebounced(search, () => setOffset(0));
  const { data, error } = useApi<PageOf<UrlRow>>(`/api/crawls/${crawl}/urls?${query({ search: debounced, kind, indexable, sort, desc, offset, limit: 100 })}`, refresh);
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
          <option value="page">Internal</option><option value="external">External</option><option value="image">Images</option><option value="css">CSS</option><option value="script">Scripts</option><option value="">All</option>
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
                <SortHeader key={c.key} label={c.label} name={c.key} numeric={c.numeric} sort={{ sort, desc }} onSort={toggleSort} />
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
                  <td className="num">{row.impressions}</td>
                  <td className="num">{row.position === null ? '' : row.position.toFixed(1)}</td>
                  <td className="num">{row.sessions}</td>
                  <td className="num">{row.bing_clicks}</td>
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
        {data.elements?.h2s && <><dt>H2</dt><dd>{list(data.elements.h2s)}</dd></>}
        <dt>Canonical</dt><dd>{data.canonical ?? 'None'}</dd>
        <dt>Meta robots</dt><dd>{list(data.elements?.meta_robots)}</dd>
        <dt>Words</dt><dd>{data.word_count ?? 'None'}{data.rendering?.rendered ? ` rendered, ${data.rendering.raw_word_count} as served` : ''}</dd>
        {data.rendering?.rendered === 1 && <><dt>JS-only links</dt><dd>{data.rendering.js_only_links}</dd></>}
        {data.rendering?.render_error && <><dt>Render error</dt><dd>{data.rendering.render_error}</dd></>}
        {data.bytes !== null && <><dt>Size</dt><dd>{formatBytes(data.bytes)}</dd></>}
        {data.clicks !== null && <><dt>Search Console</dt><dd>{data.clicks} clicks, {data.impressions} impressions, CTR {((data.ctr ?? 0) * 100).toFixed(1)}%, average position {data.position?.toFixed(1)}</dd></>}
        {data.sessions !== null && <><dt>GA4</dt><dd>{data.sessions} sessions, {data.engaged_sessions} engaged, {data.users ?? 'no'} users, {data.views ?? 'no'} views, {data.key_events ?? 'no'} key events</dd></>}
        {data.bing_clicks !== null && <><dt>Bing</dt><dd>{data.bing_clicks} clicks, {data.bing_impressions} impressions, average position {data.bing_position?.toFixed(1)}</dd></>}
        {data.inspection && <><dt>Google index status</dt><dd>{data.inspection.error ?? `${data.inspection.coverage_state ?? data.inspection.verdict}${data.inspection.last_crawl_time ? `, last crawled ${data.inspection.last_crawl_time.slice(0, 10)}` : ''}`}</dd></>}
        {data.inspection?.google_canonical && <><dt>Google canonical</dt><dd>{data.inspection.google_canonical}</dd></>}
        {data.pagespeed?.map((p: any) => <span key={p.strategy} style={{ display: 'contents' }}><dt>PageSpeed ({p.strategy})</dt><dd>{p.performance}, LCP {Math.round(p.lcp_ms ?? 0)} ms, CLS {p.cls?.toFixed(3)}</dd></span>)}
      </dl>
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

function PaidValue({ kind, value }: { kind: string; value: any }) {
  if (kind === 'backlinks') return <span>{value.backlinks ?? 'No'} backlinks from {value.referring_domains ?? 0} domains, rank {value.rank ?? 'none'}{value.spam_score !== null ? `, spam score ${value.spam_score}` : ''}</span>;
  return (
    <ul className="plain-list">{(value as any[]).map((row) => (
      <li key={row.keyword}>{row.keyword}: {kind === 'rank' ? (row.position ? `position ${row.position}` : 'not in the top 10') : `${row.search_volume ?? 'no'} searches a month`}</li>
    ))}</ul>
  );
}

function PaidData({ crawl, refresh }: { crawl: string; refresh: number }) {
  const { data } = useApi<{ kind: string; key: string; value: any; cost: number; cached: number; error: string | null }[]>(`/api/crawls/${crawl}/paid`, refresh);
  const labels: Record<string, string> = { backlinks: 'Backlinks', volume: 'Search volume', rank: 'Google rank' };
  return (
    <>
      <h3>Paid data for this crawl</h3>
      {!data?.length ? <p className="subtle">This crawl did not collect any paid data.</p> : (
        <div className="panel"><table><thead><tr><th>Data</th><th>Result</th><th className="num">Cost</th></tr></thead>
          <tbody>{data.map((row) => (
            <tr key={`${row.kind}-${row.key}`}>
              <td>{labels[row.kind] ?? row.kind}</td>
              <td>{row.error ? <span className="status-bad">{row.error}</span> : <PaidValue kind={row.kind} value={row.value} />}</td>
              <td className="num">{row.cached ? 'Cached' : `$${row.cost.toFixed(4)}`}</td>
            </tr>
          ))}</tbody></table></div>
      )}
    </>
  );
}

function CostsView({ crawl, refresh }: { crawl: string | null; refresh: number }) {
  const [changes, setChanges] = useState(0);
  const { data, error } = useApi<any>('/api/costs', changes);
  const { data: settings } = useApi<Settings>('/api/settings', changes);
  const [saveError, setSaveError] = useState<string | null>(null);
  if (error) return <Failure message={error} />;
  if (!data) return null;
  const setPaid = (paidApis: boolean) => {
    setSaveError(null);
    post('/api/settings', { paidApis }).then(() => setChanges((n) => n + 1), (e) => setSaveError(e.message));
  };
  return (
    <div className="detail">
      <div className="panel switch-row">
        <label className="switch">
          <input type="checkbox" role="switch" checked={settings?.paidApis ?? false} disabled={!settings} onChange={(e) => setPaid(e.target.checked)} />
          <span><b>Allow DataForSEO spending</b><br /><span className="subtle">{settings?.paidApis ? 'On. Crawls that ask for paid data, and sak kw, backlinks and rank, can spend after you agree to an estimate.' : 'Off. Nothing can spend, from the UI, the CLI or Claude. Cached results still work.'}</span></span>
        </label>
      </div>
      {saveError && <Failure message={saveError} />}
      <div className="stats">
        <div className="stat"><b>${data.total.toFixed(4)}</b><span>Spent through SAK</span></div>
        <div className="stat"><b>{data.calls}</b><span>Paid calls</span></div>
        <div className="stat"><b>{data.balance === null ? (settings?.paidApis === false ? 'Not checked' : 'None') : `$${data.balance}`}</b><span>DataForSEO balance</span></div>
      </div>
      {data.balanceError && <Failure message={data.balanceError} />}
      {crawl && <PaidData crawl={crawl} refresh={refresh} />}
      <h3>Spend by endpoint</h3>
      {data.byEndpoint.length === 0 ? <p className="subtle">Nothing spent yet.</p> : (
        <div className="panel"><table><thead><tr><th>Endpoint</th><th className="num">Calls</th><th className="num">Cost</th></tr></thead>
          <tbody>{data.byEndpoint.map((row: any) => <tr key={row.endpoint}><td>{row.endpoint}</td><td className="num">{row.calls}</td><td className="num">${row.cost.toFixed(4)}</td></tr>)}</tbody></table></div>
      )}
    </div>
  );
}

const lines = (value: string) => value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);

function NewCrawl({ onStarted, onCancel, onConnections }: { onStarted: (id: string) => void; onCancel: () => void; onConnections: () => void }) {
  const { data: settings } = useApi<Settings>('/api/settings');
  const [url, setUrl] = useState('');
  const [renderJs, setRenderJs] = useState(false);
  const [checkResources, setCheckResources] = useState(true);
  const [checkImages, setCheckImages] = useState(true);
  const [checkExternal, setCheckExternal] = useState(true);
  const [useSitemaps, setUseSitemaps] = useState(true);
  const [crawlSubdomains, setCrawlSubdomains] = useState(false);
  const [maxUrls, setMaxUrls] = useState('');
  const [rate, setRate] = useState('');
  const [seeds, setSeeds] = useState('');
  const [exclude, setExclude] = useState('');
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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    post<{ id: string }>('/api/crawls', {
      url, renderJs, checkResources, checkImages, checkExternal, useSitemaps, crawlSubdomains,
      maxUrls: maxUrls || undefined, requestsPerSecond: rate || undefined, seeds: lines(seeds), exclude: lines(exclude),
      ...(spends ? { paid: { backlinks, volume, rank, keywords: keywordList }, confirmed: true } : {}),
      ...(traffic ? { traffic: trafficFromForm(traffic) } : {}),
    }).then(({ id }) => onStarted(id), (e) => { setError(e.message); setBusy(false); });
  };

  return (
    <form className="new-crawl" onSubmit={submit}>
      <h1>New crawl</h1>
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
      <details>
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
        <TrafficFields url={url} subdomains={crawlSubdomains} onChange={setTraffic} onConnections={onConnections} />
      </fieldset>
      <fieldset>
        <legend>Paid data</legend>
        <Check checked={paidOn && allowed} disabled={!allowed} onChange={setPaidOn} note={allowed ? 'Off by default. A crawl on its own never spends.' : 'DataForSEO spending is switched off in the Costs tab.'}>Collect DataForSEO data when the crawl finishes</Check>
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
        <button className="btn primary" disabled={busy || !url.trim() || (traffic !== null && !traffic.ready)}>{spends ? `Start crawl and spend up to $${estimate.toFixed(3)}` : 'Start crawl'}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
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
  const total = overview.fetched + overview.pending;
  const canResume = !overview.running && overview.status !== 'finished' && overview.pending > 0;
  const crawling = overview.running && overview.status === 'running';
  const pulling = overview.running && overview.trafficStatus === 'running';
  const status = pulling ? 'pulling search and analytics data' : overview.status === 'running' && !overview.running ? 'interrupted, or running in another window' : overview.status;
  return (
    <div className="crawl-state">
      <span className="subtle" aria-live="polite">{status}{overview.pending > 0 ? `, ${overview.fetched} of ${total} URLs fetched` : ''}</span>
      {crawling && <progress max={Math.max(total, 1)} value={overview.fetched} aria-label="Crawl progress" />}
      {crawling && <button className="btn" onClick={() => act('pause')}>Pause</button>}
      {canResume && <button className="btn" onClick={() => act('resume')}>Resume</button>}
      {error && <span className="status-bad">{error}</span>}
    </div>
  );
}

type Tab = 'issues' | 'elements' | 'urls' | 'compare' | 'costs';

export function App() {
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((n) => n + 1);
  const { data: crawls, error } = useApi<Crawl[]>('/api/crawls', tick);
  const [crawlId, setCrawlId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [tab, setTab] = useState<Tab>('issues');
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const active = crawlId ?? crawls?.[0]?.id ?? null;
  const { data: detail } = useApi<{ overview: Crawl; summary: Summary[] }>(active ? `/api/crawls/${active}` : null, tick);
  const anyRunning = crawls?.some((crawl) => crawl.running) ?? false;

  useEffect(() => {
    if (!anyRunning) {
      refresh(); // One last read, so a crawl that just finished shows its final results.
      return;
    }
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [anyRunning]);

  const count = (severity: string) => detail?.summary.filter((s) => s.severity === severity).reduce((sum, s) => sum + s.count, 0) ?? 0;

  return (
    <div className="layout">
      <nav className="sidebar" aria-label="Crawls">
        <div className="brand">SAK</div>
        <button className={"btn primary new-crawl-button"} onClick={() => { setCreating(true); setConnecting(false); }}>New crawl</button>
        <button className={`btn new-crawl-button ${connecting ? 'active' : ''}`} aria-pressed={connecting} onClick={() => { setConnecting(true); setCreating(false); }}>Connections</button>
        {error && <div className="error-box">{error}</div>}
        {crawls?.map((crawl) => (
          <button key={crawl.id} className={`crawl-item ${!creating && !connecting && crawl.id === active ? 'active' : ''}`} onClick={() => { setCrawlId(crawl.id); setOpenUrl(null); setCreating(false); setConnecting(false); }}>
            <span className="crawl-host">{hostOf(crawl.startUrl)}</span>
            <span className="crawl-sub">{crawl.startedAt?.slice(0, 16).replace('T', ' ')} · {crawl.pages} URLs · {crawl.running ? 'running' : crawl.status}</span>
          </button>
        ))}
      </nav>
      <main className="main">
        {connecting ? (
          <ConnectionsView />
        ) : creating ? (
          <NewCrawl key="new" onConnections={() => { setConnecting(true); setCreating(false); }} onCancel={() => setCreating(false)} onStarted={(id) => { setCrawlId(id); setCreating(false); setOpenUrl(null); setTab('issues'); refresh(); }} />
        ) : (
          <>
            {crawls?.length === 0 && <div className="panel empty">No crawls yet. Choose New crawl to start one.</div>}
            {active && detail && (
              <>
                <h1>{detail.overview.startUrl}</h1>
                <CrawlControls overview={detail.overview} onChanged={refresh} />
                {detail.overview.error && detail.overview.status === 'failed' && <Failure message={detail.overview.error} />}
                <div className="stats">
                  <div className="stat"><b>{detail.overview.pages}</b><span>Internal URLs</span></div>
                  <div className="stat"><b>{count('error')}</b><span>Errors</span></div>
                  <div className="stat"><b>{count('warning')}</b><span>Warnings</span></div>
                  <div className="stat"><b>{count('notice')}</b><span>Notices</span></div>
                </div>
                <TrafficStrip key={`traffic-${active}`} crawl={active} overview={detail.overview} refresh={tick} onChanged={refresh} onConnections={() => setConnecting(true)} />
                <div className="tabs" role="tablist">
                  {(['issues', 'elements', 'urls', 'compare', 'costs'] as Tab[]).map((name) => (
                    <button key={name} role="tab" aria-selected={tab === name} className={`tab ${tab === name ? 'active' : ''}`} onClick={() => { setTab(name); setOpenUrl(null); }}>
                      {name === 'urls' ? 'URLs' : name[0].toUpperCase() + name.slice(1)}
                    </button>
                  ))}
                </div>
                {openUrl ? (
                  <UrlDetail crawl={active} url={openUrl} onBack={() => setOpenUrl(null)} onOpenUrl={setOpenUrl} />
                ) : tab === 'issues' ? (
                  <IssuesView key={active} crawl={active} summary={detail.summary} onOpenUrl={setOpenUrl} />
                ) : tab === 'elements' ? (
                  <ElementsView key={active} crawl={active} refresh={tick} onOpenUrl={setOpenUrl} />
                ) : tab === 'urls' ? (
                  <UrlsView key={active} crawl={active} refresh={tick} onOpenUrl={setOpenUrl} />
                ) : tab === 'compare' ? (
                  <CompareView key={active} crawl={active} crawls={crawls ?? []} />
                ) : (
                  <CostsView crawl={active} refresh={tick} />
                )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
