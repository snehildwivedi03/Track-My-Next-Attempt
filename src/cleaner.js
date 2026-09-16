'use strict';

// Lifecycle cleaner. A recruitment/admit-card entry is only useful while its
// application window is open or its exam is still ahead. Once the newest date a
// listing mentions is well in the past, the window has closed / the exam is over
// and the entry is dead weight -- it must not be alerted, shown, or stored.
//
// This is date-driven and language-aware (English + Hindi month names) because
// aggregator headlines mix both (e.g. "... 16 मई से आवेदन शुरू").

// A listing whose newest calendar date is older than this is treated as expired.
// Sized so a normal (2-4 week) application window is comfortably over.
const STALE_DAYS = 45;

// Month name -> 0-based month index, covering English (short + long) and the
// Devanagari (Hindi) month names aggregators use.
const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
  '\u091C\u0928\u0935\u0930\u0940': 0, // जनवरी
  '\u092B\u0930\u0935\u0930\u0940': 1, // फरवरी
  '\u092E\u093E\u0930\u094D\u091A': 2, // मार्च
  '\u0905\u092A\u094D\u0930\u0948\u0932': 3, // अप्रैल
  '\u092E\u0908': 4, // मई
  '\u091C\u0942\u0928': 5, // जून
  '\u091C\u0941\u0932\u093E\u0908': 6, // जुलाई
  '\u0905\u0917\u0938\u094D\u0924': 7, // अगस्त
  '\u0938\u093F\u0924\u0902\u092C\u0930': 8, // सितंबर
  '\u0938\u093F\u0924\u092E\u094D\u092C\u0930': 8, // सितम्बर
  '\u0905\u0915\u094D\u0924\u0942\u092C\u0930': 9, // अक्तूबर
  '\u0905\u0915\u094D\u091F\u0942\u092C\u0930': 9, // अक्टूबर
  '\u0928\u0935\u0902\u092C\u0930': 10, // नवंबर
  '\u0928\u0935\u092E\u094D\u092C\u0930': 10, // नवम्बर
  '\u0926\u093F\u0938\u0902\u092C\u0930': 11, // दिसंबर
  '\u0926\u093F\u0938\u092E\u094D\u092C\u0930': 11, // दिसम्बर
};

// Pull every resolvable calendar date out of a blob of text. A date needs a day
// and a month; a missing year is filled from a 4-digit year elsewhere in the
// text, else the current year. Bare years ("2026") are ignored on purpose --
// they are not specific enough to decide a lifecycle.
function extractDates(text, now) {
  const s = String(text || '');
  if (!s) return [];
  const yearHit = s.match(/\b(20\d{2})\b/);
  const fallbackYear = yearHit ? Number(yearHit[1]) : (now || new Date()).getUTCFullYear();
  const dates = [];

  // "16 May 2026", "16 मई", "16-May", "16 May,"
  const dayMonth = /(?<!\d)(\d{1,2})\s*[-/.]?\s*([A-Za-z\u0900-\u097F]{2,20})\.?(?:[\s,\-/]+(\d{4}))?/g;
  let m;
  while ((m = dayMonth.exec(s)) !== null) {
    const day = Number(m[1]);
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon === undefined || day < 1 || day > 31) continue;
    const year = m[3] ? Number(m[3]) : fallbackYear;
    dates.push(new Date(Date.UTC(year, mon, day)));
  }

  // "September 16, 2026" / "May 16 2026" (the day must not be part of a year)
  const monthDay = /([A-Za-z\u0900-\u097F]{3,20})\.?\s+(\d{1,2})(?!\d)(?:[\s,\-/]+(\d{4}))?/g;
  while ((m = monthDay.exec(s)) !== null) {
    const mon = MONTHS[m[1].toLowerCase()];
    const day = Number(m[2]);
    if (mon === undefined || day < 1 || day > 31) continue;
    const year = m[3] ? Number(m[3]) : fallbackYear;
    dates.push(new Date(Date.UTC(year, mon, day)));
  }

  // Numeric: DD-MM-YYYY (Indian convention) and ISO YYYY-MM-DD.
  const dmy = /\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})\b/g;
  while ((m = dmy.exec(s)) !== null) {
    dates.push(new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])));
  }
  const ymd = /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g;
  while ((m = ymd.exec(s)) !== null) {
    dates.push(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
  }

  return dates.filter((d) => !isNaN(d));
}

// The newest (latest) date mentioned in the text, or null if none is readable.
function newestDate(text, now) {
  const dates = extractDates(text, now);
  if (!dates.length) return null;
  return dates.reduce((a, b) => (b > a ? b : a));
}

// A calendar date as it appears inside a sentence (day-month[-year], or numeric).
const DATE_TOKEN =
  '(\\d{1,2}\\s+[A-Za-z\\u0900-\\u097F]{3,20}\\.?(?:\\s+20\\d{2})?|20\\d{2}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.]20\\d{2})';

