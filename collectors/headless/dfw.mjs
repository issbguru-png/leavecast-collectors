// ============================================================================
// DFW first-party security-wait collector (HEADLESS / Puppeteer).
//
// Reads the wait times DFW *publicly displays* to every traveler on
// https://www.dfwairport.com/security/ . robots.txt allows it (UA:* / Allow:/).
// The page's OWN client-side JavaScript authenticates with its OWN embedded
// credentials and renders the numbers; we load the page like any browser and
// read what it DISPLAYS. We do NOT touch, extract, or reuse any API key. One
// page load per run (every ~5 min) — gentle, single request.
//
// ISOLATION: this file lives in collectors/headless/ (never copied into the
// web/Vercel bundle by the prebuild step) and is NOT imported by
// src/firstparty/index.mjs. It runs ONLY via the standalone GitHub Actions
// runner. Puppeteer/Chromium must never leak into the serverless bundle.
//
// DOM contract (discovered by loading the live page):
//   Each checkpoint is a rendered element carrying an aria-label of the form
//     "<NAME> checkpoint - <LANE> - current wait time <N> minutes "
//     "<NAME> checkpoint - <LANE> - Closed"
//   where <LANE> is "General" (standard) or "TSA Pre" (PreCheck). The default
//   view lists the General lanes; clicking the "TSA Pre✓" tab swaps the labels
//   to the PreCheck lanes. The color legend spans (0-10/11-20/20+ min) share a
//   data-testid="checkpointCircle" but carry no per-checkpoint number, so we
//   key off the aria-labels, which are i18n-driven and stable (unlike the
//   hashed Emotion css-* class names).
// ============================================================================

import { nowIso } from '../lib/contract.mjs';

const URL = 'https://www.dfwairport.com/security/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const NAV_TIMEOUT_MS = 45000;   // initial navigation
const DEFAULT_TIMEOUT_MS = 30000; // page default (per task)
const RENDER_TIMEOUT_MS = 30000; // wait for checkpoint numbers to appear
const PRECHECK_WAIT_MS = 6000;   // max wait for labels to swap after the PreCheck tab click

// In-page: collect every checkpoint aria-label currently in the DOM.
// Returns raw label strings like "A21 checkpoint - General - current wait time 7 minutes ".
const SCRAPE_LABELS = () =>
  Array.from(document.querySelectorAll('[aria-label]'))
    .map((el) => el.getAttribute('aria-label') || '')
    .filter((a) => /checkpoint\s*-\s*.+\s*-\s*/i.test(a));

/** Parse one checkpoint aria-label -> { name, lane, status:'Open'|'Closed', waitMin }. */
function parseLabel(label) {
  const m = /^(.+?)\s+checkpoint\s*-\s*(.+?)\s*-\s*(.+)$/i.exec(String(label).trim());
  if (!m) return null;
  const name = m[1].trim();
  const lane = m[2].trim();               // 'General' | 'TSA Pre'
  const rest = m[3].trim();               // 'current wait time 7 minutes' | 'Closed'
  if (/closed/i.test(rest)) return { name, lane, status: 'Closed', waitMin: null };
  return { name, lane, status: 'Open', waitMin: parseMinutes(rest) };
}

/** Minutes from display text. Handles "7 minutes"/"7 min", "less than 5"/"< 5"
 *  (upper bound), and ranges "11-20 min"/"20+ min" (conservative upper bound). */
function parseMinutes(text) {
  const t = String(text).toLowerCase();
  const range = /(\d+)\s*[-–]\s*(\d+)/.exec(t);        // "11-20" -> 20
  if (range) return Number(range[2]);
  if (/(less than|under|<)\s*\d+/.test(t)) {           // "< 5" -> 5 (upper bound)
    const n = /(\d+)/.exec(t); return n ? Number(n[1]) : null;
  }
  const plus = /(\d+)\s*\+/.exec(t);                    // "20+" -> 20
  if (plus) return Number(plus[1]);
  const n = /(\d+)/.exec(t);
  return n ? Number(n[1]) : null;
}

const isGeneral = (lane) => /general/i.test(lane);
const isPre = (lane) => /pre/i.test(lane);

