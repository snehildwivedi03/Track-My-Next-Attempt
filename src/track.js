'use strict';

const { SOURCES, EXCLUDE } = require('./config');
const { getLinks, extractText } = require('./fetcher');
const { parseNotification } = require('./parser');
const { classify, isAdmitCard, isClosed, passesEmailGate } = require('./eligibility');
const { sendResult, sendProvisional } = require('./email');
const { load, save, prune, provisionalKey, hasConfirmedExam, upgradeProvisional } = require('./store');
const { sha256 } = require('./util');
const { fetchThirdPartyListings } = require('./thirdparty');
const { cleanState, isApplicationClosed, examDate, hasPassed } = require('./cleaner');
// Only follow links that look like a notification (PDF or advert page).
function looksLikeNotification(href, text) {
  const blob = `${href} ${text}`;
  if (EXCLUDE.test(blob)) return false;
  return /\.pdf(\?|$)/i.test(href) || /notification|advertisement|recruit|apply|circular|admit|entry|course/i.test(blob);
}

function yearFrom(text) {
  const m = text.match(/\b(20\d{2})\b/);
  return m ? m[1] : '';
}

async function processSource(source, state) {
  console.log(`\n== ${source.force} :: ${source.url}`);
  let links;
  try {
    links = await getLinks(source.url);
  } catch (err) {
    console.warn(`  ! Could not load ${source.url}: ${err.message}`);
    return;
  }

  // A link handled by a more specific exam (e.g. SSC IT) is not re-processed
  // by a broader one (e.g. SSC Officer) in the same source.
  const handled = new Set();

  for (const exam of source.exams) {
    const matched = links.filter(
      (l) =>
        !handled.has(l.href) &&
        exam.match.test(`${l.text} ${l.href}`) &&
        looksLikeNotification(l.href, l.text)
    );
    // De-duplicate by href.
    const seen = new Set();
    const uniq = matched.filter((l) => (seen.has(l.href) ? false : seen.add(l.href)));

    for (const link of uniq.slice(0, 8)) {
      handled.add(link.href);
      await processLink(source, exam, link, state);
    }
  }
}

async function processLink(source, exam, link, state) {
  const notifId = `${source.force}|${exam.exam}|${link.href}`;
  const text = await extractText(link.href);
  if (text.startsWith('__FETCH_ERROR__')) {
    console.warn(`  ! ${link.href} -> ${text}`);
    return;
  }
  const hash = sha256(text.slice(0, 20000));
  const fields = parseNotification(text);
  const year = yearFrom(`${link.text} ${text.slice(0, 400)}`);
  const admitCard = isAdmitCard(`${link.text} ${text.slice(0, 3000)}`);
  const closed = isClosed(`${link.text} ${text.slice(0, 3000)}`);

  // Read the exam date from the notification body. Once the exam day is past the
  // entry is dead (even an admit card) -> drop every sub-record and skip.
  const examDateVal = examDate(text);
  if (examDateVal && hasPassed(examDateVal)) {
    for (const sub of exam.subEntries) {
      delete state.records[sha256(`${notifId}::${sub.code}`)];
    }
    console.log(`  - skipped (exam already held): ${exam.exam} :: ${link.text.slice(0, 60)}`);
    return;
  }

  // Application window has ended (and it is not an admit card) -> no alert.
  // Drop any stale record so the website stops showing the dead entry.
  if (closed && !admitCard) {
    for (const sub of exam.subEntries) {
      delete state.records[sha256(`${notifId}::${sub.code}`)];
    }
    console.log(`  - skipped (application closed): ${exam.exam} :: ${link.text.slice(0, 60)}`);
    return;
  }

  for (const sub of exam.subEntries) {
    const key = sha256(`${notifId}::${sub.code}`);
    const prev = state.records[key];
    const nowIso = new Date().toISOString();

    // Seen before -> refresh timestamp/hash but never re-email. Exception: if a
    // prior send was eligible but FAILED (pendingRetry), try again this run.
    if (prev && !prev.pendingRetry) {
      prev.lastSeen = nowIso;
      prev.hash = hash;
      if (examDateVal) prev.examDate = examDateVal.toISOString();
      continue;
    }

    const result = classify({ text, subEntry: sub, fields });
    const emailAllowed = passesEmailGate({ status: result.status, subEntry: sub, admitCard, closed });
    const payload = {
      force: source.force,
      exam: exam.exam,
      subCode: sub.code,
      title: link.text || `${exam.exam} ${sub.code}`,
      year,
      status: result.status,
      reason: result.reason,
      url: link.href,
      appUrl: null,
      source: source.url,
      admitCard,
      fields,
    };

    // Safeguard: only email when eligible (admit cards gated on qualification).
    let emailSent = false;
    if (emailAllowed) {
      try {
        await sendResult(payload);
        emailSent = true;
      } catch (err) {
        console.warn(`  ! Email failed for ${sub.code}: ${err.message}`);
      }
    } else {
      console.log(`  - suppressed (not eligible): ${exam.exam} ${sub.code} [${admitCard ? 'admit card' : result.status}]`);
    }

    state.records[key] = {
      force: source.force,
      exam: exam.exam,
      subCode: sub.code,
      title: payload.title,
      status: result.status,
      reason: result.reason,
      url: link.href,
      hash,
      emailed: emailSent,
      pendingRetry: emailAllowed && !emailSent,
      admitCard,
      examDate: examDateVal ? examDateVal.toISOString() : (prev && prev.examDate) || null,
      firstSeen: prev ? prev.firstSeen : nowIso,
      lastSeen: nowIso,
      changed: !!prev,
    };

    // Official confirmation: retire any third-party provisional for this exam.
    // The upgrade itself does not send a new email (it was already alerted).
    if (!prev) upgradeProvisional(state, source.force, exam.exam, nowIso);
  }
}

