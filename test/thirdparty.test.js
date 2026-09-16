'use strict';

// Standalone test for the third-party discovery layer. No test framework and
// no network: global.fetch is mocked, DRY_RUN prevents real emails.
// Run with:  npm test   (or)   node test/thirdparty.test.js

process.env.DRY_RUN = '1';

const assert = require('assert');

// --- Canned aggregator pages (the CDS admit card scenario) ---
const PAGES = {
  'https://govtjobsalert.in/defence-jobs/': `<!doctype html><html><body>
    <article><h2><a href="/upsc-cds-2-2026-admit-card">UPSC CDS II 2026 Admit Card Released - Download Hall Ticket</a></h2><time>07 Sep 2026</time></article>
    <article><h2><a href="/afcat-01-2026-admit-card">AFCAT 01/2026 Admit Card Out Now</a></h2><time>06 Sep 2026</time></article>
    <article><h2><a href="/nda-2-2026-admit-card">NDA II 2026 Admit Card Download</a></h2><time>05 Sep 2026</time></article>
    <article><h2><a href="/some-teaching-job">State PGT/TGT Teacher Recruitment 2026</a></h2><time>05 Sep 2026</time></article>
  </body></html>`,
  'https://testbook.com/news/defence-jobs/': `<!doctype html><html><body>
    <article><h3><a href="https://testbook.com/news/army-tgc-143">Indian Army TGC 143 Technical Graduate Course Notification 2026</a></h3><span class="date">04 Sep 2026</span></article>
  </body></html>`,
};

global.fetch = async (url) => {
  const key = String(url);
  const html = PAGES[key];
  if (html === undefined) throw new Error('unexpected fetch: ' + key);
  return {
    ok: true,
    status: 200,
    text: async () => html,
    arrayBuffer: async () => Buffer.from(html),
  };
};

const { fetchThirdPartyListings, buildConcludedSet, buildLatestCycle, isSuperseded, editionKey, editionNumber, editionYear } = require('../src/thirdparty');
const { processThirdParty } = require('../src/track');
const { buildProvisionalEmail } = require('../src/email');
const { hasConfirmedExam, upgradeProvisional, provisionalKey } = require('../src/store');
const { isStale, newestDate, cleanState, applicationDeadline, isApplicationClosed, examDate, isExamOver, hasPassed } = require('../src/cleaner');
const {
  passesEmailGate,
  profileQualifies,
  isAdmitCard,
  isClosed,
  ELIGIBLE,
  NOT_ELIGIBLE,
  UNCERTAIN,
} = require('../src/eligibility');

function pass(msg) {
  console.log('PASS:', msg);
}

