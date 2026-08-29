// ============================================================================
// CLT (Charlotte Douglas International) first-party security-wait collector
// (HEADLESS / Puppeteer).
//
// Reads the wait times CLT *publicly displays* to every traveler on
// https://www.cltairport.com/airport-info/security/ . robots.txt allows it
// (User-agent: * / Allow: /). The page's OWN client-side JavaScript fetches its
// data feed (api.cltairport.mobi, key-gated + robots-disallowed for direct use)
// and renders the numbers; we load the PUBLIC page like any browser and read
// what it DISPLAYS. We do NOT touch, extract, or reuse the feed's API key, and
// we never call the key-gated feed directly. One gentle page load per run.
//
// ISOLATION: this file lives in collectors/headless/ (never copied into the
// web/Vercel bundle by the prebuild step) and is NOT imported by
// src/firstparty/index.mjs. It runs ONLY via the standalone GitHub Actions
// runner. Puppeteer/Chromium must never leak into the serverless bundle.
//
// DOM contract (discovered by loading the live page):
//   The wait-times UI is client-rendered (Next.js + Emotion). Checkpoints are
//   grouped into ARIA lists: a <div role="list"> per section, each preceded by
//   a heading whose text ends in "Checkpoints" — "Standard Security
//   Checkpoints" (standard lane) and "TSA Pre✓ Checkpoints" (PreCheck lane).
//   Each checkpoint is an <a role="listitem"> containing:
//     - an <h3> checkpoint name  (e.g. "Checkpoint 1")
//     - a status line "Now Open" / "Now Closed"
//     - a wait value "<10 MIN" / "10 - 20 MIN" / "20+ MIN", or "Closed".
//   The Emotion hash classes (css-xxxx) rotate on rebuilds, so we key off the
//   STABLE ARIA roles (list / listitem), the <h3> name, and the section heading
//   text — never the hashed class names. A card reading "Now Closed"/"Closed"
//   (or with no number) is Closed; a numeric wait is Open. Ranges are captured
//   as a conservative upper bound ("10 - 20 MIN" -> 20) to match DFW/MCO.
// ============================================================================

import { nowIso } from '../lib/contract.mjs';

const URL = 'https://www.cltairport.com/airport-info/security/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const NAV_TIMEOUT_MS = 45000;    // initial navigation
const DEFAULT_TIMEOUT_MS = 30000; // page default (per task)
const RENDER_TIMEOUT_MS = 30000; // wait for checkpoint numbers to appear

