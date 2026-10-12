'use strict';

// Secondary, NON-authoritative discovery layer. Polls third-party aggregator
// pages and cross-references their listings against the official SOURCES/EXCLUDE
// patterns to catch notifications faster or ones the official scraper missed.
// It never replaces official eligibility/date data.

const cheerio = require('cheerio');
const { SOURCES, EXCLUDE, THIRD_PARTY_SOURCES } = require('./config');
const { httpGet } = require('./fetcher');
const { isStale } = require('./cleaner');

const DEFAULT_SELECTORS = {
  item: 'article',
  link: 'h2 a, h3 a, a',
  date: 'time, .date, .entry-date',
};

// Aggregator pages are noisy: they also link previous papers, answer keys,
// results, cut-offs, syllabi, etc. Those are not actionable notifications or
// admit cards, so drop them even when they mention an exam we track.
const NOISE = /previous\s*year|previous\s*paper|question\s*paper|answer\s*key|response\s*sheet|\bresult\b|merit\s*list|cut\s*-?off|syllabus|salary|mock\s*test|\bbooks?\b|preparation|coaching|exam\s*pattern|eligibility\s*criteria|exam\s*date|exam\s*schedule|exam\s*city|study\s*material|selection\s*process|apply\s*process/i;

// "SSC" is ambiguous: on defence sites it means Short Service Commission, but
// aggregators mix in Staff Selection Commission clerical exams (CHSL, CGL, GD
// Constable, Stenographer, CPO/SI, JE, MTS, Havaldar, Selection Post, etc.).
// Those are never officer-entry defence notifications, so drop them outright.
const SSC_CLERICAL = /\bchsl\b|\bcgl\b|\bmts\b|constable|stenographer|\bcpo\b|sub-?inspector|junior\s*engineer|\bje\b|havaldar|selection\s*post|multi\s*tasking|delhi\s*police|\bgd\b|head\s*constable|\bldc\b|\bdeo\b|scientific\s*assistant/i;

// Organisations we do not track as officer entries. Their titles often contain
// generic words ("ssc", "technical") that would otherwise be mis-matched onto a
// defence exam (e.g. Indian Coast Guard "ICG CGEPT ... at ssc.gov.in" tagged as
// Navy SSC Officer, or an ISRO technician post). Drop them outright.
const OUT_OF_SCOPE = /coast\s*guard|\bicg\b|cgept|\bnavik\b|yantrik|\bisro\b|\bdrdo\b|\bssc\.gov\.in\b|staff\s*selection/i;

const ADMIT = /admit\s*card|hall\s*ticket|e-?admit|call\s*letter/i;

// A real posting is dated or names a concrete event (notification is out, admit
// card / result released, vacancies, apply-online...). Bare category or menu
// anchors like "SSC Jobs" or "SSC Recruitment" have no year and no such signal,
// so they are ignored.
const SUBSTANCE = /\b20\d{2}\b|notification|admit\s*card|hall\s*ticket|call\s*letter|answer\s*key|\bresult\b|online\s*form|apply\s*online|vacanc|bharti|\bout\b|released|score\s*card|merit\s*list/i;

// Run a listing title through the SAME anchor-matching logic the official
// pipeline uses: drop EXCLUDE/NOISE hits, otherwise return the first exam whose
// `match` regex fires. Returns null when nothing (in scope) matches.
function classifyTitle(title) {
  if (!title || EXCLUDE.test(title) || NOISE.test(title) || SSC_CLERICAL.test(title) || OUT_OF_SCOPE.test(title)) return null;
  if (!SUBSTANCE.test(title)) return null; // generic nav/category anchor -> ignore.
  for (const source of SOURCES) {
    for (const exam of source.exams) {
      if (exam.match.test(title)) {
        return {
          force: source.force,
          exam: exam.exam,
          subEntry: exam.subEntries[0],
          admitCard: ADMIT.test(title),
        };
      }
    }
  }
  return null;
}

