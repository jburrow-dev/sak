// Diffs a SAK crawl against a Screaming Frog export of the same site.
//   node scripts/compare-sf.ts <sak-crawl-id> <sf-internal.ndjson>
// Export with the SF MCP tool: sf_export_seo_element_urls, element "Internal", filter "All".
import { readFileSync } from 'node:fs';
import { listUrls, withCrawl, type UrlListRow } from '@sak/core';

const [id, file] = process.argv.slice(2);
if (!id || !file) throw new Error('Usage: node scripts/compare-sf.ts <sak-crawl-id> <sf-internal.ndjson>');

const sf = new Map<string, any>(
  readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).map((row) => [row.Address, row]),
);
const sak = new Map<string, UrlListRow>();
withCrawl(id, (db) => {
  for (let offset = 0; ; offset += 1000) {
    const { items } = listUrls(db, { kind: 'page', limit: 1000, offset });
    for (const row of items) sak.set(row.url, row);
    if (items.length < 1000) break;
  }
});

const fields: [string, (row: any) => unknown, (row: any) => unknown][] = [
  ['status', (r) => r.status ?? null, (r) => r['Status Code'] || null],
  ['indexable', (r) => r.indexable === 1, (r) => r.Indexability === 'Indexable'],
  ['title', (r) => r.title ?? null, (r) => r['Title 1'] ?? null],
  ['meta', (r) => r.meta_description ?? null, (r) => r['Meta Description 1'] ?? null],
  ['h1', (r) => r.h1 ?? null, (r) => r['H1-1'] ?? null],
  ['canonical', (r) => r.canonical ?? null, (r) => r['Canonical Link Element 1'] ?? null],
  ['redirect', (r) => r.redirect_target ?? null, (r) => r['Redirect URL'] ?? null],
  ['depth', (r) => r.depth ?? null, (r) => r['Crawl Depth'] ?? null],
  ['inlinks', (r) => r.inlinks, (r) => r['Unique Inlinks'] ?? 0],
  ['word_count', (r) => r.word_count ?? 0, (r) => r['Word Count'] ?? 0],
];

const onlySak = [...sak.keys()].filter((u) => !sf.has(u));
const onlySf = [...sf.keys()].filter((u) => !sak.has(u));
// SF lists scripts, CSS and images as internal URLs by default. SAK v1 doesn't crawl those.
const isHtml = (url: string) => /html/i.test(String(sf.get(url)['Content Type'] ?? ''));
const onlySfPages = onlySf.filter(isHtml);
const resources = new Map<string, number>();
for (const url of onlySf.filter((u) => !isHtml(u))) {
  const type = String(sf.get(url)['Content Type'] ?? `no type (status ${sf.get(url)['Status Code']})`).split(';')[0];
  resources.set(type, (resources.get(type) ?? 0) + 1);
}
console.log(`URLs: SAK ${sak.size}, Screaming Frog ${sf.size}, in both ${sak.size - onlySak.length}`);
console.log(`Only in SAK: ${onlySak.length}`);
for (const url of onlySak.slice(0, 40)) console.log(`  ${url} (status ${sak.get(url)!.status})`);
console.log(`Only in SF, HTML pages: ${onlySfPages.length}`);
for (const url of onlySfPages.slice(0, 40)) console.log(`  ${url} (status ${sf.get(url)['Status Code']})`);
console.log(`Only in SF, other: ${onlySf.length - onlySfPages.length} ${JSON.stringify(Object.fromEntries(resources))}`);

for (const [name, fromSak, fromSf] of fields) {
  const differences: string[] = [];
  let compared = 0;
  for (const [url, row] of sak) {
    const other = sf.get(url);
    if (!other) continue;
    compared += 1;
    const a = fromSak(row);
    const b = fromSf(other);
    if (a !== b) differences.push(`  ${url}: SAK ${JSON.stringify(a)}, SF ${JSON.stringify(b)}`);
  }
  console.log(`${name}: ${compared - differences.length}/${compared} match`);
  if (name === 'word_count') {
    const close = [...sak].filter(([url, row]) => {
      const other = sf.get(url);
      if (!other) return false;
      const a = Number(fromSak(row));
      const b = Number(fromSf(other));
      return Math.abs(a - b) <= Math.max(2, b * 0.05);
    }).length;
    console.log(`  within 5%: ${close}/${compared}`);
  }
  for (const line of differences.slice(0, name === 'word_count' ? 8 : 40)) console.log(line);
}