// In-page: read every checkpoint card grouped by section heading.
// Returns [{ section, name, statusText, waitText }] keyed off stable ARIA roles.
const SCRAPE_CARDS = () => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const lists = Array.from(document.querySelectorAll('[role="list"]'));
  const out = [];
  for (const list of lists) {
    // Find the nearest preceding heading whose text ends in "Checkpoints"
    // (walking previous siblings, climbing ancestors as needed).
    let heading = null;
    let node = list;
    while (node && !heading) {
      let sib = node.previousElementSibling;
      while (sib) {
        const t = norm(sib.textContent);
        if (/checkpoints$/i.test(t) && t.length < 60) { heading = t; break; }
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    if (!heading) continue; // skip non-checkpoint lists (e.g. info links)

    const items = Array.from(list.querySelectorAll('[role="listitem"]'));
    for (const it of items) {
      const h3 = it.querySelector('h3');
      const name = norm(h3?.textContent);
      if (!name || !/checkpoint/i.test(name)) continue;
      const raw = norm(it.innerText);
      const statusMatch = /now\s+(open|closed)/i.exec(raw);
      const statusText = statusMatch ? statusMatch[0] : '';
      // Isolate the wait value: strip the name, the status line, and the
      // "(opens in a new window)" affordance; what remains is "<10 MIN" etc.
      let waitText = raw;
      if (name) waitText = waitText.split(name).join(' ');
      waitText = waitText
        .replace(/now\s+(open|closed)/ig, ' ')
        .replace(/\(opens in a new window\)/ig, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      out.push({ section: heading, name, statusText, waitText });
    }
  }
  return out;
};

/** Minutes from display text. Ranges "10 - 20 MIN" -> 20 (conservative upper
 *  bound), "less than 10"/"<10" -> 10, "20+ MIN" -> 20, "7 min" -> 7. */
function parseMinutes(text) {
  const t = String(text).toLowerCase();
  const range = /(\d+)\s*[-–]\s*(\d+)/.exec(t);        // "10 - 20" -> 20
  if (range) return Number(range[2]);
  if (/(less than|under|<)\s*\d+/.test(t)) {           // "<10" -> 10 (upper bound)
    const n = /(\d+)/.exec(t); return n ? Number(n[1]) : null;
  }
  const plus = /(\d+)\s*\+/.exec(t);                    // "20+" -> 20
  if (plus) return Number(plus[1]);
  const n = /(\d+)/.exec(t);
  return n ? Number(n[1]) : null;
}

/** A card -> { status:'Open'|'Closed', waitMin:number|null }. Closed if the
 *  status says closed, the wait reads Closed/Unavailable, or no number renders. */
function parseCard(card) {
  const statusClosed = /closed/i.test(card.statusText);
  const wt = String(card.waitText || '').trim();
  if (statusClosed || /clos|unavail|not\s*open|--/i.test(wt) || !/\d/.test(wt)) {
    return { status: 'Closed', waitMin: null };
  }
  const waitMin = parseMinutes(wt);
  return Number.isFinite(waitMin)
    ? { status: 'Open', waitMin }
    : { status: 'Closed', waitMin: null };
}

const isStandard = (section) => /standard/i.test(section);
const isPre = (section) => /pre/i.test(section);

export async function collect(ctx) {
  const log = ctx?.log ?? (() => {});
  let puppeteer;
  try {
    ({ default: puppeteer } = await import('puppeteer'));
  } catch (err) {
    log(`clt: puppeteer not available (${err?.message ?? err}); skipping`);
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

    // Wait for the page's own JS to fetch + render the wait times: at least one
    // checkpoint card reporting a "Now Open"/"Now Closed" status.
    try {
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll('[role="listitem"]')).some((el) =>
          el.querySelector('h3') && /now\s+(open|closed)/i.test(el.innerText || '')),
        { timeout: RENDER_TIMEOUT_MS, polling: 500 },
      );
    } catch {
      const errored = await page.evaluate(() =>
        /unable to load the security wait times|unable to fetch the correct data/i
          .test(document.body?.innerText || '')).catch(() => false);
      log(`clt: security wait times did not render${errored ? ' (page error/unavailable state)' : ''}; returning []`);
      return [];
    }

    const cards = await page.evaluate(SCRAPE_CARDS);
    if (!cards.length) {
      log('clt: no checkpoint cards parsed from rendered DOM; returning []');
      return [];
    }

    // Split into Standard (standard lane) vs TSA Pre✓ (PreCheck lane) sections.
    const standardCards = []; // { name, waitMin, status }
    const preCards = [];      // { name, waitMin, status }
    for (const card of cards) {
      const parsed = parseCard(card);
      const row = { name: card.name, waitMin: parsed.waitMin, status: parsed.status };
      if (isStandard(card.section)) standardCards.push(row);
      else if (isPre(card.section)) preCards.push(row);
    }

    if (standardCards.length === 0) {
      log('clt: no Standard-lane checkpoints parsed from rendered DOM; returning []');
      return [];
    }

    // standardMin = MAX over OPEN standard checkpoints (null if none open).
    const openStandard = standardCards
      .filter((c) => c.status === 'Open' && Number.isFinite(c.waitMin))
      .map((c) => c.waitMin);
    const standardMin = openStandard.length ? Math.max(...openStandard) : null;

    // precheckMin = MAX over OPEN PreCheck checkpoints (null if none open).
    const openPre = preCards
      .filter((c) => c.status === 'Open' && Number.isFinite(c.waitMin))
      .map((c) => c.waitMin);
    const precheckMin = openPre.length ? Math.max(...openPre) : null;

    // precheckOpen: true if any PreCheck checkpoint open; false if PreCheck
    // section present but all closed; null if no PreCheck section shown.
    let precheckOpen = null;
    if (preCards.length) precheckOpen = preCards.some((c) => c.status === 'Open');

    const checkpoints = standardCards.map((c) => ({
      name: c.name, waitMin: c.waitMin, status: c.status,
    }));

    const reading = {
      source: 'firstparty',
      airport: 'CLT',
      kind: 'security_wait',
      observedAt: nowIso(),
      payload: { standardMin, precheckOpen, precheckMin, checkpoints },
    };

    log(`clt: ${checkpoints.length} checkpoints, standardMin=${standardMin}, ` +
      `precheckOpen=${precheckOpen}, precheckMin=${precheckMin}`);
    return [reading];
  } catch (err) {
    // Unexpected failure (launch/nav). Log and return [] — CLT then stays on the
    // reseller baseline via the existing fallback. Never throw for a render miss.
    log(`clt: unexpected error, returning [] (${err?.message ?? err})`);
    return [];
  } finally {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  }
}
