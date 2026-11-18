#!/usr/bin/env node
/* ============================================================
   Mnemos — build featured.json ("Aktuelle Winner" für die Startseite)

   Holt für eine Handvoll Brands die aktuell laufenden Ads über
   ScrapeCreators (inkl. Bild-URLs), pickt die stärksten Winner
   (Laufzeit + Reichweite) und schreibt featured.json.

   Nutzung:
     SC_KEY=dein-key node scripts/build-featured.mjs

   Brands unten in BRANDS eintragen (Facebook Page-ID + Anzeigename).
   Danach neu deployen. Beliebig oft wiederholbar, um "recent" zu halten.
   ============================================================ */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SC_KEY = process.env.SC_KEY || process.argv[2];
const COUNTRY = process.env.COUNTRY || 'ALL';           // weltweit
const PER_BRAND = Number(process.env.PER_BRAND || 2);   // max Ads pro Brand im Pool
const TOTAL = Number(process.env.TOTAL || 15);          // Gesamtzahl auf der Startseite
const SC_ROOT = 'https://api.scrapecreators.com/v1';

// Brands für die Startseite (Facebook Page-IDs; Namen kommen automatisch von ScrapeCreators).
const BRANDS = [
    '107585658730958', '184711951390377', '107818971346762', '1709552389065997',
    '107940537227344', '1816011248420064', '355136938262536', '125572610639402',
    '292298163958756', '133448227312984', '104409665708196', '306050696452078',
    '177930899801067', '183869772601', '345914995276546', '397641246768053',
    '101579225334663', '102454544917397', '2290435917939387'
].map(id => ({ id, name: id }));

if (!SC_KEY) { console.error('Fehlt: SC_KEY (ScrapeCreators API-Key).'); process.exit(1); }
if (!BRANDS.length) { console.error('Fehlt: Trage Brands in BRANDS ein (id + name).'); process.exit(1); }

const runtimeDays = (startTs, endTs) => {
    if (!startTs) return 0;
    const end = endTs ? endTs * 1000 : Date.now();
    return Math.max(0, Math.round((end - startTs * 1000) / 864e5));
};

// SC-Ad → App-Ad-Objekt (+ media), gespiegelt aus mapScAd in app.js
function mapAd(r) {
    const snap = r.snapshot || {};
    const images = [];
    (snap.images || []).forEach(i => { const u = i.original_image_url || i.resized_image_url; if (u) images.push(u); });
    (snap.cards || []).forEach(c => { const u = c.original_image_url || c.resized_image_url; if (u) images.push(u); });
    const v = (snap.videos || [])[0] || {};
    const video = v.video_hd_url || v.video_sd_url || null;
    const poster = v.video_preview_image_url || null;
    const body = (snap.body && snap.body.text) || snap.link_description || '';
    const title = snap.title || (snap.cards && snap.cards[0] && snap.cards[0].title) || '';
    const caption = snap.caption || snap.link_url || '';

    const ad = {
        id: String(r.ad_archive_id),
        page_id: String(r.page_id || ''),
        page_name: r.page_name || snap.page_name || 'Unbekannt',
        ad_creative_bodies: body ? [body] : [],
        ad_creative_link_titles: title ? [title] : [],
        ad_creative_link_captions: caption ? [caption] : [],
        ad_delivery_start_time: r.start_date ? new Date(r.start_date * 1000).toISOString().slice(0, 10) : null,
        ad_delivery_stop_time: r.is_active ? undefined : (r.end_date ? new Date(r.end_date * 1000).toISOString().slice(0, 10) : undefined),
        publisher_platforms: r.publisher_platform || [],
        eu_total_reach: r.reach_estimate || null,
        ad_snapshot_url: `https://www.facebook.com/ads/library/?id=${encodeURIComponent(r.ad_archive_id)}`,
        _impressions: r.impressions_with_index ? r.impressions_with_index.impressions_text : null,
        _landing: snap.link_url || (snap.cards && snap.cards[0] && snap.cards[0].link_url) || null,
        _sc: true
    };
    const media = (images.length || video || poster)
        ? { images: [...new Set(images)].slice(0, 6), video, poster, isVideo: (snap.videos || []).length > 0 }
        : null;
    const score = runtimeDays(r.start_date, r.end_date) * 1.5 + (r.reach_estimate || 0) / 5000;
    return { ad, media, score, active: !!r.is_active, hasImage: !!(images.length || poster) };
}

async function fetchBrand(brand) {
    const url = `${SC_ROOT}/facebook/adLibrary/company/ads?country=${COUNTRY}&status=ACTIVE&pageId=${encodeURIComponent(brand.id)}`;
    const res = await fetch(url, { headers: { 'x-api-key': SC_KEY } });
    if (!res.ok) { console.warn(`  ! ${brand.name}: HTTP ${res.status}`); return []; }
    const json = await res.json();
    const rows = json.searchResults || json.results || [];
    const mapped = rows.map(mapAd)
        .filter(m => m.active && m.hasImage)          // nur laufende Ads mit Bild
        .sort((a, b) => b.score - a.score)
        .slice(0, PER_BRAND);
    console.log(`  ✓ ${brand.name}: ${mapped.length} Winner (aus ${rows.length} Ads)`);
    return mapped;
}

const all = [];
for (const brand of BRANDS) {
    try { all.push(...await fetchBrand(brand)); }
    catch (e) { console.warn(`  ! ${brand.name}: ${e.message}`); }
}

// Marken-diverse Auswahl: erst der Top-Ad jeder Brand, dann auffüllen.
const byBrand = new Map();
all.forEach(m => { const k = m.ad.page_id || m.ad.page_name; if (!byBrand.has(k)) byBrand.set(k, []); byBrand.get(k).push(m); });
byBrand.forEach(list => list.sort((a, b) => b.score - a.score));

const picked = [];
const seen = new Set();
for (let rank = 0; rank < PER_BRAND && picked.length < TOTAL; rank++) {
    const brandsByTop = [...byBrand.values()].sort((a, b) => (b[0]?.score || 0) - (a[0]?.score || 0));
    for (const list of brandsByTop) {
        const m = list[rank];
        if (m && !seen.has(m.ad.id)) { seen.add(m.ad.id); picked.push(m); }
        if (picked.length >= TOTAL) break;
    }
}
const featured = picked.slice(0, TOTAL).map(({ ad, media }) => ({ ad, media }));

const out = { generated: new Date().toISOString(), country: COUNTRY, ads: featured };
const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'featured.json');
writeFileSync(outPath, JSON.stringify(out, null, 0));
console.log(`\n→ ${featured.length} Winner in featured.json geschrieben. Jetzt neu deployen.`);