(async () => {
  // 1. Listings are classified against SOURCES; EXCLUDE (NDA) and unclassified
  //    (teacher job) listings are dropped.
  const listings = await fetchThirdPartyListings();
  const exams = listings.map((l) => l.matchedExamCode);
  assert.ok(exams.includes('CDS'), 'CDS admit card should be discovered');
  assert.ok(exams.includes('AFCAT'), 'AFCAT admit card should be discovered');
  assert.ok(exams.includes('TGC'), 'Army TGC should be discovered');
  assert.ok(!listings.some((l) => /nda/i.test(l.title)), 'NDA must be EXCLUDE-dropped');
  assert.ok(!listings.some((l) => /teacher/i.test(l.title)), 'unclassified job must be dropped');
  assert.strictEqual(listings.length, 3, 'exactly the 3 in-scope defence listings');
  pass('classification + EXCLUDE + unclassified drop');

  // 2. The CDS admit card produces a NEW provisional [ADMIT CARD] email.
  const state = { updatedAt: null, records: {} };
  const results = await processThirdParty(state);
  const cds = results.find((r) => r.exam === 'CDS' && r.action === 'provisional-new');
  assert.ok(cds, 'CDS admit card should be a new provisional alert');
  const mail = buildProvisionalEmail(cds.payload);
  assert.ok(/\[ADMIT CARD\]/.test(mail.subject), 'admit-card subject marked [ADMIT CARD]');
  assert.ok(/CDS/.test(mail.subject), 'subject mentions CDS');
  assert.ok(/Admit Card/i.test(cds.payload.title), 'CDS admit-card wording carried through');
  assert.ok(/not yet confirmed on the official/i.test(mail.body), 'body has the verify caveat');
  pass('CDS admit-card email -> ' + mail.subject);

  // Admit cards for the other mentioned exams also alert.
  assert.ok(results.some((r) => r.exam === 'AFCAT' && r.action === 'provisional-new'), 'AFCAT admit card alerts');
  assert.ok(results.some((r) => r.exam === 'TGC' && r.action === 'provisional-new'), 'TGC alerts');
  pass('AFCAT + TGC also alert');

  // 3. Stored as provisional with origin + a shorter prune window flag.
  const cdsKey = provisionalKey('UPSC', 'CDS', 'admit');
  const rec = state.records[cdsKey];
  assert.strictEqual(rec.provisional, true, 'stored as provisional');
  assert.ok(/^thirdparty:/.test(rec.origin), 'origin flagged thirdparty:<site>');
  pass('provisional storage (flag + origin)');

  // 4. Dedup: a NOTIFICATION already confirmed officially only corroborates.
  //    (Admit cards deliberately bypass this so they always alert.)
  const state2 = {
    updatedAt: null,
    records: {
      official: {
        force: 'Indian Army', exam: 'TGC', subCode: 'TGC', title: 'TGC', status: 'ELIGIBLE',
        url: 'https://joinindianarmy.nic.in/x', hash: 'h', firstSeen: '2026-09-01T00:00:00Z',
        lastSeen: new Date().toISOString(),
      },
    },
  };
  assert.strictEqual(hasConfirmedExam(state2, 'Indian Army', 'TGC'), true);
  const results2 = await processThirdParty(state2);
  const tgc2 = results2.find((r) => r.exam === 'TGC');
  assert.strictEqual(tgc2.action, 'corroborated', 'confirmed notification -> corroboration, no duplicate email');
  pass('dedup against confirmed official record');

  // 5. Re-running does not re-alert an existing provisional (refresh only).
  const rerun = await processThirdParty(state);
  assert.strictEqual(rerun.find((r) => r.exam === 'CDS').action, 'provisional-refresh', 'no duplicate provisional email');
  pass('no duplicate provisional email on re-run');

  // 6. Upgrade: official confirmation flips the provisional flag (no re-email).
  const upgraded = upgradeProvisional(state, 'UPSC', 'CDS', new Date().toISOString());
  assert.strictEqual(upgraded, true);
  assert.strictEqual(state.records[cdsKey].provisional, false, 'provisional upgraded to confirmed');
  pass('provisional -> confirmed upgrade');

  // 7. Eligibility helpers remain available; current policy emails everything.
  assert.strictEqual(isAdmitCard('UPSC CDS II 2026 Admit Card Released'), true, 'admit card detected');
  assert.strictEqual(isAdmitCard('UPSC CDS II 2026 Notification'), false, 'notification is not an admit card');

  assert.strictEqual(profileQualifies('graduate'), true, 'graduate entries qualify');
  assert.strictEqual(profileQualifies('it'), true, 'IT entries qualify (CSE)');
  assert.strictEqual(profileQualifies('engineering'), true, 'engineering entries qualify (CSE)');
  assert.strictEqual(profileQualifies('flying'), false, 'flying not qualification-gated');

  // Current policy: alert on everything, regardless of computed status.
  assert.strictEqual(passesEmailGate({ status: NOT_ELIGIBLE, subEntry: { qualType: 'graduate' }, admitCard: false }), true, 'email-all: NOT ELIGIBLE still alerts');
  assert.strictEqual(passesEmailGate({ status: ELIGIBLE, subEntry: { qualType: 'graduate' }, admitCard: false }), true, 'email-all: ELIGIBLE alerts');
  assert.strictEqual(passesEmailGate({ status: UNCERTAIN, subEntry: { qualType: 'engineering' }, admitCard: true }), true, 'email-all: admit cards alert');
  pass('email-all policy + eligibility helpers');

  // 8. A FAILED send sets pendingRetry and is retried on the next run.
  const savedUser = process.env.SMTP_USER;
  const savedPass = process.env.SMTP_PASS;
  delete process.env.DRY_RUN;    // force the real deliver() path
  delete process.env.SMTP_USER;  // guarantee makeTransport() throws -> send fails
  delete process.env.SMTP_PASS;

  const stateR = { updatedAt: null, records: {} };
  const r1 = await processThirdParty(stateR);
  const cdsR1 = r1.find((r) => r.exam === 'CDS' && r.action === 'provisional-new');
  assert.ok(cdsR1, 'CDS provisional attempted');
  assert.strictEqual(cdsR1.emailed, false, 'failed send -> emailed:false');
  const recR = stateR.records[provisionalKey('UPSC', 'CDS', 'admit')];
  assert.strictEqual(recR.pendingRetry, true, 'pendingRetry set after a failed send');

  const r2 = await processThirdParty(stateR);
  assert.strictEqual(r2.find((r) => r.exam === 'CDS').action, 'provisional-retry', 'failed send is retried, not skipped');

  process.env.DRY_RUN = '1';
  if (savedUser !== undefined) process.env.SMTP_USER = savedUser;
  if (savedPass !== undefined) process.env.SMTP_PASS = savedPass;
  pass('failed send retries on next run (pendingRetry)');

  // 9. Closed application windows are suppressed (but admit cards still pass).
  assert.strictEqual(isClosed('SSC (various entries) Jun 27 Course is extended (Closed)'), true, '"(Closed)" is detected');
  assert.strictEqual(isClosed('Registration closed for this entry'), true, 'registration closed detected');
  assert.strictEqual(isClosed('Online application window is live. Login to apply.'), false, 'open window not flagged');
  assert.strictEqual(passesEmailGate({ status: UNCERTAIN, subEntry: { qualType: 'graduate' }, admitCard: false, closed: true }), false, 'closed non-admit entry is NOT emailed');
  assert.strictEqual(passesEmailGate({ status: UNCERTAIN, subEntry: { qualType: 'graduate' }, admitCard: true, closed: true }), true, 'admit card still emailed even if window closed');
  assert.strictEqual(passesEmailGate({ status: UNCERTAIN, subEntry: { qualType: 'graduate' }, admitCard: false, closed: false }), true, 'open entry still emailed');
  pass('closed applications suppressed; admit cards still alert');

  // 10. Concluded-exam engine: a result / answer key proves the exam was held,
  //     so a matching-edition admit card is treated as stale and dropped.
  const concluded = buildConcludedSet([
    'AFCAT 2 Result 2026 Out, Download Scorecard @afcat.edcil.co.in',
    'CDS 1 Answer Key 2026 Released',
  ]);
  assert.ok(
    concluded.has(editionKey('Indian Air Force', 'AFCAT', 'AFCAT 2 Admit Card 2026 Out')),
    'AFCAT 2 marked concluded from its result'
  );
  assert.strictEqual(
    concluded.has(editionKey('UPSC', 'CDS', 'CDS 2 Admit Card 2026 Out')),
    false,
    'CDS 2 not concluded (only CDS 1 answer key seen)'
  );
  assert.strictEqual(editionNumber('UPSC CDS II 2026 Admit Card'), '2', 'roman II -> 2');
  assert.strictEqual(editionNumber('AFCAT 2 Admit Card 2026'), '2', 'numeric edition parsed');
  assert.strictEqual(editionNumber('Indian Army TGC 144 Notification'), '', 'no false edition from vacancy count');
  pass('concluded-exam engine drops stale admit cards');

  // 11. Supersession engine: when a newer edition of an exam is present, older
  //     editions (notifications AND admit cards) are treated as stale.
  const latest = buildLatestCycle([
    'AFCAT 2 2026 Admit Card Out',
    'AFCAT 1 2026 Notification Out, Registration Starts',
    'CDS 2 Admit Card 2026 Out',
  ]);
  assert.strictEqual(
    isSuperseded(latest, 'Indian Air Force', 'AFCAT', 'AFCAT 1 2026 Notification Out'),
    true,
    'AFCAT 1 2026 superseded by AFCAT 2 2026'
  );
  assert.strictEqual(
    isSuperseded(latest, 'Indian Air Force', 'AFCAT', 'AFCAT 2 2026 Admit Card Out'),
    false,
    'newest AFCAT edition kept'
  );
  assert.strictEqual(
    isSuperseded(latest, 'UPSC', 'CDS', 'CDS 2 Admit Card 2026 Out'),
    false,
    'sole CDS edition kept'
  );
  // A higher year always wins even against a higher edition of an older year.
  const crossYear = buildLatestCycle(['AFCAT 1 2027 Notification Out', 'AFCAT 2 2026 Result Out']);
  assert.strictEqual(
    isSuperseded(crossYear, 'Indian Air Force', 'AFCAT', 'AFCAT 2 2026 Admit Card'),
    true,
    'AFCAT 2 2026 superseded by AFCAT 1 2027'
  );
  assert.strictEqual(
    isSuperseded(crossYear, 'Indian Air Force', 'AFCAT', 'AFCAT 1 2027 Notification'),
    false,
    'newest-year edition kept'
  );
  assert.strictEqual(editionYear('AFCAT 1 2026 Notification'), 2026, 'year parsed');
  pass('supersession engine drops older editions when a newer one exists');

  // 12. Lifecycle cleaner: an entry whose newest date is long past (application
  //     window closed / exam over) is expired; entries with no date or a future
  //     date are kept. Hindi month names are understood.
  const asOf = new Date('2026-09-11T00:00:00Z');
  assert.strictEqual(
    isStale('Indian Navy SSC Officer Recruitment 2026: \u0905\u0927\u093F\u0938\u0942\u091A\u0928\u093E, 16 \u092E\u0908 \u0938\u0947 \u0906\u0935\u0947\u0926\u0928 \u0936\u0941\u0930\u0942', asOf),
    true,
    'application opened 16 May (Hindi) -> window over'
  );
  assert.strictEqual(isStale('CDS 2 Admit Card 2026 Out, Download Hall Ticket PDF', asOf), false, 'no readable date -> kept');
  assert.strictEqual(isStale('Admit Card Out, Exam on 20 December 2026', asOf), false, 'future exam date -> kept');
  assert.strictEqual(isStale('Notification, last date 5 June 2026', asOf), true, 'deadline in past -> expired');
  assert.ok(newestDate('Exam 24 August 2026 and 20 December 2026', asOf).getUTCMonth() === 11, 'newest of multiple dates chosen');

  const cleanTarget = {
    records: {
      dead: { force: 'Indian Navy', exam: 'SSC Officer', title: 'Recruitment, 16 May 2026 apply', reason: '' },
      alive: { force: 'UPSC', exam: 'CDS', title: 'CDS 2 Admit Card 2026 Out', reason: '' },
    },
  };
  const removed = cleanState(cleanTarget, asOf);
  assert.strictEqual(removed, 1, 'exactly one expired record cleaned');
  assert.ok(!cleanTarget.records.dead, 'expired record deleted from state');
  assert.ok(cleanTarget.records.alive, 'live record retained');
  pass('lifecycle cleaner expires closed-window / held-exam entries and purges the JSON');

  // 13. Detail-page deadline parser: the last date lives in the article body,
  //     not the headline. A past last-date / closed apply window => expired.
  const asOfNov = new Date('2026-09-11T00:00:00Z');
  assert.strictEqual(
    isApplicationClosed('Last Date to Apply 11 June 2026 Exam Date To Be Announced', asOfNov),
    true,
    'labelled last date in the past -> closed'
  );
  assert.strictEqual(
    isApplicationClosed('Candidates can apply online from 9 July to 7 August 2026 for the April 2027 course', asOfNov),
    true,
    'apply window ended -> closed (future course session ignored)'
  );
  assert.strictEqual(
    isApplicationClosed('Last Date to Apply 20 December 2026, hurry now', asOfNov),
    false,
    'future last date -> still open'
  );
  assert.strictEqual(isApplicationClosed('No dates mentioned here at all', asOfNov), false, 'no date -> not closed');
  assert.strictEqual(
    applicationDeadline('Last Date to Apply 11 June 2026 Exam', asOfNov).getUTCDate(),
    11,
    'exact day parsed (not swallowed by the year)'
  );
  pass('detail-page deadline parser flags expired application windows');

  // 14. Exam-date lifecycle: once the exam day is past the entry is dead, even an
  //     admit card whose headline carries no date (the CDS-2-after-the-exam case).
  const asOfExam = new Date('2026-09-16T00:00:00Z');
  assert.strictEqual(examDate('CDS 2 exam will be held on 13 September 2026', asOfExam).getUTCDate(), 13, 'exam date read from body');
  assert.strictEqual(isExamOver('Written examination scheduled on 13 September 2026', asOfExam), true, 'past exam date -> over');
  assert.strictEqual(isExamOver('Exam Date 20 December 2026', asOfExam), false, 'future exam date -> not over');
  assert.strictEqual(isExamOver('No exam date printed here', asOfExam), false, 'no exam date -> not over');
  assert.strictEqual(hasPassed('2026-09-13T00:00:00Z', asOfExam), true, 'stored date before today -> passed');
  assert.strictEqual(hasPassed('2026-09-16T00:00:00Z', asOfExam), false, 'same day -> not passed');

  const examTarget = {
    records: {
      heldExam: { force: 'UPSC', exam: 'CDS', title: 'CDS 2 Admit Card 2026', reason: '', admitCard: true, examDate: '2026-09-13T00:00:00Z', firstSeen: asOfExam.toISOString() },
      oldAdmit: { force: 'UPSC', exam: 'NDA', title: 'NDA Admit Card', reason: '', admitCard: true, firstSeen: '2026-08-01T00:00:00Z' },
      upcoming: { force: 'IAF', exam: 'AFCAT', title: 'AFCAT Admit Card', reason: '', admitCard: true, examDate: '2026-12-20T00:00:00Z', firstSeen: asOfExam.toISOString() },
    },
  };
  const examRemoved = cleanState(examTarget, asOfExam);
  assert.strictEqual(examRemoved, 2, 'held-exam and long-stale admit cards cleaned');
  assert.ok(!examTarget.records.heldExam, 'admit card removed once exam date passed');
  assert.ok(!examTarget.records.oldAdmit, 'admit card older than the safety net removed');
  assert.ok(examTarget.records.upcoming, 'admit card for a future exam retained');
  pass('exam-date lifecycle retires held exams and long-stale admit cards');

  console.log('\nAll third-party tests passed.');
})().catch((err) => {
  console.error('TEST FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
