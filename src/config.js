'use strict';

// ---- Your candidate profile (single source of truth for eligibility) ----
const PROFILE = {
  name: 'Candidate',
  dob: '2003-09-03', // 03 September 2003 (YYYY-MM-DD)
  qualification: 'B.Tech Computer Science and Engineering',
  degree: 'engineering',           // has an engineering degree
  discipline: 'computer science',  // used to match technical-branch requirements
  ncc: false,
};

// How many days a record is kept after it was LAST seen on the official site.
// Nothing is stored permanently: once a notification disappears from the site,
// its record is deleted 2 days later.
const PRUNE_DAYS = 2;

// Provisional (third-party-only) entries get a much shorter window: if the
// official site has not corroborated a third-party listing within a day, it is
// more likely noise (rumor / coaching post / misclassification) than real.
const PROVISIONAL_PRUNE_DAYS = 1;

// Anything we actually ALERTED on (emailed) stays visible for this long after it
// was last seen, so the website always reflects what was emailed even once the
// aggregator scrolls the listing off. Dated/closed items are removed earlier by
// the lifecycle cleaner regardless of this window.
const EMAILED_PRUNE_DAYS = 30;

// Qualification handling per sub-entry:
//   'graduate'    -> any bachelor's degree qualifies (CSE is fine)
//   'engineering' -> engineering degree AND the CSE discipline must be listed
//   'it'          -> CSE / IT discipline explicitly required (good fit)
//   'flying'      -> degree + strict age; used for Flying branches
//
// watch: true  -> always tracked even if likely NOT ELIGIBLE (hope/backup category)

// ---- Official sources and what to track on each ----
const SOURCES = [
  {
    force: 'UPSC',
    url: 'https://www.upsc.gov.in/',
    exams: [
      {
        exam: 'CDS',
        match: /combined\s*defence|c\.?d\.?s\.?/i,
        subEntries: [
          { code: 'IMA', qualType: 'graduate', watch: true },
          { code: 'INA', qualType: 'engineering' },
          { code: 'AFA', qualType: 'flying', watch: true },
          { code: 'OTA', qualType: 'graduate' },
        ],
      },
      {
        exam: 'CAPF AC',
        match: /central\s*armed\s*police|capf|assistant\s*commandant/i,
        subEntries: [{ code: 'CAPF AC', qualType: 'graduate' }],
      },
    ],
  },
  {
    force: 'Indian Army',
    url: 'https://www.joinindianarmy.nic.in/',
    exams: [
      {
        exam: 'TGC',
        match: /technical\s*graduate|\btgc\b/i,
        subEntries: [{ code: 'TGC', qualType: 'engineering', priority: true }],
      },
      {
        exam: 'SSC Tech',
        match: /ssc\s*\(?\s*tech|short\s*service.*tech|ssc\s*tech/i,
        subEntries: [{ code: 'SSC Tech', qualType: 'engineering' }],
      },
    ],
  },
  {
    force: 'Indian Navy',
    url: 'https://www.joinindiannavy.gov.in/',
    exams: [
      {
        exam: 'SSC IT',
        match: /ssc.*\bit\b|information\s*technology/i,
        subEntries: [{ code: 'SSC IT', qualType: 'it', priority: true }],
      },
      {
        exam: 'SSC Officer',
        match: /\bssc\b|executive|logistics|\bnaic\b|technical/i,
        subEntries: [{ code: 'SSC', qualType: 'graduate' }],
      },
    ],
  },
  {
    force: 'Indian Air Force',
    url: 'https://afcat.cdac.in/',
    exams: [
      {
        exam: 'AFCAT',
        match: /afcat/i,
        subEntries: [
          { code: 'Ground Duty (Non-Tech)', qualType: 'graduate' },
          { code: 'Ground Duty (Tech)', qualType: 'engineering' },
          { code: 'Flying', qualType: 'flying', watch: true },
        ],
      },
    ],
  },
];

// Things we explicitly never track (safety net for anchor matching).
const EXCLUDE = /\bnda\b|agniveer|\btes\b|national\s*defence\s*academy|gate|ncc\s*special/i;

// ---- Secondary, NON-authoritative discovery layer ----
// Third-party aggregator pages polled only to catch notifications faster or
// that the official-site scraper missed. Never a replacement for official
// eligibility/date data. Add more sites here without touching thirdparty.js.
// `selectors` are optional CSS overrides for that site's listing markup.
const THIRD_PARTY_SOURCES = [
  {
    site: 'govtjobsalert',
    url: 'https://govtjobsalert.in/defence-jobs/',
    selectors: { item: 'article', link: 'h2 a, h3 a, a', date: 'time, .date, .entry-date, .posted-on' },
  },
  {
    site: 'testbook',
    url: 'https://testbook.com/news/defence-jobs/',
    selectors: { item: 'article, li.card, .article-card', link: 'h2 a, h3 a, a', date: 'time, .date, .published-date' },
  },
];

module.exports = { PROFILE, PRUNE_DAYS, PROVISIONAL_PRUNE_DAYS, EMAILED_PRUNE_DAYS, SOURCES, EXCLUDE, THIRD_PARTY_SOURCES };
