import { useEffect, useState, type FormEvent } from 'react';
import { Check, Failure, post, useApi, useDebounced } from './shared.tsx';

interface Connections {
  google: { clientConfigured: boolean; accounts: string[]; signIn: { state: 'pending' | 'done' | 'failed'; account?: string; error?: string } | null };
  bing: { accounts: string[] };
  other: { dataforseo: boolean; pagespeed: boolean };
  days: number[];
  inspections: { default: number; max: number };
}
interface PropertyList { properties: { id: string; label: string; covers: boolean }[]; suggested: string | null }
interface Pull { source: string; account: string | null; property: string | null; days: number | null; start_date: string | null; end_date: string | null; fetched_at: string; status: string; row_count: number; matched: number; dropped: number; note: string | null; error: string | null }
interface SourceChoice { account?: string; property: string }
interface SavedPlan { days: number; gsc?: SourceChoice & { topQueries?: boolean; inspect?: { limit: number } }; ga4?: SourceChoice; bing?: { account?: string; site: string } }

export interface TrafficForm {
  days: number;
  gsc: (SourceChoice & { topQueries: boolean; inspect: number | null }) | null;
  ga4: SourceChoice | null;
  bing: SourceChoice | null;
  ready: boolean;
}

export function trafficFromForm(form: TrafficForm) {
  return {
    days: form.days,
    ...(form.gsc ? { gsc: { account: form.gsc.account, property: form.gsc.property, topQueries: form.gsc.topQueries, ...(form.gsc.inspect ? { inspect: { limit: form.gsc.inspect } } : {}) } } : {}),
    ...(form.ga4 ? { ga4: form.ga4 } : {}),
    ...(form.bing ? { bing: { account: form.bing.account, site: form.bing.property } } : {}),
  };
}

const SOURCE_LABELS: Record<string, string> = { gsc: 'Search Console', gsc_queries: 'Top queries', url_inspection: 'URL Inspection', ga4: 'GA4', bing: 'Bing' };
const accountName = (account: string) => (account === 'default' ? 'Current sign-in (name unknown)' : account);

