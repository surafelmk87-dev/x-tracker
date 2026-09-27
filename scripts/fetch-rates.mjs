// Builds rates.json for the tracker. Runs in GitHub Actions (server side),
// so there are no browser CORS limits on reading provider websites.
import { writeFile, mkdir } from 'node:fs/promises';

const CURRENCIES = ['USD','EUR','GBP','MXN','AUD','CNY','JPY','NZD','ZAR','CHF','ETB'];
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// ---------- Browser (shared) ----------
// Bank calculators are JavaScript apps, so we load them in headless Chromium
// and read the rendered text, exactly as a visitor would see it.
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = import('playwright').then(({ chromium }) => chromium.launch());
  }
  return browserPromise;
}

async function renderedText(url) {
  const browser = await getBrowser();
  const page = await browser.newPage({ userAgent: UA });
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(4000); // let late scripts fill in rates
    // textContent includes collapsed accordions / hidden rows that innerText skips.
    const text = await page.evaluate(() => {
      const walk = (n) => n.nodeType === 3 ? n.textContent : [...n.childNodes].map(walk).join('\n');
      return walk(document.body).replace(/\n\s*\n+/g, '\n');
    });
    await mkdir('data/raw', { recursive: true });
    const slug = new URL(url).hostname.replace(/[^a-z0-9]+/gi, '_');
    await writeFile(`data/raw/page_${slug}.txt`, text);
    return text;
  } finally {
    await page.close();
  }
}

// ---------- TD Canada Trust ----------
// https://ix0.apps.td.com/en/fxcal/ (embedded in td.com's currency-converter page)
// lists a "Cash exchange rates" table. Each entry looks like:
//   US DOLLAR (USD)  1.4603  Client sells at: (Receives Canadian $)  1.3645
// First number = CAD you pay per unit (you buy); second = CAD you receive per unit (you sell).
function parseTDCash(text) {
  const start = text.search(/Cash exchange rates/i);
  const end = text.search(/Non-cash exchange rates/i);
  if (start === -1) throw new Error('TD: cash table not found');
  const cash = text.slice(start, end > start ? end : undefined);

  const headers = [...cash.matchAll(/\(([A-Z]{3})\)/g)];
  const rates = {};
  headers.forEach((h, i) => {
    const seg = cash.slice(h.index + h[0].length, headers[i + 1]?.index ?? cash.length);
    const [beforeSells, afterSells] = seg.split(/Client sells at/i);
    if (afterSells === undefined) return;
    const num = (str) => { const m = str.match(/(\d*\.\d+|\d+)(?![^(]*\))/); return m ? parseFloat(m[1]) : null; };
    const buy = num(beforeSells);
    const sell = num(afterSells.replace(/\(Receives Canadian \$\)/i, ''));
    if (h[1] !== 'CAD' && buy > 0 && sell > 0 && buy > sell) rates[h[1]] = { buy, sell };
  });
  if (Object.keys(rates).length < 5) throw new Error(`TD: only parsed ${Object.keys(rates).length} currencies`);
  return rates;
}

async function fetchTD() {
  return parseTDCash(await renderedText('https://ix0.apps.td.com/en/fxcal/'));
}

// ---------- Scotiabank ----------
// Scotiabank Canada only publishes NON-CASH rates (wires, drafts, transfers up to $9,999).
// The table is drawn by JavaScript, so we read the rendered page. Rows contain a
// currency code followed by two rates; the higher is what you pay (buy), the lower
// what you receive (sell). The page's own sanity check rejects anything that doesn't
// bracket the market rate (e.g. a currency quoted per 100 units).
function parseScotia(text) {
  // Rows read as: "U.S. Dollar ( USD ) 1.461100 1.364100" (split across lines in the page text).
  const rates = {};
  const flat = text.replace(/\s+/g, ' ');
  for (const [, code, a, b] of flat.matchAll(/\(\s*([A-Z]{3})\s*\)\s*(\d*\.\d+)\s+(\d*\.\d+)/g)) {
    const x = parseFloat(a), y = parseFloat(b);
    if (code === 'CAD' || !(x > 0 && y > 0) || x === y || rates[code]) continue;
    rates[code] = { buy: Math.max(x, y), sell: Math.min(x, y) };
  }
  if (Object.keys(rates).length < 5) throw new Error(`Scotiabank: only parsed ${Object.keys(rates).length} currencies`);
  return rates;
}