// ---- Secondary third-party discovery layer (fully isolated) ----

function yearFromTitle(title) {
  const m = String(title).match(/\b(20\d{2})\b/);
  return m ? m[1] : '';
}

// A basic, qualType-only note for provisional entries. We deliberately do NOT
// run eligibility.classify here: sub-entry details are not available yet.
function basicProvisionalNote(qualType) {
  switch (qualType) {
    case 'graduate':
      return 'Any bachelor\u2019s degree entry (unconfirmed) \u2013 likely eligible; verify.';
    case 'it':
      return 'CSE/IT entry (unconfirmed) \u2013 likely a good fit; verify discipline list.';
    case 'engineering':
      return 'Engineering entry (unconfirmed) \u2013 verify CSE is in the discipline list.';
    case 'flying':
      return 'Flying branch (unconfirmed) \u2013 age/medical criteria apply; verify.';
    default:
      return 'Third-party listing \u2013 not yet scored.';
  }
}

async function handleThirdPartyListing(item, state) {
  const nowIso = new Date().toISOString();

  const admit = item.admitCard || isAdmitCard(item.title);
  const closed = isClosed(item.title);
  const key = provisionalKey(item.force, item.matchedExamCode, admit ? 'admit' : 'notice');

  // The headline rarely carries the deadline or the exam date, so read the
  // aggregator's detail page once and reuse it for both lifecycle checks.
  let detailText = '';
  try {
    const detail = await extractText(item.url);
    if (!detail.startsWith('__FETCH_ERROR__')) detailText = detail;
  } catch { /* keep the item on any fetch/parse failure */ }

  let windowOver = closed;
  if (!admit && !windowOver && detailText && isApplicationClosed(detailText)) windowOver = true;

  // Exam-date lifecycle: the moment the exam day is past, the entry is dead --
  // this is what retires admit cards (e.g. CDS 2) right after the exam is held.
  const examDateVal = examDate(`${item.title} ${detailText}`);
  if (examDateVal && hasPassed(examDateVal)) {
    delete state.records[key];
    console.log(`  - skipped (exam already held): ${item.matchedExamCode}`);
    return { action: 'exam-over-skip', exam: item.matchedExamCode, item };
  }

  // Application window has ended (and it is not an admit card) -> no alert.
  // Drop any stale provisional so the website stops showing the dead entry.
  if (windowOver && !admit) {
    delete state.records[key];
    console.log(`  - skipped provisional (application window over): ${item.matchedExamCode}`);
    return { action: 'closed-skip', exam: item.matchedExamCode, item };
  }

  // A notification already tracked officially -> corroboration only, no email.
  // Admit cards are NOT corroborated away: the official scraper rarely catches
  // them, so a third-party admit-card heads-up is still worth sending.
  if (!admit && hasConfirmedExam(state, item.force, item.matchedExamCode)) {
    console.log(`  ~ corroboration: ${item.matchedExamCode} already tracked officially (also seen on ${item.sourceSite}).`);
    return { action: 'corroborated', exam: item.matchedExamCode, item };
  }

  const prev = state.records[key];

  // Already alerted provisionally -> just refresh, do not email again. Exception:
  // if the prior send was eligible but FAILED (pendingRetry), try again below.
  if (prev && !prev.pendingRetry) {
    prev.lastSeen = nowIso;
    prev.title = item.title;
    prev.url = item.url;
    if (examDateVal) prev.examDate = examDateVal.toISOString();
    return { action: 'provisional-refresh', exam: item.matchedExamCode, item };
  }

  // Genuinely new -> store as provisional and send an [UNCONFIRMED] email.
  const note = admit
    ? 'Admit card / hall ticket reported out \u2013 download and verify on the official site.'
    : basicProvisionalNote(item.qualType);
  const payload = {
    force: item.force,
    exam: admit ? `${item.matchedExamCode} Admit Card` : item.matchedExamCode,
    title: item.title,
    year: yearFromTitle(item.title),
    url: item.url,
    sourceSite: item.sourceSite,
    rawDate: item.rawDate,
    status: admit ? 'ADMIT CARD (third-party)' : 'UNCONFIRMED (third-party)',
    reason: note,
  };

  // Same safeguard as the official path: suppress only closed windows.
  // No age criteria on these listings; admit cards always pass.
  const emailAllowed = passesEmailGate({
    subEntry: { qualType: item.qualType, watch: item.watch },
    admitCard: admit,
    closed,
  });

  let emailSent = false;
  if (emailAllowed) {
    try {
      await sendProvisional(payload);
      emailSent = true;
    } catch (err) {
      console.warn(`  ! provisional email failed for ${item.matchedExamCode}: ${err.message}`);
    }
  } else {
    console.log(`  - suppressed provisional (not eligible): ${item.matchedExamCode}`);
  }

  state.records[key] = {
    force: item.force,
    exam: item.matchedExamCode,
    subCode: item.matchedExamCode,
    title: item.title,
    status: admit ? 'ADMIT CARD (unconfirmed)' : 'UNCONFIRMED',
    reason: note,
    url: item.url,
    hash: sha256(`${item.url}|${item.title}`),
    emailed: emailSent,
    pendingRetry: emailAllowed && !emailSent,
    examDate: examDateVal ? examDateVal.toISOString() : (prev && prev.examDate) || null,
    firstSeen: prev ? prev.firstSeen : nowIso,
    lastSeen: nowIso,
    provisional: true,
    admitCard: admit,
    origin: `thirdparty:${item.sourceSite}`,
  };

  return { action: prev ? 'provisional-retry' : 'provisional-new', exam: item.matchedExamCode, item, payload, emailed: emailSent };
}