function SourcePicker({ source, label, accounts, url, subdomains, manualLabel, initial, onChange, children }: {
  source: 'gsc' | 'ga4' | 'bing'; label: string; accounts: string[]; url: string; subdomains: boolean; manualLabel: string; initial?: SourceChoice;
  onChange: (choice: SourceChoice | null, on: boolean) => void; children?: React.ReactNode;
}) {
  const [on, setOn] = useState(Boolean(initial));
  const [account, setAccount] = useState(initial?.account ?? '');
  const [chosen, setChosen] = useState<string | null>(initial?.property ?? null);
  const [manual, setManual] = useState('');
  const activeAccount = accounts.includes(account) ? account : accounts[0] ?? '';
  const query = new URLSearchParams({ source, account: activeAccount, url, subdomains: String(subdomains) });
  const { data, error, loading } = useApi<PropertyList>(on && activeAccount ? `/api/properties?${query}` : null);
  const usingList = !error && (data?.properties.length ?? 0) > 0;
  const property = usingList ? chosen ?? data?.suggested ?? '' : manual.trim() || (chosen ?? '');
  const selected = data?.properties.find((p) => p.id === property);

  useEffect(() => {
    onChange(on && property ? { account: activeAccount, property } : null, on);
  }, [on, property, activeAccount]);

  if (accounts.length === 0) return <Check checked={false} disabled onChange={() => undefined} note={`Connect ${source === 'bing' ? 'a Bing API key' : 'a Google account'} first.`}>{label}</Check>;
  return (
    <>
      <Check checked={on} onChange={setOn}>{label}</Check>
      {on && (
        <div className="source-options">
          {accounts.length > 1 && (
            <div className="field"><label htmlFor={`${source}-account`}>Account</label>
              <select id={`${source}-account`} value={activeAccount} onChange={(e) => { setAccount(e.target.value); setChosen(null); }}>
                {accounts.map((a) => <option key={a} value={a}>{accountName(a)}</option>)}
              </select>
            </div>
          )}
          {loading && <p className="subtle">Loading properties...</p>}
          {usingList && (
            <div className="field"><label htmlFor={`${source}-property`}>Property</label>
              <select id={`${source}-property`} value={property} onChange={(e) => setChosen(e.target.value)}>
                <option value="">Choose a property</option>
                {data!.properties.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </div>
          )}
          {selected && !selected.covers && <p className="status-warn">This property may not cover everything in this crawl, so some pages could show no data.</p>}
          {!usingList && !loading && (
            <div className="field"><label htmlFor={`${source}-manual`}>{manualLabel}</label>
              <input id={`${source}-manual`} type="text" value={manual || chosen || ''} onChange={(e) => setManual(e.target.value)} />
            </div>
          )}
          {error && <p className="status-bad">Could not list properties: {error}</p>}
          {children}
        </div>
      )}
    </>
  );
}

/** Reports a complete form upward. `ready` is false while a chosen source has no property yet. */
export function TrafficFields({ url, subdomains, initial, onChange, onConnections }: { url: string; subdomains: boolean; initial?: SavedPlan | null; onChange: (form: TrafficForm | null) => void; onConnections: () => void }) {
  const { data: connections } = useApi<Connections>('/api/connections');
  const debouncedUrl = useDebounced(url);
  const [days, setDays] = useState(initial?.days ?? 30);
  const [gsc, setGsc] = useState<{ choice: SourceChoice | null; on: boolean }>({ choice: null, on: false });
  const [ga4, setGa4] = useState<{ choice: SourceChoice | null; on: boolean }>({ choice: null, on: false });
  const [bing, setBing] = useState<{ choice: SourceChoice | null; on: boolean }>({ choice: null, on: false });
  const [topQueries, setTopQueries] = useState(Boolean(initial?.gsc?.topQueries));
  const [inspect, setInspect] = useState(Boolean(initial?.gsc?.inspect));
  const [limit, setLimit] = useState(String(initial?.gsc?.inspect?.limit ?? connections?.inspections.default ?? 500));

  useEffect(() => {
    const anyOn = gsc.on || ga4.on || bing.on;
    if (!anyOn) {
      onChange(null);
      return;
    }
    const limitNumber = Number(limit);
    const limitOk = !gsc.on || !inspect || (Number.isInteger(limitNumber) && limitNumber >= 1 && limitNumber <= (connections?.inspections.max ?? 2000));
    onChange({
      days,
      gsc: gsc.choice ? { ...gsc.choice, topQueries, inspect: inspect ? limitNumber : null } : null,
      ga4: ga4.choice,
      bing: bing.choice,
      ready: limitOk && (!gsc.on || Boolean(gsc.choice)) && (!ga4.on || Boolean(ga4.choice)) && (!bing.on || Boolean(bing.choice)),
    });
  }, [days, gsc, ga4, bing, topQueries, inspect, limit]);

  if (!connections) return null;
  const googleAccounts = connections.google.accounts;
  const nothingConnected = googleAccounts.length === 0 && connections.bing.accounts.length === 0;
  return (
    <>
      {(gsc.on || ga4.on || bing.on) && (
        <div className="range-row">
          <span>Date range</span>
          <div className="segments" role="group" aria-label="Date range">
            {connections.days.map((value) => <button type="button" key={value} aria-pressed={days === value} onClick={() => setDays(value)}>{value} days</button>)}
          </div>
        </div>
      )}
      <SourcePicker source="gsc" label="Google Search Console" accounts={googleAccounts} url={debouncedUrl} subdomains={subdomains} manualLabel="Property, such as sc-domain:example.com" initial={initial?.gsc} onChange={(choice, on) => setGsc({ choice, on })}>
        <Check checked={topQueries} onChange={setTopQueries} note="Slower on large sites. Keeps the top 10 queries per page.">Top queries per page</Check>
        <Check checked={inspect} onChange={setInspect} note={`Google index status for each page. Google allows ${connections.inspections.max.toLocaleString('en-US')} a day per property.`}>URL Inspection</Check>
        {inspect && <div className="field"><label htmlFor="inspect-limit">URLs to inspect</label><input id="inspect-limit" type="number" min="1" max={connections.inspections.max} value={limit} onChange={(e) => setLimit(e.target.value)} /></div>}
      </SourcePicker>
      <SourcePicker source="ga4" label="Google Analytics 4" accounts={googleAccounts} url={debouncedUrl} subdomains={subdomains} manualLabel="Numeric GA4 property ID" initial={initial?.ga4} onChange={(choice, on) => setGa4({ choice, on })} />
      <SourcePicker source="bing" label="Bing Webmaster Tools" accounts={connections.bing.accounts} url={debouncedUrl} subdomains={subdomains} manualLabel="Site URL, such as https://www.example.com/" initial={initial?.bing && { account: initial.bing.account, property: initial.bing.site }} onChange={(choice, on) => setBing({ choice, on })} />
      {bing.on && <small className="subtle">Bing doesn't take a date range and updates weekly, so its range can be approximate. Results show the period it actually covers.</small>}
      {nothingConnected && <button type="button" className="btn fit" onClick={onConnections}>Set up connections</button>}
    </>
  );
}

const noData = (pull: Pull) => pull.status === 'ok' && pull.source !== 'url_inspection' && pull.row_count === 0;

function pullSummary(pull: Pull): string {
  if (pull.source === 'url_inspection') return pull.note ?? '';
  const period = pull.days && pull.start_date ? `${pull.days} days (${pull.start_date} to ${pull.end_date})` : pull.end_date ? `Bing's reported period, to ${pull.end_date}` : "Bing's reported period";
  if (noData(pull)) return `No data returned for ${period}.`;
  const notInCrawl = pull.row_count - pull.matched - pull.dropped;
  return `${period}. ${pull.matched.toLocaleString('en-US')} of ${pull.row_count.toLocaleString('en-US')} rows match crawled pages${notInCrawl > 0 ? `, ${notInCrawl.toLocaleString('en-US')} not in crawl` : ''}${pull.dropped > 0 ? `, ${pull.dropped.toLocaleString('en-US')} outside this crawl's scope` : ''}.`;
}

export function TrafficStrip({ crawl, overview, refresh, onChanged, onConnections }: { crawl: string; overview: { startUrl: string | null; status: string | null; running: boolean }; refresh: number; onChanged: () => void; onConnections: () => void }) {
  const { data } = useApi<{ pulls: Pull[]; plan: SavedPlan | null; subdomains: boolean }>(`/api/crawls/${crawl}/traffic`, refresh);
  const [form, setForm] = useState<TrafficForm | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!data || overview.status !== 'finished') return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setError(null);
    post(`/api/crawls/${crawl}/traffic`, { traffic: trafficFromForm(form) }).then(() => { setOpen(false); onChanged(); }, (e) => setError(e.message));
  };
  const inspectMore = () => {
    setError(null);
    post(`/api/crawls/${crawl}/inspect`, {}).then(onChanged, (e) => setError(e.message));
  };
  const empty = data.pulls.filter(noData).length;
  const failed = data.pulls.filter((pull) => pull.status !== 'ok').length;
  return (
    <div className="traffic-strip">
      {data.pulls.length > 0 && (
        <details>
          <summary>
            {data.pulls.length} data source{data.pulls.length === 1 ? '' : 's'}
            {empty > 0 && <span className="status-warn"> · {empty} returned no data</span>}
            {failed > 0 && <span className="status-bad"> · {failed} failed</span>}
            <span className="subtle"> · Details</span>
          </summary>
          <div className="panel"><table>
            <thead><tr><th>Source</th><th>Property</th><th>Coverage</th></tr></thead>
            <tbody>{data.pulls.map((pull) => (
              <tr key={pull.source}>
                <td>{SOURCE_LABELS[pull.source] ?? pull.source}</td>
                <td className="url">{pull.property}{pull.account ? <small className="subtle block">{accountName(pull.account)}</small> : null}</td>
                <td>
                  {pull.status === 'ok' && <span className={noData(pull) ? 'status-warn' : undefined}>{pullSummary(pull)}</span>}
                  {pull.status === 'ok' && pull.source !== 'url_inspection' && pull.note && <small className="subtle block">{pull.note}</small>}
                  {pull.error && <span className="status-bad block">{pull.status === 'ok' ? 'The last refresh failed, so this is earlier data: ' : ''}{pull.error}</span>}
                  {pull.source === 'url_inspection' && pull.status === 'ok' && !overview.running && <button className="btn inline-action" onClick={inspectMore}>Inspect more</button>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        </details>
      )}
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>{data.pulls.length > 0 ? 'Change date range or sources' : 'Add search and analytics data'}</summary>
        {open && (
          <form className="panel traffic-form" onSubmit={submit}>
            <TrafficFields url={overview.startUrl ?? ''} subdomains={data.subdomains} initial={data.plan} onChange={setForm} onConnections={onConnections} />
            <button className="btn primary fit" disabled={!form?.ready || overview.running}>Pull data</button>
          </form>
        )}
      </details>
      {error && <Failure message={error} />}
    </div>
  );
}

export function ConnectionsView() {
  const [changes, setChanges] = useState(0);
  const { data, error } = useApi<Connections>('/api/connections', changes);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [editingClient, setEditingClient] = useState(false);
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [action, setAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const reload = () => setChanges((n) => n + 1);
  const pending = data?.google.signIn?.state === 'pending';

  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(reload, 1500);
    return () => clearInterval(timer);
  }, [pending]);

  if (error) return <Failure message={error} />;
  if (!data) return null;

  const run = (work: Promise<unknown>, done?: () => void) => {
    setAction(null);
    work.then(() => { done?.(); reload(); }, (e) => setAction(e.message));
  };
  const saveClient = (event: FormEvent) => {
    event.preventDefault();
    run(post('/api/connections/google/client', { clientId, clientSecret }), () => { setClientId(''); setClientSecret(''); setEditingClient(false); });
  };
  const saveBing = (event: FormEvent) => {
    event.preventDefault();
    setMessage(null);
    setAction(null);
    post<{ sites: number }>('/api/connections/bing/key', { label, key }).then(({ sites }) => {
      setMessage(`Saved. This key can see ${sites} site${sites === 1 ? '' : 's'}.`);
      setLabel('');
      setKey('');
      reload();
    }, (e) => setAction(e.message));
  };
  const disconnect = (provider: 'google' | 'bing', account: string) => window.confirm(`Remove ${accountName(account)}? You'd need to ${provider === 'google' ? 'sign in' : 'add the key'} again to use it.`) && run(post(`/api/connections/${provider}/${encodeURIComponent(account)}/disconnect`, {}));
  const signIn = data.google.signIn;
  const showClientForm = !data.google.clientConfigured || editingClient;

  return (
    <div className="connections">
      <h1>Connections</h1>
      <p className="subtle">Credentials stay in your Mac's Keychain. SSAK only asks for read access to these services.</p>
      <div className="panel connection-group">
        <h3>Google (Search Console and GA4)</h3>
        {showClientForm ? (
          <form onSubmit={saveClient}>
            <ol className="subtle">
              <li>In Google Cloud, enable the Search Console, Analytics Data and Analytics Admin APIs.</li>
              <li>Create an OAuth client of type Desktop app.</li>
              <li>Set the consent screen to In production, so sign-ins don't expire after 7 days.</li>
            </ol>
            <div className="field"><label htmlFor="client-id">Client ID</label><input id="client-id" type="text" autoComplete="off" value={clientId} onChange={(e) => setClientId(e.target.value)} /></div>
            <div className="field"><label htmlFor="client-secret">Client secret</label><input id="client-secret" type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></div>
            <div className="toolbar">
              <button className="btn primary" disabled={!clientId.trim() || !clientSecret.trim()}>Save client</button>
              {editingClient && <button type="button" className="btn" onClick={() => setEditingClient(false)}>Cancel</button>}
            </div>
          </form>
        ) : (
          <>
            {data.google.accounts.length === 0 && <p className="subtle">No accounts connected yet.</p>}
            {data.google.accounts.map((account) => (
              <div className="connection-row" key={account}>
                <span>{accountName(account)}{account === 'default' && <small className="subtle block">Sign in again to name this account. That replaces this entry.</small>}</span>
                <button className="btn" onClick={() => disconnect('google', account)}>Disconnect</button>
              </div>
            ))}
            <div className="toolbar">
              <button className="btn primary" disabled={pending} onClick={() => run(post('/api/connections/google/login', {}))}>{pending ? 'Waiting for Google...' : data.google.accounts.length ? 'Connect another account' : 'Sign in with Google'}</button>
              {pending && <button className="btn" onClick={() => run(post('/api/connections/google/login/cancel', {}))}>Cancel</button>}
              <button className="btn" onClick={() => setEditingClient(true)}>Change OAuth client</button>
            </div>
            {pending && <p className="subtle">Finish signing in in your browser. Google may warn that the app is unverified, because it's your own client.</p>}
            {signIn?.state === 'failed' && <p className="status-bad">{signIn.error}</p>}
            {signIn?.state === 'done' && <p className="status-ok">Connected {accountName(signIn.account ?? '')}.</p>}
          </>
        )}
      </div>
      <div className="panel connection-group">
        <h3>Bing Webmaster Tools</h3>
        {data.bing.accounts.map((account) => (
          <div className="connection-row" key={account}><span>{account}</span><button className="btn" onClick={() => disconnect('bing', account)}>Remove</button></div>
        ))}
        <form onSubmit={saveBing}>
          <p className="subtle">Create a key in Bing Webmaster Tools under Settings, then API Access. SSAK checks it before saving. Add one for each Bing login you use.</p>
          <div className="field-row">
            <div className="field"><label htmlFor="bing-label">Name for this key</label><input id="bing-label" type="text" autoComplete="off" value={label} onChange={(e) => setLabel(e.target.value)} /></div>
            <div className="field"><label htmlFor="bing-key">API key</label><input id="bing-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} /></div>
          </div>
          <button className="btn primary" disabled={!label.trim() || !key.trim()}>Save key</button>
        </form>
        {message && <p className="status-ok">{message}</p>}
      </div>
      <div className="panel connection-group">
        <h3>Other services</h3>
        <div className="connection-row"><span>DataForSEO</span>{data.other.dataforseo ? <span className="status-ok">Connected</span> : <span className="subtle">Not set up. Run: sak key set dataforseo</span>}</div>
        <div className="connection-row"><span>PageSpeed Insights key</span>{data.other.pagespeed ? <span className="status-ok">Connected</span> : <span className="subtle">Optional. Run: sak key set pagespeed</span>}</div>
      </div>
      {action && <Failure message={action} />}
    </div>
  );
}