async function fetchScotia() {
  const text = await renderedText('https://www.scotiabank.com/ca/en/personal/rates-prices/foreign-exchange-rates.html');
  await mkdir('data/raw', { recursive: true });
  await writeFile('data/raw/Scotiabank.txt', text); // kept so the parser can be checked against the real page
  return parseScotia(text);
}

// ---------- RBC Royal Bank ----------
// RBC's calculator asks its server for one conversion at a time:
//   POST .../api/rates/  {"do":"conv","from":"CAD","to":"USD","trade":"sell","amount":100}
// and gets back {"amount": "69.185...", ...} (USD received for 100 CAD).
// We ask the same questions from inside RBC's own page (so its cookies apply).
// These are RBC's default NON-CASH rates.
const RBC_PAGE = 'https://apps.royalbank.com/apps/foreign-exchange-calculator';
const RBC_API = 'https://apps.royalbank.com/apps/foreign-exchange-calculator/api/rates/';

async function fetchRBC(codes) {
  const browser = await getBrowser();
  const page = await browser.newPage({ userAgent: UA });
  const scripts = [];
  page.on('response', async (r) => {
    if (r.request().resourceType() !== 'script' || !r.url().includes('royalbank')) return;
    try {
      const t = await r.text();
      const i = t.indexOf('"conv"') >= 0 ? t.indexOf('"conv"') : t.indexOf("'conv'");
      if (i >= 0) scripts.push({ url: r.url(), snippet: t.slice(Math.max(0, i - 3000), i + 3000) });
    } catch {}
  });
  try {
    await page.goto(RBC_PAGE, { waitUntil: 'networkidle', timeout: 60000 });
    await mkdir('data/raw', { recursive: true });
    await writeFile('data/raw/RBC_scripts.json', JSON.stringify(scripts, null, 2)); // to find the cash switch later

    // Use the calculator's own convert function so the request is formatted exactly as RBC expects.
    await page.waitForFunction(() => window.APP && typeof window.APP.convert === 'function', null, { timeout: 30000 });
    const results = await page.evaluate(async (codes) => {
      const conv = (from, to, trade) => new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), 15000);
        window.APP.convert(from, to, trade, 100, (d) => { clearTimeout(t); resolve(d); });
      });
      const out = {};
      for (const c of codes) {
        const b = await conv('CAD', c, 'sell');
        const s = await conv(c, 'CAD', 'buy');
        out[c] = { toForeign: parseFloat(b?.amount), toCAD: parseFloat(s?.amount) };
      }
      return out;
    }, codes);

    const rates = {};
    for (const [c, v] of Object.entries(results)) {
      if (!(v.toForeign > 0 && v.toCAD > 0)) continue;
      const buy = 100 / v.toForeign;   // CAD you pay per unit
      const sell = v.toCAD / 100;      // CAD you receive per unit
      if (buy > sell) rates[c] = { buy: +buy.toPrecision(6), sell: +sell.toPrecision(6) };
    }
    if (Object.keys(rates).length < 3) throw new Error(`RBC: only ${Object.keys(rates).length} currencies (${JSON.stringify(results).slice(0, 300)})`);
    return rates;
  } finally {
    await page.close();
  }
}

// ---------- Other banks (capture only) ----------
// Saves every JSON response their calculators receive to data/raw/,
// so exact parsers can be written against the real payloads.
const CAPTURE_PAGES = {
  RBC: 'https://apps.royalbank.com/apps/foreign-exchange-calculator',
  // BMO, CIBC, Scotiabank: add calculator URLs here.
};

async function captureBanks() {
  await mkdir('data/raw', { recursive: true });
  const browser = await getBrowser();
  const status = {};
  for (const [bank, url] of Object.entries(CAPTURE_PAGES)) {
    const page = await browser.newPage({ userAgent: UA });
    const captured = [];
    // Keep every data request the calculator makes. Some servers label JSON as
    // text/plain, so we try to parse any fetch/XHR response rather than trusting the header.
    page.on('response', async (r) => {
      const kind = r.request().resourceType();
      if (kind !== 'xhr' && kind !== 'fetch') return;
      try {
        const text = await r.text();
        let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 20000); }
        captured.push({ url: r.url(), method: r.request().method(), postData: r.request().postData(), status: r.status(), body });
      } catch {}
    });
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(5000); // let the calculator finish loading its rates
      await writeFile(`data/raw/${bank}.json`, JSON.stringify(captured, null, 2));
      status[bank] = `captured ${captured.length} JSON responses`;
    } catch (e) {
      status[bank] = `failed: ${e.message}`;
    }
    await page.close();
  }
  return status;
}

