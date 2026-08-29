// ============================================================================
// MCO (Orlando International) first-party security-wait collector
// (HEADLESS / Puppeteer).
//
// Reads the wait times MCO *publicly displays* to every traveler on
// https://www.flymco.com/security/ . The page's OWN client-side JavaScript
// authenticates with its OWN embedded credentials (GOAA feed) and renders the
// numbers; we load the page like any browser and read what it DISPLAYS. We do
// NOT touch, extract, or reuse any API key. One gentle page load per run
// (every ~5 min) — single request. MCO's GOAA feed reports BOTH the General
// (standard) lane AND the TSA PreCheck lane wait, and we capture both.
//
// ISOLATION: this file lives in collectors/headless/ (never copied into the
// web/Vercel bundle by the prebuild step) and is NOT imported by
// src/firstparty/index.mjs. It runs ONLY via the standalone GitHub Actions
// runner. Puppeteer/Chromium must never leak into the serverless bundle.
//
// DOM contract (discovered by loading the live page):
//   The wait-times section is client-rendered. Each checkpoint is an <li> card
//   ([class*="SecurityWaitTimesCard-CheckpointInfoContainer"]) containing:
//     - an <h5 [class*="SWTCardTitle"]> checkpoint name  (e.g. "Gates 1 - 59")
//     - two lane blocks, each a [class*="SecurityWaitTimeLaneInfo-TimeContainer"]:
//         <span [class*="LaneTypeTitle"]>General</span>  (standard) OR
//         <span [class*="LaneTypeTitle"]>TSA Pre✓®</span> (PreCheck), plus
//         <p [class*="SecurityWaitTimeLaneInfo-TimeRange"]>6 - 10 min</p>
//   The Emotion hash prefixes (css-xxxx-) rotate on rebuilds, but the semantic
//   label suffixes (CheckpointInfoContainer / LaneTypeTitle / TimeRange) are
//   stable, so we key off those substrings plus the lane TITLE TEXT ("General"
//   / "TSA Pre"), never the hashed prefixes. A lane with a numeric range is
//   Open; a lane whose range reads "Closed"/"Unavailable" (or has no number) is
//   Closed. Ranges are captured as a conservative upper bound (e.g. "6 - 10
//   min" -> 10) to match the DFW collector.
// ============================================================================

import { nowIso } from '../lib/contract.mjs';

const URL = 'https://www.flymco.com/security/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const NAV_TIMEOUT_MS = 45000;    // initial navigation
const DEFAULT_TIMEOUT_MS = 30000; // page default (per task)
const RENDER_TIMEOUT_MS = 30000; // wait for checkpoint numbers to appear

// In-page: read every rendered checkpoint card -> { name, lanes:[{lane, rangeText}] }.
// Keyed off stable semantic class-name suffixes + lane title text, not hashes.
const SCRAPE_CARDS = () => {
  const cards = Array.from(document.querySelectorAll(
    '[class*="CheckpointInfoContainer"]'));
  return cards.map((card) => {
    const nameEl = card.querySelector('[class*="SWTCardTitle"]')
      || card.querySelector('h5');
    const name = (nameEl?.textContent || '').trim();
    const lanes = Array.from(card.querySelectorAll(
      '[class*="SecurityWaitTimeLaneInfo-TimeContainer"]')).map((lc) => {
      const title = (lc.querySelector('[class*="LaneTypeTitle"]')?.textContent || '').trim();
      const range = (lc.querySelector('[class*="SecurityWaitTimeLaneInfo-TimeRange"]')?.textContent || '').trim();
      return { lane: title, rangeText: range };
    });
    return { name, lanes };
  }).filter((c) => c.name && c.lanes.length);
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

/** A lane -> { status:'Open'|'Closed', waitMin:number|null }. Open iff a numeric
 *  wait renders; explicit Closed/Unavailable text or no number -> Closed. */
function parseLane(rangeText) {
  const t = String(rangeText || '').trim();
  if (/clos|unavail|not\s*open|--/i.test(t) || !/\d/.test(t)) {
    return { status: 'Closed', waitMin: null };
  }
  const waitMin = parseMinutes(t);
  return Number.isFinite(waitMin)
    ? { status: 'Open', waitMin }
    : { status: 'Closed', waitMin: null };
}

const isGeneral = (lane) => /general/i.test(lane);
const isPre = (lane) => /pre/i.test(lane);

export async function collect(ctx) {
  const log = ctx?.log ?? (() => {});
  let puppeteer;
  try {
    ({ default: puppeteer } = await import('puppeteer'));
  } catch (err) {
    log(`mco: puppeteer not available (${err?.message ?? err}); skipping`);
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
    // checkpoint card whose lane shows a numeric range or an explicit closed state.
    try {
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll(
          '[class*="SecurityWaitTimeLaneInfo-TimeRange"]')).some((el) =>
          /(\d+\s*min|clos|unavail)/i.test(el.textContent || '')),
        { timeout: RENDER_TIMEOUT_MS, polling: 500 },
      );
    } catch {
      const errored = await page.evaluate(() =>
        /wait times? (are|is)?\s*(currently )?unavailable|unable to (load|retrieve)/i
          .test(document.body?.innerText || '')).catch(() => false);
      log(`mco: security wait times did not render${errored ? ' (page error/unavailable state)' : ''}; returning []`);
      return [];
    }

    const cards = await page.evaluate(SCRAPE_CARDS);
    if (!cards.length) {
      log('mco: no checkpoint cards parsed from rendered DOM; returning []');
      return [];
    }

    // Flatten lanes per checkpoint, split into General (standard) vs TSA Pre.
    const standardLanes = []; // { name, waitMin, status }
    const preLanes = [];      // { name, waitMin, status }
    for (const card of cards) {
      for (const lane of card.lanes) {
        const parsed = parseLane(lane.rangeText);
        const row = { name: card.name, waitMin: parsed.waitMin, status: parsed.status };
        if (isGeneral(lane.lane)) standardLanes.push(row);
        else if (isPre(lane.lane)) preLanes.push(row);
      }
    }

    if (standardLanes.length === 0) {
      log('mco: no General-lane checkpoints parsed from rendered DOM; returning []');
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

    // precheckOpen: true if any PreCheck lane open/reporting; false if present-
    // but-closed; null if PreCheck not shown at all.
    let precheckOpen = null;
    if (preLanes.length) precheckOpen = preLanes.some((c) => c.status === 'Open');

    const checkpoints = standardLanes.map((c) => ({
      name: c.name, waitMin: c.waitMin, status: c.status,
    }));

    const reading = {
      source: 'firstparty',
      airport: 'MCO',
      kind: 'security_wait',
      observedAt: nowIso(),
      payload: { standardMin, precheckOpen, precheckMin, checkpoints },
    };

    log(`mco: ${checkpoints.length} checkpoints, standardMin=${standardMin}, ` +
      `precheckOpen=${precheckOpen}, precheckMin=${precheckMin}`);
    return [reading];
  } catch (err) {
    // Unexpected failure (launch/nav). Log and return [] — MCO then stays on the
    // reseller baseline via the existing fallback. Never throw for a render miss.
    log(`mco: unexpected error, returning [] (${err?.message ?? err})`);
    return [];
  } finally {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  }
}
