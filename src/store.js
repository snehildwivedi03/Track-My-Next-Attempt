'use strict';

const fs = require('fs');
const path = require('path');
const { PRUNE_DAYS, PROVISIONAL_PRUNE_DAYS, EMAILED_PRUNE_DAYS } = require('./config');

const FILE = path.join(__dirname, '..', 'public', 'data', 'notifications.json');

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data.records) data.records = {};
    return data;
  } catch {
    return { updatedAt: null, records: {} };
  }
}

function save(data) {
  data.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

// Delete records not seen in the last PRUNE_DAYS days -> nothing kept permanently.
// Provisional (third-party-only) records use the shorter PROVISIONAL_PRUNE_DAYS.
function prune(data) {
  const now = Date.now();
  const cutoff = now - PRUNE_DAYS * 86400000;
  const provCutoff = now - PROVISIONAL_PRUNE_DAYS * 86400000;
  const emailedCutoff = now - EMAILED_PRUNE_DAYS * 86400000;
  let removed = 0;
  for (const [key, rec] of Object.entries(data.records)) {
    // Keep what we alerted on for a long window; unemailed provisional noise
    // gets the short window; everything else the normal one.
    const limit = rec.emailed ? emailedCutoff : rec.provisional ? provCutoff : cutoff;
    if (!rec.lastSeen || new Date(rec.lastSeen).getTime() < limit) {
      delete data.records[key];
      removed++;
    }
  }
  if (removed) console.log(`Pruned ${removed} record(s) past their retention window.`);
  return data;
}

// Stable key for a third-party provisional entry (deduped by exam, not URL).
// `kind` separates an admit-card alert from a notification alert for the same
// exam so both can be tracked and emailed independently.
function provisionalKey(force, exam, kind) {
  const base = `provisional::${force}::${exam}`;
  return kind === 'admit' ? `${base}::admit` : base;
}

// True if the exam is already tracked from a confirmed (official) fetch.
function hasConfirmedExam(data, force, exam) {
  return Object.values(data.records).some(
    (r) => !r.provisional && r.force === force && r.exam === exam
  );
}

// Flip any provisional record for this exam to confirmed once the official
// fetcher corroborates it. Returns true if something was upgraded.
function upgradeProvisional(data, force, exam, nowIso) {
  const stamp = nowIso || new Date().toISOString();
  let upgraded = false;
  for (const rec of Object.values(data.records)) {
    if (rec.provisional && rec.force === force && rec.exam === exam) {
      rec.provisional = false;
      rec.upgradedAt = stamp;
      rec.lastSeen = stamp;
      upgraded = true;
    }
  }
  return upgraded;
}

module.exports = {
  load,
  save,
  prune,
  FILE,
  provisionalKey,
  hasConfirmedExam,
  upgradeProvisional,
};
