/* ============================================================
   Netlify Function — "Aktuelle Winner" für die Startseite.
   Holt die aktuellen Top-Ads der kuratierten Brands über
   ScrapeCreators und cached die Antwort 2 Tage am Edge — d.h.
   ScrapeCreators wird nur ~alle 2 Tage wirklich abgefragt.

   Route:  /api/featured   (siehe config.path unten)
   Secret: SC_KEY als Netlify-Umgebungsvariable (nie im Client).
   ============================================================ */

const SC_ROOT = 'https://api.scrapecreators.com/v1';
const COUNTRY = 'ALL';
const PER_BRAND = 2;
const TOTAL = 15;
const BRAND_IDS = [
    '107585658730958', '184711951390377', '107818971346762', '1709552389065997',
    '107940537227344', '1816011248420064', '355136938262536', '125572610639402',
    '292298163958756', '133448227312984', '104409665708196', '306050696452078',
    '177930899801067', '183869772601', '345914995276546', '397641246768053',
    '101579225334663', '102454544917397', '2290435917939387'
];

const runtimeDays = (startTs, endTs) => {
    if (!startTs) return 0;
    const end = endTs ? endTs * 1000 : Date.now();
    return Math.max(0, Math.round((end - startTs * 1000) / 864e5));
};

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

async function fetchBrand(key, id) {
    const url = `${SC_ROOT}/facebook/adLibrary/company/ads?country=${COUNTRY}&status=ACTIVE&pageId=${encodeURIComponent(id)}`;
    try {
        const res = await fetch(url, { headers: { 'x-api-key': key } });
        if (!res.ok) return [];
        const json = await res.json();
        const rows = json.searchResults || json.results || [];
        return rows.map(mapAd)
            .filter(m => m.active && m.hasImage)
            .sort((a, b) => b.score - a.score)
            .slice(0, PER_BRAND);
    } catch { return []; }
}

function selectDiverse(all) {
    const byBrand = new Map();
    all.forEach(m => { const k = m.ad.page_id || m.ad.page_name; if (!byBrand.has(k)) byBrand.set(k, []); byBrand.get(k).push(m); });
    byBrand.forEach(list => list.sort((a, b) => b.score - a.score));
    const picked = []; const seen = new Set();
    for (let rank = 0; rank < PER_BRAND && picked.length < TOTAL; rank++) {
        const brandsByTop = [...byBrand.values()].sort((a, b) => (b[0]?.score || 0) - (a[0]?.score || 0));
        for (const list of brandsByTop) {
            const m = list[rank];
            if (m && !seen.has(m.ad.id)) { seen.add(m.ad.id); picked.push(m); }
            if (picked.length >= TOTAL) break;
        }
    }
    return picked.slice(0, TOTAL).map(({ ad, media }) => ({ ad, media }));
}

export default async () => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        // 2 Wochen am Edge cachen, danach im Hintergrund erneuern.
        'Cache-Control': 'public, max-age=1209600, stale-while-revalidate=86400',
        'Netlify-CDN-Cache-Control': 'public, durable, max-age=1209600, stale-while-revalidate=86400'
    };
    const key = process.env.SC_KEY;
    if (!key) return new Response(JSON.stringify({ ads: [], error: 'SC_KEY missing' }), { status: 200, headers });
    try {
        const results = await Promise.all(BRAND_IDS.map(id => fetchBrand(key, id)));
        const ads = selectDiverse(results.flat());
        return new Response(JSON.stringify({ generated: new Date().toISOString(), country: COUNTRY, ads }), { status: 200, headers });
    } catch (e) {
        return new Response(JSON.stringify({ ads: [], error: String(e && e.message || e) }), { status: 200, headers });
    }
};

export const config = { path: '/api/featured' };
