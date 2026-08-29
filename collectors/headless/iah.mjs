// ============================================================================
// IAH (George Bush Intercontinental, Houston) first-party security-wait
// collector (HEADLESS / Puppeteer).
//
// Reads the wait times Houston Airports *publicly displays* to every traveler
// on https://www.fly2houston.com/iah/security/ . robots.txt allows it
// (fly2houston.com serves an empty robots.txt => nothing disallowed). The
// page's OWN client-side JavaScript calls the Houston Airports API
// (api.houstonairports.mobi/wait-times/checkpoint/iah) using its OWN embedded
// API key and renders the numbers; that endpoint returns 401 without the key,
// and the key lives only in the page's client-side JS — it is NOT published in
// a public URL the way PHX's is. Per project rules we therefore do NOT touch,
// extract, or reuse that key: we load the page like any browser and read what
// it DISPLAYS. One gentle page load per run.
//
// ISOLATION: this file lives in collectors/headless/ (never copied into the
// web/Vercel bundle by the prebuild step) and is NOT imported by
// src/firstparty/index.mjs. It runs ONLY via the standalone GitHub Actions
// runner. Puppeteer/Chromium must never leak into the serverless bundle.
//
// DOM contract (discovered by loading the live page):
//   Each checkpoint is an InfoCard. Within it:
//     <h5 [class*="InfoCardTitle"]> e.g. "IAH Terminal A North Standard"
//     <div [class*="InfoCardRemark"]> the wait value, e.g. "3 min" (or a
//        "Closed"/no-number state when the lane is not open).
//   The title's trailing word is the lane:
//     "... Standard" -> standard lane
//     "... PreCheck" -> TSA PreCheck lane
//     "... Premier"  -> airline premium lane; excluded from both standard and
//                       precheck (not the standard TSA lane).
//   The Emotion hash prefixes (css-xxxx-) rotate on rebuilds, but the semantic
//   suffixes (InfoCardTitle / InfoCardRemark) are stable, so we key off those
//   substrings plus the lane word in the title TEXT, never the hashed prefixes.
//   Ranges/loose text are parsed to a conservative upper bound (matching DFW).
// ============================================================================

import { nowIso } from '../lib/contract.mjs';

const URL = 'https://www.fly2houston.com/iah/security/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const NAV_TIMEOUT_MS = 45000;    // initial navigation
const DEFAULT_TIMEOUT_MS = 30000; // page default (per task)
const RENDER_TIMEOUT_MS = 30000; // wait for checkpoint numbers to appear

// In-page: read every rendered security InfoCard -> { name, lane, remark }.
// Keyed off stable semantic class-name suffixes + the lane word in the title,
// not the rotating Emotion hashes.
const SCRAPE_CARDS = () => {
  const titles = Array.from(document.querySelectorAll('[class*="InfoCardTitle"]'))
    .filter((el) => !/Section|Icon/i.test(el.className));
  const out = [];
  for (const titleEl of titles) {
    const name = (titleEl.textContent || '').trim();
    if (!/\b(standard|precheck|premier)\b/i.test(name)) continue; // security cards only
    // Climb to the smallest ancestor that also holds this card's wait remark.
    let root = titleEl;
    for (let i = 0; i < 8 && root.parentElement; i++) {
      root = root.parentElement;
      if (root.querySelector('[class*="InfoCardRemark"]')) break;
    }
    const remarkEl = root.querySelector('[class*="InfoCardRemark"]');
    const remark = (remarkEl?.textContent || '').trim();
    out.push({ name, remark });
  }
  return out;
};

/** Minutes from display text. Ranges "6 - 10 min" -> 10 (conservative upper
 *  bound), "less than 5"/"< 5" -> 5, "20+ min" -> 20, "7 min" -> 7. */
function parseMinutes(text) {
  const t = String(text).toLowerCase();
  const range = /(\d+)\s*[-–]\s*(\d+)/.exec(t);        // "6 - 10" -> 10
  if (range) return Number(range[2]);
  if (/(less than|under|<)\s*\d+/.test(t)) {           // "< 5" -> 5 (upper bound)
    const n = /(\d+)/.exec(t); return n ? Number(n[1]) : null;
  }
  const plus = /(\d+)\s*\+/.exec(t);                    // "20+" -> 20
  if (plus) return Number(plus[1]);
  const n = /(\d+)/.exec(t);
  return n ? Number(n[1]) : null;
}

/** A remark -> { status:'Open'|'Closed', waitMin:number|null }. Open iff a
 *  numeric wait renders; explicit Closed/Unavailable text or no number -> Closed. */