// ---------- Global Currency Services (Guelph) ----------
// The raw HTML of /rates holds each currency's margin ("We Buy 0.015 / We Sell 0.016" for USD).
// GCS's own script then replaces those with real rates built from their live base rate
// (e.g. USD We Buy 1.39333 / We Sell 1.43718 = base 1.41455 −1.5% / +1.6%).
// We read both: the rendered page gives GCS's exact rates; the margins are the fallback.
const GCS_URL = 'https://www.global-currency.com/rates';
const GCS_RE = /Currency Code\s*([A-Z]{3})\s*We Buy\s*([0-9.]+)\s*We Sell\s*([0-9.]+)/g;

function parseGCS(text) {
  const out = {};
  for (const [, code, weBuy, weSell] of text.replace(/\s+/g, ' ').matchAll(GCS_RE)) {
    out[code] = { weBuy: parseFloat(weBuy), weSell: parseFloat(weSell) };
  }
  return out;
}

async function fetchGCS() {
  const res = await fetch(GCS_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`GCS HTTP ${res.status}`);
  const raw = parseGCS((await res.text()).replace(/<[^>]+>/g, ' '));

  const margins = {};
  for (const [code, v] of Object.entries(raw)) {
    if (v.weBuy < 0.5 && v.weSell < 0.5) margins[code] = { weBuyMargin: v.weBuy, weSellMargin: v.weSell };
  }

  // Rendered page: a value that changed from the raw margin is GCS's real rate.
  const rates = {};
  try {
    const shown = parseGCS(await renderedText(GCS_URL));
    for (const [code, v] of Object.entries(shown)) {
      const r = raw[code];
      const changed = !r || v.weBuy !== r.weBuy || v.weSell !== r.weSell;
      // We Sell = what you pay to buy the currency; We Buy = what you receive selling it.
      if (changed && v.weSell > v.weBuy && v.weBuy > 0) rates[code] = { buy: v.weSell, sell: v.weBuy };
    }
  } catch (e) {
    console.warn('GCS rendered read failed, using margins only:', e.message);
  }

  if (!Object.keys(margins).length && !Object.keys(rates).length) throw new Error('GCS: nothing parsed (page layout changed?)');
  return { margins, rates };
}

// ---------- Main ----------
const out = { generatedAt: new Date().toISOString(), currencies: CURRENCIES, providers: {} };

try {
  out.providers.gcs = { name: 'Global Currency Services', type: 'gcs', ...(await fetchGCS()),
                        fetchedAt: new Date().toISOString(), source: 'https://www.global-currency.com/rates' };
} catch (e) {
  console.error(e.message);
  out.providers.gcs = { name: 'Global Currency Services', error: e.message };
}

try {
  out.providers.td = { name: 'TD Bank', type: 'direct', rates: await fetchTD(),
                       fetchedAt: new Date().toISOString(), source: 'https://ix0.apps.td.com/en/fxcal/' };
} catch (e) {
  console.error(e.message);
  out.providers.td = { name: 'TD Bank', error: e.message };
}

try {
  out.providers.scotia = { name: 'Scotiabank', type: 'direct', rateType: 'non-cash', rates: await fetchScotia(),
                           fetchedAt: new Date().toISOString(), source: 'https://www.scotiabank.com/ca/en/personal/rates-prices/foreign-exchange-rates.html' };
} catch (e) {
  console.error(e.message);
  out.providers.scotia = { name: 'Scotiabank', error: e.message };
}

try {
  out.providers.rbc = { name: 'RBC Bank', type: 'direct', rateType: 'non-cash',
                        rates: await fetchRBC(CURRENCIES.filter(c => c !== 'ETB')),
                        fetchedAt: new Date().toISOString(), source: RBC_PAGE };
} catch (e) {
  console.error(e.message);
  out.providers.rbc = { name: 'RBC Bank', error: e.message };
}

try { out.bankCapture = await captureBanks(); }
catch (e) { out.bankCapture = { error: e.message }; }

if (browserPromise) await (await browserPromise).close().catch(() => {});

await writeFile('rates.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