export async function collect(ctx) {
  const log = ctx?.log ?? (() => {});
  let puppeteer;
  try {
    ({ default: puppeteer } = await import('puppeteer'));
  } catch (err) {
    log(`dfw: puppeteer not available (${err?.message ?? err}); skipping`);
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

    // Wait for the page's own JS to fetch + render the numbers: at least one
    // checkpoint aria-label carrying a wait time or a Closed status.
    try {
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll('[aria-label]')).some((el) =>
          /checkpoint\s*-\s*.+\s*-\s*(current wait time\s*\d+|closed)/i.test(el.getAttribute('aria-label') || '')),
        { timeout: RENDER_TIMEOUT_MS, polling: 500 },
      );
    } catch {
      const errored = await page.evaluate(() =>
        /Unable to load wait time/i.test(document.body?.innerText || '')).catch(() => false);
      log(`dfw: checkpoint wait times did not render${errored ? ' (page error state)' : ''}; returning []`);
      return [];
    }

    // Primary view = General (standard) lanes.
    const generalRaw = await page.evaluate(SCRAPE_LABELS);
    const general = generalRaw.map(parseLabel).filter(Boolean).filter((c) => isGeneral(c.lane));

    if (general.length === 0) {
      log('dfw: no General-lane checkpoints parsed from rendered DOM; returning []');
      return [];
    }

    // standardMin = MAX over OPEN standard-lane checkpoints (null if none open).
    const openStandard = general
      .filter((c) => c.status === 'Open' && Number.isFinite(c.waitMin))
      .map((c) => c.waitMin);
    const standardMin = openStandard.length ? Math.max(...openStandard) : null;

    // Derive PreCheck by switching to the "TSA Pre✓" tab (guarded — a miss here
    // must never break the standard-lane reading; it just yields nulls). The
    // PreCheck lane aria-labels carry "current wait time N minutes" exactly like
    // the General lanes, so we capture BOTH the open flag AND the actual minutes
    // (precheckMin = MAX over open PreCheck checkpoints, mirroring standardMin).
    let precheckOpen = null;
    let precheckMin = null;
    try {
      const switched = await page.evaluate(() => {
        // The "TSA Pre✓" control is a real <button> (or role=tab); target it
        // specifically so we click the tab, not an unrelated span/div in the copy.
        const cands = Array.from(document.querySelectorAll('button,[role="tab"]'))
          .filter((e) => /tsa\s*pre/i.test(e.textContent || ''))
          .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
        if (cands[0]) { cands[0].click(); return true; }
        return false;
      });
      if (switched) {
        // Wait for the labels to swap to the TSA Pre lane (bounded fallback sleep).
        await page.waitForFunction(
          () => Array.from(document.querySelectorAll('[aria-label]')).some((el) =>
            /checkpoint\s*-\s*tsa\s*pre\s*-/i.test(el.getAttribute('aria-label') || '')),
          { timeout: PRECHECK_WAIT_MS, polling: 300 },
        ).catch(() => {});
        const preRaw = await page.evaluate(SCRAPE_LABELS);
        const pre = preRaw.map(parseLabel).filter(Boolean).filter((c) => isPre(c.lane));
        if (pre.length) {
          precheckOpen = pre.some((c) => c.status === 'Open');
          const openPre = pre
            .filter((c) => c.status === 'Open' && Number.isFinite(c.waitMin))
            .map((c) => c.waitMin);
          precheckMin = openPre.length ? Math.max(...openPre) : null;
        }
      }
    } catch (err) {
      log(`dfw: precheck derivation skipped (${err?.message ?? err})`);
    }

    const checkpoints = general.map((c) => ({ name: c.name, waitMin: c.waitMin, status: c.status }));

    const reading = {
      source: 'firstparty',
      airport: 'DFW',
      kind: 'security_wait',
      observedAt: nowIso(),
      payload: { standardMin, precheckOpen, precheckMin, checkpoints },
    };

    log(`dfw: ${checkpoints.length} checkpoints, standardMin=${standardMin}, precheckOpen=${precheckOpen}, precheckMin=${precheckMin}`);
    return [reading];
  } catch (err) {
    // Unexpected failure (launch/nav). Log and return [] — DFW then stays on the
    // reseller baseline via the existing fallback. Never throw for a render miss.
    log(`dfw: unexpected error, returning [] (${err?.message ?? err})`);
    return [];
  } finally {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  }
}