function parseRemark(remark) {
  const t = String(remark || '').trim();
  if (/clos|unavail|not\s*open|--/i.test(t) || !/\d/.test(t)) {
    return { status: 'Closed', waitMin: null };
  }
  const waitMin = parseMinutes(t);
  return Number.isFinite(waitMin)
    ? { status: 'Open', waitMin }
    : { status: 'Closed', waitMin: null };
}

/** Clean checkpoint name: drop the "IAH " prefix and the trailing lane word. */
function cleanName(name) {
  return String(name)
    .replace(/^\s*IAH\s+/i, '')
    .replace(/\s+(standard|precheck|premier)\s*$/i, '')
    .trim();
}

const isStandard = (name) => /\bstandard\b/i.test(name);
const isPre = (name) => /\bprecheck\b/i.test(name);

export async function collect(ctx) {
  const log = ctx?.log ?? (() => {});
  let puppeteer;
  try {
    ({ default: puppeteer } = await import('puppeteer'));
  } catch (err) {
    log(`iah: puppeteer not available (${err?.message ?? err}); skipping`);
    return [];
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 900 });
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);

    await page.goto(URL, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });

    // Wait for the page's own JS to fetch + render the wait numbers: at least one
    // InfoCardRemark showing a numeric wait or an explicit closed state.
    try {
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll('[class*="InfoCardRemark"]')).some((el) =>
          /(\d+\s*min|clos|unavail)/i.test(el.textContent || '')),
        { timeout: RENDER_TIMEOUT_MS, polling: 500 },
      );
    } catch {
      const errored = await page.evaluate(() =>
        /wait times? (are|is)?\s*(currently )?unavailable|unable to (load|retrieve)/i
          .test(document.body?.innerText || '')).catch(() => false);
      log(`iah: security wait times did not render${errored ? ' (page error/unavailable state)' : ''}; returning []`);
      return [];
    }

    const cards = await page.evaluate(SCRAPE_CARDS);
    if (!cards.length) {
      log('iah: no checkpoint cards parsed from rendered DOM; returning []');
      return [];
    }

    // Split into Standard (standard) vs PreCheck; Premier lanes are ignored.
    const standardLanes = []; // { name, waitMin, status }
    const preLanes = [];      // { name, waitMin, status }
    for (const card of cards) {
      const parsed = parseRemark(card.remark);
      const row = { name: cleanName(card.name), waitMin: parsed.waitMin, status: parsed.status };
      if (isStandard(card.name)) standardLanes.push(row);
      else if (isPre(card.name)) preLanes.push(row);
    }

    if (standardLanes.length === 0) {
      log('iah: no Standard-lane checkpoints parsed from rendered DOM; returning []');
      return [];
    }

    // standardMin = MAX over OPEN standard-lane checkpoints (null if none open).
    const openStandard = standardLanes
      .filter((c) => c.status === 'Open' && Number.isFinite(c.waitMin))
      .map((c) => c.waitMin);
    const standardMin = openStandard.length ? Math.max(...openStandard) : null;

    // precheckMin = MAX over OPEN PreCheck-lane checkpoints (null if none open).
    const openPre = preLanes
      .filter((c) => c.status === 'Open' && Number.isFinite(c.waitMin))
      .map((c) => c.waitMin);
    const precheckMin = openPre.length ? Math.max(...openPre) : null;

    // precheckOpen: true if any PreCheck lane open; false if present-but-closed;
    // null if PreCheck not shown at all.
    let precheckOpen = null;
    if (preLanes.length) precheckOpen = preLanes.some((c) => c.status === 'Open');

    const checkpoints = standardLanes.map((c) => ({
      name: c.name, waitMin: c.waitMin, status: c.status,
    }));

    const reading = {
      source: 'firstparty',
      airport: 'IAH',
      kind: 'security_wait',
      observedAt: nowIso(),
      payload: { standardMin, precheckOpen, precheckMin, checkpoints },
    };

    log(`iah: ${checkpoints.length} checkpoints, standardMin=${standardMin}, ` +
      `precheckOpen=${precheckOpen}, precheckMin=${precheckMin}`);
    return [reading];
  } catch (err) {
    // Unexpected failure (launch/nav). Log and return [] — IAH then stays on the
    // reseller baseline via the existing fallback. Never throw for a render miss.
    log(`iah: unexpected error, returning [] (${err?.message ?? err})`);
    return [];
  } finally {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  }
}