// Never let a third-party failure block or crash the official pipeline.
async function processThirdParty(state) {
  const results = [];
  let listings;
  try {
    listings = await fetchThirdPartyListings();
  } catch (err) {
    console.warn(`  ! third-party discovery failed: ${err.message}`);
    return results;
  }
  console.log(`\n== third-party discovery :: ${listings.length} in-scope listing(s)`);
  for (const item of listings) {
    try {
      results.push(await handleThirdPartyListing(item, state));
    } catch (err) {
      console.warn(`  ! third-party listing failed (${item.matchedExamCode}): ${err.message}`);
    }
  }
  return results;
}

async function main() {
  const state = load();
  for (const source of SOURCES) {
    try {
      await processSource(source, state);
    } catch (err) {
      console.warn(`  ! Source failed: ${err.message}`);
    }
  }

  // Secondary discovery layer, isolated from the official pipeline above.
  try {
    await processThirdParty(state);
  } catch (err) {
    console.warn(`  ! third-party stage failed (ignored): ${err.message}`);
  }

  // Purge entries whose application window / exam date has already passed, then
  // drop anything past its retention window.
  cleanState(state);
  prune(state);
  save(state);
  console.log(`\nDone. ${Object.keys(state.records).length} active record(s).`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main, processSource, processLink, processThirdParty, handleThirdPartyListing };