// Pull { title, url, rawDate } tuples from one aggregator page's markup. Uses a
// container pass first (better date association) and then a direct anchor scan
// so sites whose markup does not match the container selector (e.g. testbook)
// are still fully covered. Deduped by url+title.
function extractListings($, base, selectors) {
  const sel = { ...DEFAULT_SELECTORS, ...(selectors || {}) };
  const out = [];
  const seen = new Set();

  const add = ($a, $scope) => {
    const title = $a.text().replace(/\s+/g, ' ').trim();
    let href = $a.attr('href') || '';
    if (!title || title.length < 8 || !href || href.startsWith('#') || href.startsWith('javascript:')) return;
    try {
      href = new URL(href, base).toString();
    } catch {
      return;
    }
    const dedupe = `${href}||${title}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    const rawDate =
      ($scope && $scope.length ? $scope.find(sel.date).first().text().replace(/\s+/g, ' ').trim() : '') || null;
    out.push({ title, url: href, rawDate });
  };

  $(sel.item).each((_, el) => {
    const $el = $(el);
    const $a = $el.find(sel.link).first();
    if ($a.length) add($a, $el);
  });

  $('a').each((_, el) => {
    const $a = $(el);
    add($a, $a.closest(sel.item));
  });

  return out;
}

async function fetchSiteRaw(site) {
  const html = await httpGet(site.url);
  const $ = cheerio.load(html);
  return extractListings($, new URL(site.url), site.selectors).map((it) => ({ ...it, sourceSite: site.site }));
}

// ---- "Exam already concluded" engine ----
// Post-exam artifacts (results, answer keys, response sheets, score cards) are
// proof the exam has been held. If we see one for an exam edition, any admit
// card for that SAME edition is stale and must not be alerted or shown.
const POST_EXAM = /answer\s*key|response\s*sheet|\bresult\b|merit\s*list|score\s*-?card|final\s*result|cut\s*-?off/i;
const ROMAN = { i: '1', ii: '2', iii: '3', iv: '4' };

// Pull the edition number ("AFCAT 2", "CDS II", "CDS 1 2026") -> '2','2','1'.
// Ignores 4-digit years and multi-digit vacancy counts via word boundaries.
function editionNumber(title) {
  const m = String(title).match(/\b(i{1,3}|iv|[1-4])\b/i);
  if (!m) return '';
  const t = m[1].toLowerCase();
  return ROMAN[t] || t;
}

// Pull the exam-cycle year (a 4-digit 20xx) from a title, if present.
function editionYear(title) {
  const m = String(title).match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

// Rank a cycle so newer sorts higher: later year always beats earlier year, and
// within a year a higher edition beats a lower one. Missing parts count as 0.
function cycleRank(year, edition) {
  return (year || 0) * 10 + (edition ? Number(edition) : 0);
}

// First matching exam for a title, WITHOUT the EXCLUDE/NOISE filtering (we want
// to see post-exam signals even though they are dropped from the alert stream).
function examOf(title) {
  for (const source of SOURCES) {
    for (const exam of source.exams) {
      if (exam.match.test(title)) return { force: source.force, exam: exam.exam };
    }
  }
  return null;
}

function editionKey(force, exam, title) {
  return `${force}::${exam}::${editionNumber(title)}`;
}

// Build the set of exam editions that have demonstrably already happened.
function buildConcludedSet(titles) {
  const set = new Set();
  for (const title of titles) {
    if (!POST_EXAM.test(title)) continue;
    const ex = examOf(title);
    if (ex) set.add(editionKey(ex.force, ex.exam, title));
  }
  return set;
}

// ---- Supersession engine ----
// Record the newest cycle (force::exam -> highest cycleRank) seen anywhere in
// the feed. Only titles that carry an edition number contribute, so a generic
// "AFCAT Notification" never establishes or loses to a cycle.
function buildLatestCycle(titles) {
  const latest = new Map();
  for (const title of titles) {
    const ed = editionNumber(title);
    if (!ed) continue;
    const ex = examOf(title);
    if (!ex) continue;
    const key = `${ex.force}::${ex.exam}`;
    const rank = cycleRank(editionYear(title), ed);
    if (!latest.has(key) || rank > latest.get(key)) latest.set(key, rank);
  }
  return latest;
}

// A listing is superseded when a strictly newer cycle of the SAME exam exists.
// No readable edition -> keep (we cannot prove it is stale).
function isSuperseded(latest, force, exam, title) {
  const ed = editionNumber(title);
  if (!ed) return false;
  const key = `${force}::${exam}`;
  if (!latest.has(key)) return false;
  return cycleRank(editionYear(title), ed) < latest.get(key);
}

// Fetch every configured third-party page, then classify. Each site is isolated:
// one being unreachable or having broken markup never blocks the others. Admit
// cards for exams that have already concluded are dropped.
async function fetchThirdPartyListings() {
  const raw = [];
  for (const site of THIRD_PARTY_SOURCES) {
    try {
      raw.push(...(await fetchSiteRaw(site)));
    } catch (err) {
      console.warn(`  ! third-party ${site.site} failed: ${err.message}`);
    }
  }

  const concluded = buildConcludedSet(raw.map((r) => r.title));
  const latest = buildLatestCycle(raw.map((r) => r.title));

  const out = [];
  for (const item of raw) {
    const match = classifyTitle(item.title);
    if (!match) continue; // unclassified / EXCLUDE / NOISE -> out of scope.
    if (isSuperseded(latest, match.force, match.exam, item.title)) {
      console.log(`  - dropped superseded listing (newer edition exists): ${match.exam} ${editionNumber(item.title)}`);
      continue;
    }
    if (concluded.has(editionKey(match.force, match.exam, item.title))) {
      console.log(`  - dropped concluded-exam listing (exam already held): ${match.exam} ${editionNumber(item.title)}`);
      continue;
    }
    if (isStale(item.title)) {
      console.log(`  - dropped expired listing (application window over): ${match.exam}`);
      continue;
    }
    out.push({
      sourceSite: item.sourceSite,
      title: item.title,
      url: item.url,
      rawDate: item.rawDate,
      matchedExamCode: match.exam,
      force: match.force,
      qualType: match.subEntry ? match.subEntry.qualType : null,
      watch: match.subEntry ? !!match.subEntry.watch : false,
      admitCard: !!match.admitCard,
    });
  }
  return out;
}

module.exports = {
  fetchThirdPartyListings,
  classifyTitle,
  extractListings,
  buildConcludedSet,
  buildLatestCycle,
  isSuperseded,
  editionKey,
  editionNumber,
  editionYear,
};
