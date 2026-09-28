'use strict';

const listEl = document.getElementById('list');
const filtersEl = document.getElementById('filters');
const updatedEl = document.getElementById('updated');

let records = [];
let filter = 'ALL';

// Force logos: real images for the three services, SVG shield fallback for UPSC.
// Filenames are case-sensitive on the Netlify (Linux) host.
const ICONS = {
  navy: '<img class="ficon" src="images/Navy.png" alt="" aria-hidden="true" />',
  air: '<img class="ficon" src="images/Airforce.png" alt="" aria-hidden="true" />',
  army: '<img class="ficon" src="images/army.png" alt="" aria-hidden="true" />',
  upsc:
    '<svg class="ficon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 2v6c0 4-3 7-7 9-4-2-7-5-7-9V5z" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 8v6M9 11h6" stroke="currentColor" stroke-width="1.7"/></svg>',
};

function forceMeta(force) {
  const f = String(force || '').toLowerCase();
  if (f.includes('navy')) return { cls: 'force-navy', icon: ICONS.navy };
  if (f.includes('air')) return { cls: 'force-air', icon: ICONS.air };
  if (f.includes('army')) return { cls: 'force-army', icon: ICONS.army };
  return { cls: 'force-upsc', icon: ICONS.upsc };
}

function tagClass(status) {
  if (status === 'ELIGIBLE') return 'ok';
  if (status === 'NOT ELIGIBLE') return 'no';
  return 'maybe';
}

function render() {
  const rows = records
    .filter((r) => {
      if (filter === 'ALL') return true;
      const isAdmit = !!r.admitCard || /admit\s*card/i.test(r.status || '');
      if (filter === 'ADMIT CARD') return isAdmit;
      // "Uncertain" groups both official eligibility-uncertain and third-party
      // unconfirmed (provisional) entries -- the ones alerted but not yet scored.
      if (filter === 'UNCERTAIN') return !isAdmit && /uncertain|unconfirmed/i.test(r.status || '');
      return r.status === filter;
    })
    .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

  if (!rows.length) {
    listEl.innerHTML = '<p class="empty">no notifications tracked right now.</p>';
    return;
  }

  listEl.innerHTML = rows
    .map(
      (r) => {
        const m = forceMeta(r.force);
        const isAdmit = !!r.admitCard || /admit\s*card/i.test(r.status || '');
        const admitBadge = isAdmit ? '<span class="tag admit">ADMIT CARD</span>' : '';
        const provBadge = r.provisional ? '<span class="tag prov">UNCONFIRMED</span>' : '';
        return `
      <div class="item ${m.cls}${isAdmit ? ' is-admit' : ''}">
        <div class="top">
          <span class="title">${m.icon}${esc(r.force)} &middot; ${esc(r.exam)} &middot; ${esc(r.subCode)}${
        r.changed ? ' (updated)' : ''
      }</span>
          <span class="tags">${admitBadge}${provBadge}<span class="tag ${tagClass(r.status)}">${esc(r.status)}</span></span>
        </div>
        ${r.firstSeen ? `<div class="meta date">notified ${esc(fmtDate(r.firstSeen))}</div>` : ''}
        <div class="meta">${esc(r.title || '')}</div>
        <div class="reason">${esc(r.reason || '')}</div>
        <div class="meta"><a href="${esc(r.url)}" target="_blank" rel="noopener">official notification &rarr;</a></div>
      </div>`;
      }
    )
    .join('');
}

function fmtDate(v) {
  const d = new Date(v);
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function buildFilters() {
  const opts = ['ALL', 'ADMIT CARD', 'ELIGIBLE', 'NOT ELIGIBLE', 'UNCERTAIN'];
  filtersEl.innerHTML = opts
    .map((o) => `<button data-f="${o}"${o === filter ? ' class="active"' : ''}>${o.toLowerCase()}</button>`)
    .join('');
  filtersEl.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      filter = b.dataset.f;
      buildFilters();
      render();
    })
  );
}

fetch('data/notifications.json?t=' + Date.now())
  .then((r) => r.json())
  .then((data) => {
    records = Object.values(data.records || {});
    updatedEl.textContent = data.updatedAt ? 'updated ' + new Date(data.updatedAt).toLocaleString() : '';
    buildFilters();
    render();
  })
  .catch(() => {
    listEl.innerHTML = '<p class="empty">could not load state.</p>';
  });