// Find the application closing date on a notification / detail page. Aggregators
// rarely put it in the headline, so this reads the article body. It looks at two
// shapes: a labelled "last date ... <date>" and an "apply ... to <date>" window,
// and returns the LATEST such date (the true final deadline) or null.
function applicationDeadline(text, now) {
  const s = String(text || '');
  if (!s) return null;
  const found = [];

  const labelled = new RegExp(
    '(?:last\\s*date(?:\\s*(?:to\\s*apply|of\\s*application|for\\s*(?:online\\s*)?(?:application|registration)|to\\s*submit))?' +
      '|closing\\s*date|registration\\s*(?:end\\s*date|last\\s*date|closes?)' +
      '|apply\\s*(?:online\\s*)?(?:till|by|upto|up\\s*to|before))\\b[^0-9]{0,25}?' +
      DATE_TOKEN,
    'gi'
  );
  const windowEnd = new RegExp(
    '(?:apply|registration|online\\s*form|window)[^.]{0,60}?\\bto\\s+' + DATE_TOKEN,
    'gi'
  );

  let m;
  while ((m = labelled.exec(s)) !== null) {
    const d = newestDate(m[1], now);
    if (d) found.push(d);
  }
  while ((m = windowEnd.exec(s)) !== null) {
    const d = newestDate(m[1], now);
    if (d) found.push(d);
  }

  if (!found.length) return null;
  return found.reduce((a, b) => (b > a ? b : a));
}

// True when a readable application deadline has already passed.
function isApplicationClosed(text, now = new Date()) {
  const dl = applicationDeadline(text, now);
  return !!dl && dl.getTime() < now.getTime();
}

// Midnight (UTC) of a given date -- so comparisons are whole-day, not by hour.
function startOfUTCDay(d) {
  const x = d instanceof Date ? d : new Date(d);
  return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
}

// True when `date` (a Date or ISO string) falls strictly before today's UTC day.
// "The exam is on the 13th, today is the 16th" -> passed. Same day -> not passed.
function hasPassed(date, now = new Date()) {
  if (!date) return false;
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d)) return false;
  return startOfUTCDay(d) < startOfUTCDay(now);
}

// Find the date the exam / written test / CBT is (or was) held. Notifications and
// aggregators phrase this many ways ("exam date", "will be held on", "CBT on",
// "date of examination"), so match a label and take the nearest date. Returns the
// LATEST such date (a multi-day exam ends on its last day) or null.
function examDate(text, now) {
  const s = String(text || '');
  if (!s) return null;
  const found = [];
  const re = new RegExp(
    '(?:' +
      'date\\s*of\\s*(?:the\\s*)?(?:written\\s*)?(?:exam(?:ination)?|test|cbt)' +
      '|(?:written\\s*)?exam(?:ination)?\\s*date' +
      '|(?:written\\s*)?(?:exam(?:ination)?|test|cbt)\\s*(?:is|will\\s*be|to\\s*be|shall\\s*be)?\\s*(?:held|conducted|scheduled)' +
      '|(?:exam(?:ination)?|test|cbt)\\s*(?:is\\s*)?(?:scheduled|held|conducted)\\s*(?:on|for)?' +
      '|(?:will\\s*be|to\\s*be|shall\\s*be)\\s*(?:held|conducted)\\s*on' +
    ')\\b[^0-9]{0,25}?' + DATE_TOKEN,
    'gi'
  );
  let m;
  while ((m = re.exec(s)) !== null) {
    const d = newestDate(m[1], now);
    if (d) found.push(d);
  }
  if (!found.length) return null;
  return found.reduce((a, b) => (b > a ? b : a));
}

// True when a readable exam date is already in the past (the exam day is over).
function isExamOver(text, now = new Date()) {
  return hasPassed(examDate(text, now), now);
}

// An admit card first seen more than this many days ago is for an exam that has
// certainly been held -- a safety net for when no exam date is machine-readable.
const ADMIT_STALE_DAYS = 21;

// True when the entry has clearly expired: the newest date it references is
// more than STALE_DAYS in the past. No readable date -> not stale (we never drop
// on a guess). A future date -> not stale (window still open / exam ahead).
function isStale(text, now = new Date(), staleDays = STALE_DAYS) {
  const newest = newestDate(text, now);
  if (!newest) return false;
  const ageDays = Math.floor((now.getTime() - newest.getTime()) / 86400000);
  return ageDays > staleDays;
}

// Physically delete expired records from the state so the website stops showing
// them and the JSON file does not grow without bound. Returns the count removed.
function cleanState(state, now = new Date()) {
  if (!state || !state.records) return 0;
  let removed = 0;
  for (const [key, rec] of Object.entries(state.records)) {
    const blob = `${rec.title || ''} ${rec.reason || ''}`;

    // 1) A recorded exam date that has passed -> the exam is over (covers admit
    //    cards, whose headline carries no readable date).
    if (rec.examDate && hasPassed(rec.examDate, now)) {
      delete state.records[key];
      removed++;
      console.log(`  - cleaned record (exam date passed): ${rec.exam} :: ${(rec.title || '').slice(0, 50)}`);
      continue;
    }

    // 2) An admit card first seen long ago -> its exam has certainly been held.
    if (rec.admitCard && rec.firstSeen) {
      const ageDays = Math.floor((now.getTime() - new Date(rec.firstSeen).getTime()) / 86400000);
      if (ageDays > ADMIT_STALE_DAYS) {
        delete state.records[key];
        removed++;
        console.log(`  - cleaned admit card (exam over, ${ageDays}d old): ${rec.exam} :: ${(rec.title || '').slice(0, 50)}`);
        continue;
      }
    }

    // 3) The newest date anywhere in the text is well past -> window/exam over.
    if (isStale(blob, now)) {
      delete state.records[key];
      removed++;
      console.log(`  - cleaned expired record (window/exam over): ${rec.exam} :: ${(rec.title || '').slice(0, 50)}`);
    }
  }
  if (removed) console.log(`Cleaned ${removed} expired record(s) from state.`);
  return removed;
}

module.exports = { isStale, newestDate, extractDates, applicationDeadline, isApplicationClosed, examDate, isExamOver, hasPassed, cleanState, STALE_DAYS, ADMIT_STALE_DAYS, MONTHS };
