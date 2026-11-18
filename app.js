/* ============================================================
   Mnemos — Meta Ad Library Explorer (by Elevion)
   Vanilla JS, keine Dependencies. Daten: Meta Ad Library API.
   ============================================================ */

(function () {
    'use strict';

    const API_VERSION = 'v21.0';
    const API_BASE = `https://graph.facebook.com/${API_VERSION}/ads_archive`;
    const PAGE_SIZE = 24;
    const FIELDS = [
        'id', 'page_id', 'page_name',
        'ad_creative_bodies', 'ad_creative_link_titles', 'ad_creative_link_captions',
        'ad_snapshot_url',
        'ad_delivery_start_time', 'ad_delivery_stop_time',
        'publisher_platforms', 'languages', 'eu_total_reach'
    ].join(',');

    // EU/EWR: offizielle Meta-API liefert ALLE Ads (DSA) — kostenlos.
    const EU_COUNTRIES = [
        ['DE', '🇩🇪 Deutschland'], ['AT', '🇦🇹 Österreich'], ['NL', '🇳🇱 Niederlande'],
        ['FR', '🇫🇷 Frankreich'], ['IT', '🇮🇹 Italien'], ['ES', '🇪🇸 Spanien'],
        ['PL', '🇵🇱 Polen'], ['SE', '🇸🇪 Schweden'], ['DK', '🇩🇰 Dänemark'],
        ['FI', '🇫🇮 Finnland'], ['BE', '🇧🇪 Belgien'], ['IE', '🇮🇪 Irland'],
        ['PT', '🇵🇹 Portugal'], ['CZ', '🇨🇿 Tschechien'], ['GR', '🇬🇷 Griechenland'],
        ['HU', '🇭🇺 Ungarn'], ['RO', '🇷🇴 Rumänien'], ['NO', '🇳🇴 Norwegen']
    ];
    // Außerhalb der EU: Meta-API gibt nur politische Ads her → ScrapeCreators-API (kostenpflichtig, Key nötig)
    const GLOBAL_COUNTRIES = [
        ['ALL', '🌍 Weltweit'], ['US', '🇺🇸 USA'], ['GB', '🇬🇧 UK'],
        ['CH', '🇨🇭 Schweiz'], ['CA', '🇨🇦 Kanada'], ['AU', '🇦🇺 Australien']
    ];
    const EU_SET = new Set(EU_COUNTRIES.map(c => c[0]));
    // Radar sucht Brand-Ads marktübergreifend (alle EU-Länder + UK) — kostenlos über Meta.
    const RADAR_COUNTRIES = [...EU_COUNTRIES.map(c => c[0]), 'GB'];
    const SC_API = 'https://api.scrapecreators.com/v1/facebook/adLibrary';
    const SC_ROOT = 'https://api.scrapecreators.com/v1';
    // Kuratierte „Aktuelle Winner" für die Startseite (kein Token nötig).
    // Primär: Function, die alle ~2 Tage frisch von ScrapeCreators zieht.
    // Fallback: der zuletzt generierte statische Snapshot.
    const FEATURED_URL = '/api/featured';
    const FEATURED_FALLBACK = '/featured.json';
    const APP_ORIGIN = '';   // für Download-Proxy

    // Keys that mirror to the cloud when the user is signed in.
    const CLOUD_SYNC = {
        brands: (v) => window.MnemosCloud.syncBrands(v),
        folders: (v) => window.MnemosCloud.syncFolders(v),
        savedAds: (v) => window.MnemosCloud.syncSavedAds(v)
    };

    const store = {
        get(key, fallback) {
            try { return JSON.parse(localStorage.getItem('mnemos_' + key)) ?? fallback; }
            catch { return fallback; }
        },
        set(key, value) {
            localStorage.setItem('mnemos_' + key, JSON.stringify(value));
            // Mirror to cloud (fire-and-forget) when logged in.
            const cloud = window.MnemosCloud;
            if (cloud && cloud.isLoggedIn() && CLOUD_SYNC[key]) {
                Promise.resolve(CLOUD_SYNC[key](value)).catch(e => console.warn('cloud sync', e));
            }
        },
        // Write only to localStorage — used while hydrating from cloud to avoid echo.
        setLocal(key, value) { localStorage.setItem('mnemos_' + key, JSON.stringify(value)); }
    };

    const state = {
        token: store.get('token', ''),
        country: store.get('country', 'DE'),
        brands: store.get('brands', []),          // [{id, name}]
        savedAds: store.get('savedAds', []),      // volle Ad-Objekte (+ .folder)
        folders: store.get('folders', []),        // [{id, name, parentId}] — Swipe-File-Ordner (Baum via parentId)
        savedFolder: null,                        // aktiver Ordner-Filter im Swipe File
        winnerDays: store.get('winnerDays', 60),
        winnerReach: store.get('winnerReach', 50000),
        radarFreqDays: store.get('radarFreqDays', 1),   // Auto-Tracking: 0=aus,1,3,7 Tage (gratis via Meta EU+UK)
        scKey: store.get('scKey', ''),            // ScrapeCreators API-Key (Nicht-EU-Länder)
        scCursor: null,                           // Pagination-Cursor für ScrapeCreators
        mode: 'graph',                            // 'graph' (Meta-API) | 'sc' (ScrapeCreators)
        results: [],
        nextUrl: null,
        loading: false,
        activeBrand: null,                        // {id, name} — filtert auf eine Page
        view: 'discover',
        user: null,                               // {id, email, name} wenn eingeloggt
        radarBrand: null,                         // {id, name} — aktive Brand im Radar
        radarFormat: null,                        // Format-Filter im Radar-Ranking
        radarMode: 'ranking',                     // 'ranking' | 'creatives'
        radarAds: [],                             // geladene Creatives der aktiven Radar-Brand
        formatFilter: null,                       // aktiver Ad-Format-Filter (id) oder null
        vocBrand: null,                           // aktiver Brand-Filter in Stimmen (page_id) oder null
        vocComments: [],                          // per ScrapeCreators geladene Kommentare (Session)
        vocLoading: false,
        lastVocQuotes: [],                        // aktuell angezeigte Quotes (für „Alle kopieren")
        featured: false,                          // zeigt die Startseite gerade die kuratierten Winner?
        snapshotting: false,                      // läuft gerade ein Client-Snapshot?
        demo: false,
        // Demo trotz Token nutzen (z. B. solange Metas Freischaltung aussteht)
        forceDemo: store.get('forceDemo', false)
    };

    const $ = (sel) => document.querySelector(sel);

    /* ========================================================
       DEMO-DATEN — zeigen die UI ohne Token
       ======================================================== */
    const DEMO_ADS = [
        { brand: 'LUMA Skincare', grad: ['#3d2c29', '#7a5c52'], tag: 'Skincare', headline: 'Glow ohne <em>Filter.</em>', body: 'Vitamin-C-Serum, das hält, was Instagram verspricht. 30 Tage testen — oder Geld zurück.', cta: 'Jetzt testen', platforms: ['facebook', 'instagram'], days: 42, reach: 184320 },
        { brand: 'KØBEN Athletics', grad: ['#101418', '#2e4a3f'], tag: 'Sportswear', headline: 'Leistung ist <em>leise.</em>', body: 'Trainingswear aus recyceltem Meeresplastik. Entwickelt mit Athleten aus Kopenhagen.', cta: 'Kollektion ansehen', platforms: ['instagram'], days: 12, reach: 96410 },
        { brand: 'Herr Brot', grad: ['#5c3a1e', '#a97b4f'], tag: 'Food & Beverage', headline: 'Sauerteig. <em>Sonst nichts.</em>', body: '48h Fermentation, 3 Zutaten, 0 Kompromisse. Jeden Morgen frisch an deine Tür geliefert.', cta: 'Abo starten', platforms: ['facebook', 'instagram', 'messenger'], days: 89, reach: 51230 },
        { brand: 'NOVA Sleep', grad: ['#1a1f3c', '#41518f'], tag: 'Sleep Tech', headline: 'Schlaf ist die neue <em>Superpower.</em>', body: 'Die Matratze mit adaptiven Zonen — von Schlafforschern entwickelt, von 40.000 Kunden geliebt.', cta: '100 Nächte testen', platforms: ['facebook'], days: 7, reach: 220845 },
        { brand: 'Fjell Outdoor', grad: ['#26332b', '#5d7a5a'], tag: 'Outdoor', headline: 'Regen ist nur <em>Wetter.</em>', body: 'Die 3-Lagen-Jacke, die norwegische Winter überlebt. Lebenslange Reparatur inklusive.', cta: 'Zur Jacke', platforms: ['instagram', 'audience_network'], days: 156, reach: 74560, ended: true },
        { brand: 'PURA Hydration', grad: ['#0e3a45', '#2e7d8c'], tag: 'Beverages', headline: 'Wasser, aber <em>ehrgeiziger.</em>', body: 'Elektrolyte ohne Zucker, ohne Süßstoff-Nachgeschmack. Für Menschen, die mehr vorhaben.', cta: 'Probierpaket', platforms: ['instagram'], days: 23, reach: 133900 },
        { brand: 'Atelier Ost', grad: ['#2b2320', '#8c6f4e'], tag: 'Interior', headline: 'Möbel mit <em>Herkunft.</em>', body: 'Massivholz aus deutschen Wäldern, gebaut in Brandenburg. Kein Sperrholz, keine Ausreden.', cta: 'Showroom entdecken', platforms: ['facebook', 'instagram'], days: 61, reach: 42180 },
        { brand: 'VELO Berlin', grad: ['#1c1c1c', '#800020'], tag: 'Mobility', headline: 'Dein Auto <em>hasst</em> diesen Trick.', body: 'E-Bike-Abo ab 39€/Monat. Versicherung, Wartung und Diebstahlschutz inklusive. Monatlich kündbar.', cta: 'Abo konfigurieren', platforms: ['facebook', 'instagram', 'messenger'], days: 4, reach: 310450 }
    ];

    function buildDemoResults() {
        const now = Date.now();
        return DEMO_ADS.map((d, i) => ({
            id: 'demo-' + i,
            page_id: 'demo-page-' + i,
            page_name: d.brand,
            ad_creative_bodies: [d.body],
            ad_creative_link_titles: [d.headline.replace(/<[^>]+>/g, '')],
            ad_delivery_start_time: new Date(now - d.days * 864e5).toISOString().slice(0, 10),
            ad_delivery_stop_time: d.ended ? new Date(now - 2 * 864e5).toISOString().slice(0, 10) : undefined,
            publisher_platforms: d.platforms,
            eu_total_reach: d.reach,
            languages: ['de'],
            _demo: d
        }));
    }

    /* ========================================================
       API
       ======================================================== */
    // Ohne eigenen Token → geteilter Meta-Proxy (Token liegt serverseitig).
    function usingSharedMeta() { return !state.token; }
    function metaUrl(qs) {
        return usingSharedMeta()
            ? `${APP_ORIGIN}/api/meta?${qs}`
            : `${API_BASE}?${qs}&access_token=${encodeURIComponent(state.token)}`;
    }

    function buildSearchUrl(mediaType) {
        const params = new URLSearchParams();
        params.set('ad_type', 'ALL');
        params.set('ad_reached_countries', JSON.stringify([state.country]));
        params.set('ad_active_status', $('#f-status').value);
        params.set('media_type', mediaType);
        params.set('fields', FIELDS);
        params.set('limit', String(PAGE_SIZE));

        const q = $('#search-input').value.trim();
        if (q) {
            params.set('search_terms', q);
            // search_type ist nur zusammen mit search_terms erlaubt —
            // sonst lehnt die API ab ("Please provide search_term field …")
            params.set('search_type', $('#f-searchtype').value);
        }
        if (state.activeBrand) params.set('search_page_ids', JSON.stringify([state.activeBrand.id]));

        const platform = $('#f-platform').value;
        if (platform) params.set('publisher_platforms', JSON.stringify([platform]));
        const lang = $('#f-lang').value;
        if (lang) params.set('languages', JSON.stringify([lang]));
        const dmin = $('#f-datemin').value;
        if (dmin) params.set('ad_delivery_date_min', dmin);
        const dmax = $('#f-datemax').value;
        if (dmax) params.set('ad_delivery_date_max', dmax);

        return metaUrl(params.toString());
    }

    async function fetchAds(url) {
        const res = await fetch(url);
        const json = await res.json();
        if (json.error) {
            const err = new Error(json.error.error_user_msg || json.error.message || 'Unbekannter API-Fehler');
            err.code = json.error.code;
            throw err;
        }
        return json;
    }

    /* ---------- ScrapeCreators (Nicht-EU-Länder: US, UK, weltweit) ---------- */
    function buildScUrl({ append = false } = {}) {
        const params = new URLSearchParams();
        params.set('country', state.country);
        params.set('status', $('#f-status').value);
        // Meta klassifiziert die meisten Statics intern als "Meme" —
        // "Bild (Statics)" fasst beide zusammen (wie die Ad-Library-Website)
        const media = $('#f-media').value;
        params.set('media_type', media === 'STATIC' ? 'IMAGE_AND_MEME' : media);
        const dmin = $('#f-datemin').value;
        if (dmin) params.set('start_date', dmin);
        const dmax = $('#f-datemax').value;
        if (dmax) params.set('end_date', dmax);
        if (append && state.scCursor) params.set('cursor', state.scCursor);

        if (state.activeBrand) {
            // Brand-Ansicht: eigener Endpoint mit pageId
            params.set('pageId', state.activeBrand.id);
            return `${SC_API}/company/ads?${params.toString()}`;
        }
        params.set('query', $('#search-input').value.trim());
        params.set('search_type', $('#f-searchtype').value.toLowerCase());
        return `${SC_API}/search/ads?${params.toString()}`;
    }

    async function fetchScAds(url) {
        const res = await fetch(url, { headers: { 'x-api-key': state.scKey } });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            const err = new Error(
                res.status === 401 ? 'ScrapeCreators-API-Key ungültig. Prüfe ihn in den Einstellungen.'
                : res.status === 402 || res.status === 403 ? 'ScrapeCreators-Credits aufgebraucht — auf scrapecreators.com aufladen.'
                : `ScrapeCreators-Fehler (${res.status}): ${text.slice(0, 120)}`);
            err.sc = true;
            throw err;
        }
        return res.json();
    }

    // ScrapeCreators-Ad → internes Format (wie Meta ads_archive)
    function mapScAd(r) {
        const snap = r.snapshot || {};
        const images = [];
        (snap.images || []).forEach(img => {
            const u = img.original_image_url || img.resized_image_url;
            if (u) images.push(u);
        });
        (snap.cards || []).forEach(card => {
            const u = card.original_image_url || card.resized_image_url;
            if (u) images.push(u);
        });
        const v = (snap.videos || [])[0] || {};
        const video = v.video_hd_url || v.video_sd_url || null;
        const poster = v.video_preview_image_url || null;

        const bodyText = (snap.body && snap.body.text) || snap.link_description || '';
        const title = snap.title || (snap.cards && snap.cards[0] && snap.cards[0].title) || '';
        const caption = snap.caption || snap.link_url || '';

        const ad = {
            id: String(r.ad_archive_id),
            page_id: String(r.page_id || ''),
            page_name: r.page_name || snap.page_name || 'Unbekannt',
            ad_creative_bodies: bodyText ? [bodyText] : [],
            ad_creative_link_titles: title ? [title] : [],
            ad_creative_link_captions: caption ? [caption] : [],
            ad_delivery_start_time: r.start_date ? new Date(r.start_date * 1000).toISOString().slice(0, 10) : null,
            ad_delivery_stop_time: r.is_active ? undefined
                : (r.end_date ? new Date(r.end_date * 1000).toISOString().slice(0, 10) : undefined),
            publisher_platforms: r.publisher_platform || [],
            eu_total_reach: r.reach_estimate || null,
            ad_snapshot_url: `https://www.facebook.com/ads/library/?id=${encodeURIComponent(r.ad_archive_id)}`,
            _impressions: r.impressions_with_index ? r.impressions_with_index.impressions_text : null,
            _landing: snap.link_url || (snap.cards && snap.cards[0] && snap.cards[0].link_url) || null,
            _cta: snap.cta_text || (snap.cta && snap.cta.text) || (snap.cards && snap.cards[0] && snap.cards[0].cta_text) || null,
            _sc: true
        };
        // Medien liefert ScrapeCreators direkt mit → in den Creative-Cache legen
        if (images.length || video || poster) {
            setCachedMedia(ad.id, {
                images: [...new Set(images)].slice(0, 6),
                video, poster,
                isVideo: (snap.videos || []).length > 0
            });
        }
        return ad;
    }

    async function runSearch({ append = false } = {}) {
        if (state.loading) return;

        // Jede neue Suche verlässt die kuratierte Startseite
        if (!append) { state.featured = false; $('#featured-head').hidden = true; }

        // Demo-Modus nur noch bewusst aktiviert (EU-Suche läuft sonst über den geteilten Meta-Proxy)
        if (state.forceDemo) {
            state.demo = true;
            state.results = buildDemoResults();
            const q = $('#search-input').value.trim().toLowerCase();
            if (q) {
                state.results = state.results.filter(ad =>
                    ad.page_name.toLowerCase().includes(q) ||
                    (ad.ad_creative_bodies || []).join(' ').toLowerCase().includes(q));
            }
            const status = $('#f-status').value;
            if (status === 'ACTIVE') state.results = state.results.filter(ad => !ad.ad_delivery_stop_time);
            if (status === 'INACTIVE') state.results = state.results.filter(ad => ad.ad_delivery_stop_time);
            const platform = $('#f-platform').value.toLowerCase();
            if (platform) state.results = state.results.filter(ad => (ad.publisher_platforms || []).includes(platform));
            state.nextUrl = null;
            renderResults();
            renderResultsMeta();
            updateDemoBanner();
            setStateBox(state.results.length ? null : 'empty');
            $('#btn-loadmore').hidden = true;
            return;
        }

        // Beide APIs verlangen einen Suchbegriff ODER eine Brand
        if (!append && !$('#search-input').value.trim() && !state.activeBrand) {
            state.results = [];
            state.nextUrl = null;
            state.scCursor = null;
            renderResults();
            renderResultsMeta();
            setStateBox('welcome');
            $('#btn-loadmore').hidden = true;
            return;
        }

        // Nicht-EU-Länder laufen über ScrapeCreators und brauchen einen Key
        const usesSc = !EU_SET.has(state.country);
        if (usesSc && !state.scKey) {
            state.results = [];
            state.nextUrl = null;
            state.scCursor = null;
            renderResults();
            renderResultsMeta();
            setStateBox('sc-key');
            $('#btn-loadmore').hidden = true;
            return;
        }

        state.demo = false;
        state.loading = true;
        if (!append) {
            state.mode = usesSc ? 'sc' : 'graph';
            state.results = [];
            state.formatFilter = null;   // Format-Filter bei neuer Suche zurücksetzen
            state.featured = false;
            $('#featured-head').hidden = true;
            renderResults();
            setStateBox('loading');
        }
        $('#btn-loadmore').hidden = true;

        try {
            let items, hasMore;
            if (state.mode === 'sc') {
                const json = await fetchScAds(buildScUrl({ append }));
                items = (json.searchResults || json.results || []).map(mapScAd);
                state.scCursor = json.cursor || null;
                hasMore = !!state.scCursor && items.length > 0;
            } else if ($('#f-media').value === 'STATIC') {
                // Meta-API kennt kein kombiniertes IMAGE_AND_MEME:
                // "Bild (Statics)" = IMAGE + MEME parallel abfragen und mergen
                const urls = append ? state.nextUrls : [buildSearchUrl('IMAGE'), buildSearchUrl('MEME')];
                const jsons = await Promise.all(urls.map(fetchAds));
                const seen = new Set(state.results.map(a => a.id));
                items = [];
                jsons.forEach(j => (j.data || []).forEach(ad => {
                    if (!seen.has(ad.id)) { seen.add(ad.id); items.push(ad); }
                }));
                items.sort((a, b) =>
                    new Date(b.ad_delivery_start_time || 0) - new Date(a.ad_delivery_start_time || 0));
                state.nextUrls = jsons
                    .map(j => j.paging && j.paging.next ? j.paging.next : null)
                    .filter(Boolean);
                hasMore = state.nextUrls.length > 0;
            } else {
                const url = append ? state.nextUrl : buildSearchUrl($('#f-media').value);
                const json = await fetchAds(url);
                items = json.data || [];
                state.nextUrl = json.paging && json.paging.next ? json.paging.next : null;
                hasMore = !!state.nextUrl;
            }
            state.results = append ? state.results.concat(items) : items;
            state._hasMore = hasMore;
            renderResults();
            if (state.results.length === 0) {
                setStateBox('empty');
            } else {
                setStateBox(null);
            }
        } catch (err) {
            console.error(err);
            // Eigener Token abgelaufen/ungültig? → automatisch auf geteilten Zugang zurückfallen
            const tokenErr = err && (err.code === 190 || /access token|session has expired|malformed/i.test(err.message || ''));
            if (tokenErr && state.token && state.mode === 'graph') {
                state.token = '';
                store.set('token', '');
                state.loading = false;
                toast('<i class="fa-solid fa-cloud"></i> Dein Meta-Token ist abgelaufen — geteilter Zugang wird genutzt');
                return runSearch({ append });
            }
            if (!append) state.results = [];
            state._hasMore = false;
            renderResults();
            setStateBox('error', err);
        } finally {
            state.loading = false;
            renderResultsMeta();
            $('#btn-loadmore').hidden = !state._hasMore;
        }
    }

    /* ========================================================
       RENDERING
       ======================================================== */
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const PLATFORM_ICONS = {
        facebook: 'fa-brands fa-facebook-f',
        instagram: 'fa-brands fa-instagram',
        messenger: 'fa-brands fa-facebook-messenger',
        audience_network: 'fa-solid fa-globe',
        threads: 'fa-brands fa-threads'
    };

    function fmtDate(iso) {
        if (!iso) return '';
        return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' });
    }

    function fmtReach(n) {
        if (n == null) return null;
        if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' Mio';
        if (n >= 1e3) return Math.round(n / 1e3) + 'k';
        return String(n);
    }

    function isBrandSaved(pageId) { return state.brands.some(b => b.id === pageId); }
    function isAdSaved(adId) { return state.savedAds.some(a => a.id === adId); }

    // Ziellink der Ad: ScrapeCreators liefert ihn direkt, die Meta-API nur die
    // Anzeige-Domain (caption); die Companion-Extension kann den echten Link nachliefern.
    function getLandingUrl(ad) {
        if (ad._landing) return ad._landing;
        const cached = getCachedMedia(ad.id);
        if (cached && cached.link) return cached.link;
        const cap = ((ad.ad_creative_link_captions || [])[0] || '').trim();
        if (/^https?:\/\//i.test(cap)) return cap;
        if (/^[\w.-]+\.[a-z]{2,}([\/?#]\S*)?$/i.test(cap)) return 'https://' + cap;
        return null;
    }

    // Laufzeit in Tagen (laufende Ads: bis heute)
    function runtimeDays(ad) {
        if (!ad.ad_delivery_start_time) return 0;
        const start = new Date(ad.ad_delivery_start_time).getTime();
        const end = ad.ad_delivery_stop_time ? new Date(ad.ad_delivery_stop_time).getTime() : Date.now();
        return Math.max(0, Math.round((end - start) / 864e5));
    }

    // Winner: langes Laufen ODER hohe Reichweite — Kriterien in den Einstellungen
    function isWinner(ad) {
        return runtimeDays(ad) >= state.winnerDays || (ad.eu_total_reach || 0) >= state.winnerReach;
    }

    /* ========================================================
       AD RANK / PERFORMANCE SCORE (0–100)
       Relative Gewichtung: Laufzeit (stärkstes öffentliches Signal,
       niemand lässt Verlierer-Ads lange laufen) > Reichweite > aktiv-Bonus.
       Nur berechnen, wenn wenigstens ein Signal vorliegt.
       ======================================================== */
    const SCORE_REACH_CAP = 500000;    // Reichweite, ab der der Reach-Anteil voll ausgeschöpft ist
    const SCORE_DAYS_CAP = 180;        // Laufzeit, ab der der Laufzeit-Anteil voll ausgeschöpft ist
    function adRankScore(ad) {
        if (ad._score !== undefined) return ad._score;
        const hasDays = !!ad.ad_delivery_start_time;
        const hasReach = ad.eu_total_reach != null;
        if (!hasDays && !hasReach) { ad._score = null; return null; }

        const dayScore = hasDays ? Math.min(1, runtimeDays(ad) / SCORE_DAYS_CAP) : null;
        const reachScore = hasReach ? Math.min(1, Math.log10(ad.eu_total_reach + 1) / Math.log10(SCORE_REACH_CAP + 1)) : null;

        let total = 0, weight = 0;
        if (dayScore !== null) { total += dayScore * 60; weight += 60; }
        if (reachScore !== null) { total += reachScore * 40; weight += 40; }
        let score = weight ? (total / weight) * 90 : 0;   // 90 lässt Platz für den Live-Bonus
        if (!ad.ad_delivery_stop_time) score += 10;        // aktive Ads laufen (noch) profitabel

        ad._score = Math.max(0, Math.min(100, Math.round(score)));
        return ad._score;
    }
    function scoreTier(score) {
        if (score == null) return 'none';
        if (score >= 70) return 'green';
        if (score >= 40) return 'yellow';
        return 'red';
    }
    function scoreBadgeHtml(ad) {
        const score = adRankScore(ad);
        const tier = scoreTier(score);
        return `<div class="rank-badge rank-${tier}" title="Performance Score — basierend auf Laufzeit, Reichweite &amp; Status">${score == null ? '—' : score}</div>`;
    }

    /* ========================================================
       AD-FORMAT-ERKENNUNG (Parker-Style, rein clientseitig)
       Klassifiziert jede Ad heuristisch nach ihrem Format anhand
       von Copy + Medientyp. Mehrere Formate pro Ad möglich.
       ======================================================== */
    const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, ' ');
    function adText(ad) {
        if (ad._demo) return stripTags([ad._demo.headline, ad._demo.body, ad._demo.tag].join('\n'));
        return stripTags([
            ...(ad.ad_creative_bodies || []),
            ...(ad.ad_creative_link_titles || []),
            ...(ad.ad_creative_link_captions || [])
        ].join('\n'));
    }

    // Reihenfolge = Priorität für das primäre Badge.
    const AD_FORMATS = [
        { id: 'testimonial', label: 'Testimonial', icon: 'fa-quote-left', test: (t) =>
            /[""„»«]|★|⭐|✩|\b\d(?:[.,]\d)?\s*\/\s*5\b|\b(bewertung|rezension|erfahrungsbericht|kundenstimme|review|testimonial)\b|\b(ich liebe|ich habe|seit ich|hat mein leben|endlich|kann ich nur|beste[rs]? \w+ (aller zeiten|ever)|i love|changed my life|game[- ]changer|obsessed|holy grail|life[- ]?saver)\b/i.test(t) },
        { id: 'comparison', label: 'Vergleich', icon: 'fa-code-compare', test: (t) =>
            /\bvs\.?\b|\bversus\b|\bgegen\b|vorher\s*[\/\-–]?\s*nachher|before\s*[\/\-–]?\s*after|\bstatt\b|im vergleich|\bunterschied\b|→|\bder unterschied\b/i.test(t) },
        { id: 'listicle', label: 'Listicle', icon: 'fa-list-ol', test: (t) =>
            /\b\d+\s+(gründe|wege|tipps|reasons|ways|things|schritte|fehler|dinge|hacks|arten|möglichkeiten)\b|\b\d+\s+(reasons why|gründe,? (warum|weshalb))\b|(^|\n)\s*[1-9][.)]\s/i.test(t) },
        { id: 'press', label: 'Press / Native', icon: 'fa-newspaper', test: (t) =>
            /\b(wie gesehen|bekannt aus|as seen (in|on)|featured in|laut studie|expert(en|inn?en)|forbes|vogue|\bbild\b|der spiegel|stern|focus|gala|new york times|techcrunch)\b|®|™/i.test(t) },
        { id: 'offer', label: 'Angebot / Sale', icon: 'fa-tag', test: (t) =>
            /(\d+\s*%)|%\s*(off|rabatt)|\b(rabatt|sale|gratis|kostenlos|spare[nd]?|gutschein|deal|angebot|reduziert|aktion|nur (heute|noch)|jetzt sichern|black friday|code\b|bogo|2 for 1|geld[- ]?zurück)\b|[€$£]\s?\d/i.test(t) },
        { id: 'benefits', label: 'Benefit-Liste', icon: 'fa-list-check', test: (t) =>
            /(✓|✔|✅|•|●|▶|➤|»)\s*\S/.test(t) || (t.match(/(^|\n)\s*[-–]\s+\S/g) || []).length >= 2 },
        { id: 'question', label: 'Frage-Hook', icon: 'fa-circle-question', test: (t) =>
            /\?/.test((t.split('\n')[0] || '')) || /\b(warum|wieso|weshalb|kennst du|wusstest du|schon mal|why do|did you know|struggling with|kämpfst du)\b/i.test(t) },
        { id: 'announcement', label: 'Launch / Neu', icon: 'fa-bullhorn', test: (t) =>
            /\b(neu\b|new\b|launch|jetzt (erhältlich|neu|da)|endlich da|vorbestell|pre[- ]?order|introducing|drop\b|frisch|soeben)\b/i.test(t) }
    ];
    const FORMAT_MAP = Object.fromEntries(AD_FORMATS.map(f => [f.id, f]));

    function detectFormats(ad) {
        if (ad._formats) return ad._formats;
        const t = adText(ad);
        ad._formats = AD_FORMATS.filter(f => { try { return f.test(t); } catch { return false; } }).map(f => f.id);
        return ad._formats;
    }

    // Anzeige-Liste: Format- + Winner-Filter + Sortierung (clientseitig auf geladene Ads)
    function displayedResults() {
        let list = state.results;
        if ($('#f-winner').checked) list = list.filter(isWinner);
        if (state.formatFilter) list = list.filter(ad => detectFormats(ad).includes(state.formatFilter));
        const sort = $('#f-sort').value;
        if (sort === 'reach') list = [...list].sort((a, b) => (b.eu_total_reach || 0) - (a.eu_total_reach || 0));
        if (sort === 'runtime') list = [...list].sort((a, b) => runtimeDays(b) - runtimeDays(a));
        if (sort === 'score') list = [...list].sort((a, b) => (adRankScore(b) ?? -1) - (adRankScore(a) ?? -1));
        return list;
    }

    /* ========================================================
       DUPLIKATIONS-ERKENNUNG — dieselbe Creative-Copy bei mehreren
       Advertisern = validiertes Winner-Signal. Vergleicht innerhalb
       des aktuell geladenen Suchergebnisses (state.results):
       - ad_creative_link_titles: exakter Match (normalisiert)
       - ad_creative_bodies: Fuzzy-Match >90% (Bigramm/Dice-Koeffizient)
       Nur Ads unterschiedlicher Advertiser (page_id) zählen als Dupe.
       ======================================================== */
    function normText(s) {
        return String(s || '').toLowerCase()
            .replace(/<[^>]*>/g, ' ')
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
    function bigrams(s) {
        const out = [];
        for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
        return out;
    }
    // Dice-Koeffizient auf Zeichen-Bigrammen — robust gegen kleine Abweichungen
    // (Emoji, Sonderzeichen, minimale Textänderungen) bei kurzem Copy-Text.
    function textSimilarity(a, b) {
        if (!a || !b) return 0;
        if (a === b) return 1;
        const A = bigrams(a), B = bigrams(b);
        if (!A.length || !B.length) return 0;
        const counts = new Map();
        B.forEach(bg => counts.set(bg, (counts.get(bg) || 0) + 1));
        let matches = 0;
        A.forEach(bg => { const c = counts.get(bg); if (c > 0) { matches++; counts.set(bg, c - 1); } });
        return (2 * matches) / (A.length + B.length);
    }

    function primaryBodyText(ad) {
        return normText((ad.ad_creative_bodies && ad.ad_creative_bodies[0]) || (ad._demo && ad._demo.body) || '');
    }
    function primaryTitleText(ad) {
        return normText((ad.ad_creative_link_titles && ad.ad_creative_link_titles[0]) || (ad._demo && stripTags(ad._demo.headline)) || '');
    }

    // Neu berechnet bei jedem Such-Render — union-find über state.results.
    function computeDuplicateInfo() {
        const list = state.results;
        const n = list.length;
        const parent = list.map((_, i) => i);
        const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
        const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

        const norms = list.map(ad => ({ body: primaryBodyText(ad), title: primaryTitleText(ad) }));

        for (let i = 0; i < n; i++) {
            if (!norms[i].body && !norms[i].title) continue;
            for (let j = i + 1; j < n; j++) {
                if (list[i].page_id && list[i].page_id === list[j].page_id) continue;
                let dup = false;
                if (norms[i].title && norms[i].title.length > 6 && norms[i].title === norms[j].title) dup = true;
                else if (norms[i].body && norms[j].body && norms[i].body.length > 15 && norms[j].body.length > 15
                    && textSimilarity(norms[i].body, norms[j].body) >= 0.9) dup = true;
                if (dup) union(i, j);
            }
        }

        const groups = new Map();   // root index -> [indices]
        for (let i = 0; i < n; i++) {
            if (!norms[i].body && !norms[i].title) continue;
            const r = find(i);
            if (!groups.has(r)) groups.set(r, []);
            groups.get(r).push(i);
        }

        const dupMap = new Map();   // adId -> [{id, name}]
        groups.forEach(idxs => {
            const shops = new Map();
            idxs.forEach(i => { const ad = list[i]; if (ad.page_id && !shops.has(ad.page_id)) shops.set(ad.page_id, ad.page_name || 'Unbekannt'); });
            if (shops.size < 2) return;
            const shopList = [...shops.entries()].map(([id, name]) => ({ id, name }));
            idxs.forEach(i => dupMap.set(list[i].id, shopList));
        });
        state._dupMap = dupMap;
    }

    // Duplikat-Info für eine Ad (funktioniert nur innerhalb des aktuellen Suchergebnisses).
    function dupInfo(ad) {
        return (state._dupMap && state._dupMap.get(ad.id)) || null;
    }
    function dupBadgeHtml(ad) {
        const shops = dupInfo(ad);
        if (!shops) return '';
        const names = shops.map(s => esc(s.name)).join(', ');
        return `<span class="meta-badge dup" title="Genutzt von: ${names}"><i class="fa-solid fa-clone"></i> Wird von ${shops.length} Shops genutzt</span>`;
    }

    // Deterministischer Farbverlauf pro Brand (Snapshot-iframes blockiert Meta via X-Frame-Options)
    const GRADIENTS = [
        ['#2b2320', '#8c6f4e'], ['#101418', '#2e4a3f'], ['#1a1f3c', '#41518f'],
        ['#3d2c29', '#7a5c52'], ['#26332b', '#5d7a5a'], ['#0e3a45', '#2e7d8c'],
        ['#1c1c1c', '#800020'], ['#33272e', '#7a4b5e']
    ];
    function gradFor(pageId) {
        let h = 0;
        for (const c of String(pageId || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
        return GRADIENTS[h % GRADIENTS.length];
    }

    function adCardHtml(ad, index, { savedView = false } = {}) {
        const active = !ad.ad_delivery_stop_time;
        const platforms = (ad.publisher_platforms || [])
            .map(p => `<i class="${PLATFORM_ICONS[p.toLowerCase()] || 'fa-solid fa-bullhorn'}" title="${esc(p)}"></i>`)
            .join(' ');
        const reach = fmtReach(ad.eu_total_reach);
        const body = (ad.ad_creative_bodies && ad.ad_creative_bodies[0]) || '';
        const brandSaved = isBrandSaved(ad.page_id);
        const adSaved = isAdSaved(ad.id);

        let frame;
        if (ad._demo) {
            frame = `
                <div class="demo-creative" style="background:linear-gradient(160deg, ${ad._demo.grad[0]}, ${ad._demo.grad[1]})">
                    <span class="dc-tag">${esc(ad._demo.tag)}</span>
                    <div>
                        <div class="dc-headline">${ad._demo.headline}</div>
                        <p class="dc-body" style="margin-top:14px">${esc(ad._demo.body)}</p>
                        <span class="dc-cta">${esc(ad._demo.cta)}</span>
                    </div>
                </div>`;
        } else {
            // Meta blockiert das Einbetten der Snapshot-Seite (X-Frame-Options: DENY),
            // daher: gestaltete Text-Creative-Karte + Link aufs echte Creative.
            const grad = gradFor(ad.page_id);
            const title = (ad.ad_creative_link_titles && ad.ad_creative_link_titles[0]) || ad.page_name || '';
            const caption = (ad.ad_creative_link_captions && ad.ad_creative_link_captions[0]) || 'Meta Ad';
            frame = `
                <div class="demo-creative real-creative" style="background:linear-gradient(160deg, ${grad[0]}, ${grad[1]})">
                    <span class="dc-tag">${esc(caption)}</span>
                    <div>
                        <div class="dc-headline dc-clamp">${esc(title)}</div>
                        ${body ? `<p class="dc-body dc-body-clamp" style="margin-top:14px">${esc(body)}</p>` : ''}
                        ${ad.ad_snapshot_url ? `<a class="dc-cta dc-cta-link" href="${esc(ad.ad_snapshot_url)}" target="_blank" rel="noopener" title="Echtes Creative in neuem Tab öffnen"><i class="fa-regular fa-eye"></i>&nbsp; Creative ansehen</a>` : ''}
                    </div>
                </div>`;
        }

        const dup = dupInfo(ad);
        return `
        <article class="ad-card ${dup ? 'ad-card--dup' : ''}" style="animation-delay:${Math.min(index % PAGE_SIZE, 12) * 0.05}s" data-ad-id="${esc(ad.id)}" ${savedView ? 'draggable="true"' : ''}>
            <div class="ad-head">
                <div class="brand-avatar">${brandAvatarInner(ad.page_id, ad.page_name)}</div>
                <div class="ad-head-info">
                    <button class="ad-brand-name" data-action="filter-brand" title="Alle Ads dieser Brand anzeigen">${esc(ad.page_name || 'Unbekannt')}</button>
                    <div class="ad-page-id">Page ID: ${esc(ad.page_id || '—')}</div>
                </div>
                <button class="star-btn ${brandSaved ? 'saved' : ''}" data-action="save-brand" title="${brandSaved ? 'Brand entfernen' : 'Brand speichern'}">
                    <i class="${brandSaved ? 'fa-solid' : 'fa-regular'} fa-star"></i>
                </button>
            </div>
            <div class="ad-frame">${scoreBadgeHtml(ad)}<div class="frame-media">${frame}</div></div>
            <div class="ad-meta">
                ${(() => { const f = detectFormats(ad)[0]; return f ? `<span class="meta-badge format" data-format="${f}"><i class="fa-solid ${FORMAT_MAP[f].icon}"></i> ${esc(FORMAT_MAP[f].label)}</span>` : ''; })()}
                ${isWinner(ad) ? '<span class="meta-badge winner"><i class="fa-solid fa-trophy"></i> Winner</span>' : ''}
                ${dupBadgeHtml(ad)}
                ${active
                    ? '<span class="meta-badge live">Live</span>'
                    : `<span class="meta-badge ended"><i class="fa-regular fa-circle-stop"></i> Beendet ${fmtDate(ad.ad_delivery_stop_time)}</span>`}
                <span class="meta-badge" title="Seit ${fmtDate(ad.ad_delivery_start_time)}"><i class="fa-regular fa-clock"></i> ${runtimeDays(ad)} Tage</span>
                ${platforms ? `<span class="meta-badge">${platforms}</span>` : ''}
                ${reach ? `<span class="meta-badge"><i class="fa-regular fa-eye"></i> ${reach} Reichweite</span>` : ''}
                ${!reach && ad._impressions ? `<span class="meta-badge"><i class="fa-regular fa-eye"></i> ${esc(ad._impressions)} Impressionen</span>` : ''}
            </div>
            <div class="ad-actions">
                <button class="btn btn-outline ${adSaved ? 'btn-saved' : ''}" data-action="save-ad">
                    <i class="${adSaved ? 'fa-solid' : 'fa-regular'} fa-bookmark"></i>${savedView ? 'Entfernen' : (adSaved ? 'Gespeichert' : 'Ad speichern')}
                </button>
                <button class="ext-link" data-action="view-copy" title="Copy-Text ansehen"><i class="fa-solid fa-align-left"></i></button>
                ${savedView ? '<button class="ext-link" data-action="move-folder" title="In Ordner verschieben"><i class="fa-regular fa-folder-open"></i></button>' : ''}
                ${!ad._demo && ad.ad_snapshot_url ? '<button class="ext-link" data-action="download-creative" title="Creative herunterladen"><i class="fa-solid fa-download"></i></button>' : ''}
                <a class="ext-link landing-link" ${getLandingUrl(ad) ? `href="${esc(getLandingUrl(ad))}"` : 'hidden'} target="_blank" rel="noopener" title="Zur Landingpage"><i class="fa-solid fa-globe"></i></a>
            </div>
        </article>`;
    }

    /* ========================================================
       COMPANION-EXTENSION — lädt echte Creatives inline.
       Meta blockiert iframes & Scraping; die Chrome-Extension
       "Mnemos Companion" (Ordner /extension) rendert die
       Snapshot-Seite im Hintergrund-Tab und liefert Medien-URLs.
       ======================================================== */
    const MEDIA_TTL = 24 * 3600 * 1000;
    const mediaCache = store.get('media', {});
    const companion = { active: false, pending: new Set() };

    function getCachedMedia(adId) {
        const entry = mediaCache[adId];
        if (!entry) return null;
        if (Date.now() - entry.t > MEDIA_TTL) { delete mediaCache[adId]; return null; }
        return entry.m;
    }
    function setCachedMedia(adId, media) {
        mediaCache[adId] = { t: Date.now(), m: media };
        const keys = Object.keys(mediaCache);
        if (keys.length > 400) {
            keys.sort((a, b) => mediaCache[a].t - mediaCache[b].t)
                .slice(0, keys.length - 400)
                .forEach(k => delete mediaCache[k]);
        }
        store.set('media', mediaCache);
    }

    function findAd(adId) {
        return state.results.find(a => a.id === adId)
            || state.savedAds.find(a => a.id === adId)
            || (state.radarAds && state.radarAds.find(a => a.id === adId));
    }

    function mediaHtml(ad, media) {
        const openBtn = `<a class="media-open" href="${esc(ad.ad_snapshot_url)}" target="_blank" rel="noopener" title="In der Ad Library öffnen"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>`;
        const expandBtn = `<button class="media-expand" data-action="expand-creative" title="Creative groß ansehen"><i class="fa-solid fa-up-right-and-down-left-from-center"></i></button>`;
        if (media.video) {
            return `<div class="media-wrap"><video controls playsinline muted preload="metadata" ${media.poster ? `poster="${esc(media.poster)}"` : ''} src="${esc(media.video)}"></video>${expandBtn}${openBtn}</div>`;
        }
        if (media.isVideo && media.poster) {
            return `<div class="media-wrap"><img class="media-img" data-action="expand-creative" src="${esc(media.poster)}" alt="Ad Creative" onload="this.classList.add('loaded')"><button class="media-play" data-action="expand-creative" title="Video ansehen"><i class="fa-solid fa-play"></i></button>${expandBtn}${openBtn}</div>`;
        }
        const imgs = media.images || [];
        if (imgs.length) {
            return `<div class="media-wrap"><img class="media-img" data-action="expand-creative" src="${esc(imgs[0])}" alt="Ad Creative" onload="this.classList.add('loaded')">${imgs.length > 1 ? `<span class="media-count"><i class="fa-regular fa-images"></i> ${imgs.length}</span>` : ''}${expandBtn}${openBtn}</div>`;
        }
        return null;
    }

    // Selektor bewusst nicht auf .ad-card beschränkt — die Detail-Drawer nutzt
    // dieselbe Pipeline (eigener [data-ad-id]-Container, kein .ad-card).
    function applyMedia(adId, media) {
        const ad = findAd(adId);
        if (!ad) return;
        const html = mediaHtml(ad, media);
        document.querySelectorAll(`[data-ad-id="${CSS.escape(adId)}"]`).forEach(card => {
            const frame = card.querySelector('.ad-frame');
            // .frame-media ist der reine Medien-Slot — der Rest von .ad-frame
            // (z. B. der Performance-Score-Badge) bleibt beim Ersetzen erhalten.
            const slot = card.querySelector('.frame-media') || frame;
            if (frame && slot && html) {
                frame.classList.remove('frame-loading');
                slot.innerHTML = html;
            }
            // Landingpage-Link nachrüsten, wenn die Extension ihn extrahiert hat
            if (media.link) {
                const a = card.querySelector('.landing-link');
                if (a) { a.href = media.link; a.hidden = false; }
            }
        });
    }

    function setFrameLoading(adId, on) {
        document.querySelectorAll(`[data-ad-id="${CSS.escape(adId)}"] .ad-frame`).forEach(f =>
            f.classList.toggle('frame-loading', on));
    }

    function requestCreative(ad) {
        if (!companion.active || companion.pending.has(ad.id)) return;
        companion.pending.add(ad.id);
        setFrameLoading(ad.id, true);
        window.postMessage({ source: 'mnemos-app', type: 'fetch-creative', adId: ad.id, snapshotUrl: ad.ad_snapshot_url }, '*');
    }

    /* ---------- Serverless Fallback (Netlify Function) ----------
       Ohne Companion-Extension (Mobile, oder Desktop ohne Install)
       holt eine Netlify Function die Snapshot-Seite serverseitig und
       extrahiert die Medien-URLs — gleiches Ergebnis, kein Browser-Tab
       nötig. Kleine Parallelitäts-Queue, damit nicht alle sichtbaren
       Karten gleichzeitig anfragen. */
    const FALLBACK_MAX_PARALLEL = 2;
    let fallbackActive = 0;
    const fallbackQueue = [];

    async function fetchCreativeFallback(ad) {
        try {
            const url = `${APP_ORIGIN}/api/creative?snapshotUrl=${encodeURIComponent(ad.ad_snapshot_url)}&adId=${encodeURIComponent(ad.id)}`;
            const res = await fetch(url);
            const json = await res.json();
            if (json && json.ok && json.media) {
                setCachedMedia(ad.id, json.media);
                applyMedia(ad.id, json.media);
                return json.media;
            }
        } catch (e) { /* kein Creative gefunden — Text-Karte bleibt stehen */ }
        return null;
    }

    function pumpFallbackQueue() {
        while (fallbackActive < FALLBACK_MAX_PARALLEL && fallbackQueue.length) {
            const { ad, resolve } = fallbackQueue.shift();
            fallbackActive++;
            setFrameLoading(ad.id, true);
            fetchCreativeFallback(ad).then((media) => {
                fallbackActive--;
                companion.pending.delete(ad.id);
                setFrameLoading(ad.id, false);
                resolve(media);
                pumpFallbackQueue();
            });
        }
    }

    function queueFallbackFetch(ad) {
        if (companion.pending.has(ad.id)) return Promise.resolve(null);
        companion.pending.add(ad.id);
        return new Promise((resolve) => {
            fallbackQueue.push({ ad, resolve });
            pumpFallbackQueue();
        });
    }

    // Holt (falls nötig) das Creative einer Ad und liefert es zurück — via
    // Companion-Extension, wenn aktiv, sonst über die Netlify-Function.
    function ensureMedia(ad) {
        const cached = ad._media || getCachedMedia(ad.id);
        if (cached) return Promise.resolve(cached);
        if (!ad.ad_snapshot_url) return Promise.resolve(null);
        if (companion.active) {
            if (companion.pending.has(ad.id)) {
                // Bereits unterwegs — auf die nächste 'creative'-Message warten.
                return new Promise((resolve) => {
                    const handler = (event) => {
                        const msg = event.data;
                        if (!msg || msg.source !== 'mnemos-companion' || msg.type !== 'creative' || msg.adId !== ad.id) return;
                        window.removeEventListener('message', handler);
                        resolve(msg.ok && msg.media ? msg.media : null);
                    };
                    window.addEventListener('message', handler);
                });
            }
            return new Promise((resolve) => {
                const handler = (event) => {
                    const msg = event.data;
                    if (!msg || msg.source !== 'mnemos-companion' || msg.type !== 'creative' || msg.adId !== ad.id) return;
                    window.removeEventListener('message', handler);
                    resolve(msg.ok && msg.media ? msg.media : null);
                };
                window.addEventListener('message', handler);
                requestCreative(ad);
            });
        }
        return queueFallbackFetch(ad);
    }

    async function downloadAdCreative(ad) {
        const nameBase = `${(ad.page_name || 'ad').replace(/[^\w]+/g, '-')}-${ad.id}`;
        let media = ad._media || getCachedMedia(ad.id);
        if (!media) {
            toast('<i class="fa-solid fa-spinner fa-spin"></i> Creative wird geladen …');
            media = await ensureMedia(ad);
        }
        const url = media && (media.video || (media.images && media.images[0]) || media.poster);
        if (!url) {
            toast('<i class="fa-solid fa-circle-info"></i> Kein direktes Creative gefunden — in der Ad Library ansehen');
            return;
        }
        downloadCreative(url, nameBase);
    }

    const frameObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            frameObserver.unobserve(entry.target);
            const card = entry.target.closest('.ad-card');
            const ad = card && findAd(card.dataset.adId);
            if (!ad) return;
            if (companion.active) requestCreative(ad);
            else queueFallbackFetch(ad);
        });
    }, { rootMargin: '500px' });

    // Für alle echten Ads: gecachte Medien sofort einsetzen, Rest lazy anfragen
    // (Companion-Extension, wenn aktiv — sonst automatisch die Netlify-Function).
    function scanFrames(container) {
        container.querySelectorAll('.ad-card').forEach(card => {
            const ad = findAd(card.dataset.adId);
            if (!ad || ad._demo || !ad.ad_snapshot_url) return;
            const cached = getCachedMedia(ad.id);
            if (cached) {
                applyMedia(ad.id, cached);
            } else {
                frameObserver.observe(card.querySelector('.ad-frame'));
            }
        });
    }

    // Gleiche Logik wie scanFrames(), aber für den Detail-Drawer (kein .ad-card-Grid).
    function scanDrawerFrame(ad) {
        if (!ad || ad._demo || !ad.ad_snapshot_url) return;
        const cached = getCachedMedia(ad.id);
        if (cached) applyMedia(ad.id, cached);
        else if (companion.active) requestCreative(ad);
        else queueFallbackFetch(ad);
    }

    // Gibt es geladene echte Ads, deren Creatives nur die Companion-Extension liefern kann?
    function hasCompanionCandidates() {
        return state.results.some(ad => !ad._demo && ad.ad_snapshot_url && !ad._sc && !getCachedMedia(ad.id));
    }

    function updateCompanionBadge() {
        const badge = $('#companion-badge');
        if (!badge) return;
        if (companion.active) {
            badge.innerHTML = '<i class="fa-solid fa-circle" style="font-size:7px;color:#1a7a3c"></i> Companion aktiv';
        } else if (hasCompanionCandidates()) {
            badge.innerHTML = '<button class="companion-hint" data-action="companion-help">' +
                '<i class="fa-solid fa-image"></i> Creatives fehlen? Companion-Extension einrichten</button>';
        } else {
            badge.innerHTML = '';
        }
    }

    // Kurz nach dem Laden echter EU-Ads prüfen, ob sich die Extension gemeldet hat
    let companionCheckTimer = null;
    function scheduleCompanionCheck() {
        clearTimeout(companionCheckTimer);
        if (companion.active) return;
        companionCheckTimer = setTimeout(updateCompanionBadge, 1800);
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const msg = event.data;
        if (!msg || msg.source !== 'mnemos-companion') return;
        if (msg.type === 'hello' && !companion.active) {
            companion.active = true;
            updateCompanionBadge();
            scanFrames(document);
        }
        if (msg.type === 'creative') {
            companion.pending.delete(msg.adId);
            setFrameLoading(msg.adId, false);
            if (msg.ok && msg.media) {
                setCachedMedia(msg.adId, msg.media);
                applyMedia(msg.adId, msg.media);
            }
            // Bei Fehler bleibt die Text-Creative-Karte stehen
        }
    });

    function renderFormatChips() {
        const wrap = $('#format-chips');
        if (!wrap) return;
        // Formate + Häufigkeit über alle geladenen Ads
        const counts = {};
        state.results.forEach(ad => detectFormats(ad).forEach(f => { counts[f] = (counts[f] || 0) + 1; }));
        const present = AD_FORMATS.filter(f => counts[f.id]);
        if (state.results.length === 0 || present.length === 0) {
            wrap.hidden = true; wrap.innerHTML = ''; return;
        }
        wrap.hidden = false;
        const rows = [`<button class="fchip ${state.formatFilter === null ? 'active' : ''}" data-format-filter="">
            <i class="fa-solid fa-layer-group"></i>Alle <span class="fchip-count">${state.results.length}</span></button>`];
        present.forEach(f => {
            const on = state.formatFilter === f.id;
            rows.push(`<button class="fchip ${on ? 'active' : ''}" data-format-filter="${f.id}" title="Nur ${esc(f.label)}-Ads">
                <i class="fa-solid ${f.icon}"></i>${esc(f.label)} <span class="fchip-count">${counts[f.id]}</span></button>`);
        });
        wrap.innerHTML = rows.join('');
    }

    function renderResults() {
        const grid = $('#results-grid');
        computeDuplicateInfo();
        const list = displayedResults();
        renderFormatChips();
        grid.innerHTML = list.map((ad, i) => adCardHtml(ad, i)).join('');
        scanFrames(grid);
        if (state.results.length > 0 && list.length === 0) {
            setStateBox(state.formatFilter ? 'no-format' : 'no-winners');
        } else if (list.length > 0) {
            setStateBox(null);
        }
    }

    function renderResultsMeta() {
        const meta = $('#results-meta');
        if (state.results.length === 0) { meta.hidden = true; return; }
        meta.hidden = false;
        const shown = displayedResults().length;
        const sort = $('#f-sort').value;
        const parts = [];
        if (state.featured) {
            parts.push(shown === state.results.length
                ? `${state.results.length} aktuelle Winner`
                : `${shown} von ${state.results.length} Winnern`);
        } else {
            parts.push(shown === state.results.length
                ? `${state.results.length} Ads geladen`
                : `${shown} von ${state.results.length} geladenen Ads`);
        }
        if (sort === 'reach') parts.push('sortiert nach Reichweite');
        if (sort === 'runtime') parts.push('sortiert nach Laufzeit');
        if (state._hasMore) parts.push('mehr verfügbar');
        if (state.demo) parts.push('Demo');
        if (state.mode === 'sc' && !state.demo) parts.push('via ScrapeCreators');
        $('#results-count').textContent = parts.join(' — ');
        updateCompanionBadge();
        scheduleCompanionCheck();
    }

    function setStateBox(type, err) {
        const box = $('#state-box');
        if (!type) { box.innerHTML = ''; return; }
        if (type === 'loading') {
            box.innerHTML = `<i class="fa-solid fa-circle-notch spinner"></i>`;
        } else if (type === 'empty') {
            box.innerHTML = `
                <div class="state-icon"><i class="fa-regular fa-folder-open"></i></div>
                <h3>Keine Ads gefunden</h3>
                <p>Versuch andere Keywords oder weniger Filter. Tipp: „Status: Alle" zeigt auch beendete Kampagnen.</p>`;
        } else if (type === 'error') {
            const isPending = err && err.code === 10;
            const isAuth = err && (err.code === 190 || err.code === 104 || err.code === 2500);
            if (isPending) {
                box.innerHTML = `
                    <div class="state-icon"><i class="fa-regular fa-hourglass-half"></i></div>
                    <h3>Zugriff noch nicht freigeschaltet</h3>
                    <p>Dein Token ist gültig, aber Meta hat den Ad-Library-Zugriff für deinen Account noch nicht aktiviert.
                    Schließe die Identitätsbestätigung ab und akzeptiere die Bedingungen unter
                    <a href="https://www.facebook.com/ads/library/api" target="_blank" rel="noopener" style="color:var(--red);font-weight:700">facebook.com/ads/library/api</a>
                    — die Freischaltung dauert danach meist 1–2 Tage.</p>
                    <button class="btn btn-primary" data-action="use-demo">Solange mit Demo-Daten testen</button>`;
                return;
            }
            box.innerHTML = `
                <div class="state-icon"><i class="fa-solid fa-triangle-exclamation"></i></div>
                <h3>${isAuth ? 'Token-Problem' : 'Fehler bei der Anfrage'}</h3>
                <p>${esc(err ? err.message : '')}</p>
                ${isAuth ? '<button class="btn btn-primary" data-action="open-settings">Token prüfen</button>' : ''}`;
        } else if (type === 'sc-key') {
            box.innerHTML = `
                <div class="state-icon"><i class="fa-solid fa-globe"></i></div>
                <h3>API-Key für globale Suche nötig</h3>
                <p>Metas offizielle API liefert außerhalb der EU nur politische Ads. Für ${esc(state.country === 'ALL' ? 'die weltweite Suche' : 'dieses Land')}
                nutzt Mnemos die <a href="https://scrapecreators.com" target="_blank" rel="noopener" style="color:var(--red);font-weight:700">ScrapeCreators-API</a>
                — dort registrieren (1.000 Suchen gratis, keine Kreditkarte) und den Key hier eintragen.</p>
                <button class="btn btn-primary" data-action="open-settings">Key eintragen</button>`;
        } else if (type === 'no-winners') {
            box.innerHTML = `
                <div class="state-icon"><i class="fa-solid fa-trophy"></i></div>
                <h3>Keine Winner in den geladenen Ads</h3>
                <p>Lade mehr Ads oder passe die Winner-Kriterien in den Einstellungen an (aktuell: Laufzeit ≥ ${state.winnerDays} Tage oder Reichweite ≥ ${fmtReach(state.winnerReach)}).</p>`;
        } else if (type === 'no-format') {
            const f = FORMAT_MAP[state.formatFilter];
            box.innerHTML = `
                <div class="state-icon"><i class="fa-solid ${f ? f.icon : 'fa-filter'}"></i></div>
                <h3>Keine ${f ? esc(f.label) : ''}-Ads in den geladenen Ergebnissen</h3>
                <p>Lade mehr Ads nach oder wähle oben ein anderes Format.</p>`;
        } else if (type === 'welcome') {
            box.innerHTML = `
                <div class="state-icon"><i class="fa-solid fa-magnifying-glass"></i></div>
                <h3>Starte eine Suche</h3>
                <p>Gib ein Keyword ein oder klicke auf eine gespeicherte Brand, um deren aktuelle Ads zu sehen.</p>`;
        }
    }

    /* ========================================================
       BRANDS
       ======================================================== */
    function toggleBrand(pageId, pageName) {
        if (isBrandSaved(pageId)) {
            state.brands = state.brands.filter(b => b.id !== pageId);
            toast(`<i class="fa-regular fa-star"></i> ${esc(pageName)} entfernt`);
        } else {
            state.brands.push({ id: pageId, name: pageName });
            toast(`<i class="fa-solid fa-star"></i> ${esc(pageName)} zur Watchlist hinzugefügt`);
        }
        store.set('brands', state.brands);
        renderBrandChips();
        renderBrandsView();
        renderCounts();
        // Sterne in sichtbaren Karten aktualisieren
        document.querySelectorAll('.ad-card').forEach(card => {
            const id = card.dataset.adId;
            const ad = state.results.find(a => a.id === id) || state.savedAds.find(a => a.id === id);
            if (!ad || ad.page_id !== pageId) return;
            const btn = card.querySelector('[data-action="save-brand"]');
            const saved = isBrandSaved(pageId);
            btn.classList.toggle('saved', saved);
            btn.innerHTML = `<i class="${saved ? 'fa-solid' : 'fa-regular'} fa-star"></i>`;
        });
    }

    function toggleBrandTracked(brandId) {
        const brand = state.brands.find(b => b.id === brandId);
        if (!brand) return;
        brand.tracked = brand.tracked === false;   // war pausiert (false) → jetzt an; sonst → aus
        store.set('brands', state.brands);
        renderBrandsView();
        if (state.view === 'radar') renderRadarView();
        toast(brand.tracked
            ? `<i class="fa-solid fa-chart-line"></i> ${esc(brand.name)} wird jetzt getrackt`
            : `<i class="fa-regular fa-circle"></i> Tracking für ${esc(brand.name)} pausiert`);
    }

    function renderBrandChips() {
        const wrap = $('#brand-chips');
        wrap.innerHTML = state.brands.map(b => `
            <button class="chip ${state.activeBrand && state.activeBrand.id === b.id ? 'active' : ''}" data-brand-id="${esc(b.id)}">
                <i class="fa-solid fa-star"></i>${esc(b.name)}
            </button>`).join('');
    }

    // Echtes Page-Profilbild (öffentlich, kein Token) mit Buchstaben-Fallback
    function brandAvatarInner(pageId, name) {
        const letter = esc((name || '?').charAt(0));
        if (!pageId || /^demo-/.test(String(pageId))) return `<span class="ba-letter">${letter}</span>`;
        const src = `https://graph.facebook.com/${encodeURIComponent(pageId)}/picture?type=square&width=120`;
        return `<span class="ba-letter">${letter}</span>` +
            `<img src="${esc(src)}" alt="" onload="this.classList.add('loaded')" onerror="this.remove()">`;
    }
    function brandAvatarHtml(pageId, name) {
        return `<div class="brand-avatar">${brandAvatarInner(pageId, name)}</div>`;
    }

    function renderBrandsView() {
        const grid = $('#brands-grid');
        const empty = $('#brands-empty');
        const showTrack = !!state.user;   // Tracking wirkt nur mit Konto
        grid.innerHTML = state.brands.map((b, i) => {
            const tracked = b.tracked !== false;
            const trackRow = showTrack ? `
                <label class="track-switch ${tracked ? 'on' : ''}" title="Im Radar täglich das Ranking dieser Brand messen">
                    <input type="checkbox" data-action="toggle-track" data-brand-id="${esc(b.id)}" ${tracked ? 'checked' : ''}>
                    <span class="track-dot"></span>
                    <span class="track-text"><i class="fa-solid fa-chart-line"></i> Tracking</span>
                </label>` : '<span></span>';
            return `
            <div class="brand-card" style="animation-delay:${Math.min(i, 12) * 0.05}s">
                <button class="brand-remove-x" data-action="remove-brand" data-brand-id="${esc(b.id)}" title="Aus Watchlist entfernen"><i class="fa-solid fa-xmark"></i></button>
                <div class="brand-card-top">
                    ${brandAvatarHtml(b.id, b.name)}
                    <div class="brand-card-info">
                        <h3 title="${esc(b.name)}">${esc(b.name)}</h3>
                        <span class="brand-meta"><i class="fa-brands fa-facebook"></i> ${esc(b.id)}</span>
                    </div>
                </div>
                <div class="brand-card-foot">
                    ${trackRow}
                    <button class="btn btn-primary btn-sm" data-action="view-ads" data-brand-id="${esc(b.id)}">Ads ansehen <i class="fa-solid fa-arrow-right"></i></button>
                </div>
            </div>`;
        }).join('');
        empty.innerHTML = state.brands.length ? '' : `
            <div class="state-icon"><i class="fa-regular fa-star"></i></div>
            <h3>Noch keine Brands gespeichert</h3>
            <p>Klicke bei einer Ad auf den Stern, um die Brand zu deiner Watchlist hinzuzufügen.</p>`;
    }

    function setActiveBrand(brand) {
        state.activeBrand = brand;
        const pill = $('#active-brand');
        pill.hidden = !brand;
        if (brand) $('#active-brand-name').textContent = brand.name;
        renderBrandChips();
    }

    /* ========================================================
       SAVED ADS & ORDNER (Swipe File)
       ======================================================== */
    function updateSaveButton(adId) {
        // Karten können in Ergebnissen, Radar-Creatives etc. vorkommen — alle aktualisieren.
        const saved = isAdSaved(adId);
        document.querySelectorAll(`.ad-card[data-ad-id="${CSS.escape(adId)}"] [data-action="save-ad"]`).forEach(btn => {
            if (btn.closest('#saved-grid')) return; // Swipe-File-Karten haben „Entfernen"
            btn.classList.toggle('btn-saved', saved);
            btn.innerHTML = `<i class="${saved ? 'fa-solid' : 'fa-regular'} fa-bookmark"></i>${saved ? 'Gespeichert' : 'Ad speichern'}`;
        });
        // Drawer offen für genau diese Ad? Speichern-Button dort ebenfalls aktualisieren.
        if (drawerAdId === adId) {
            const ad = findAd(adId);
            if (ad) $('#drawer-body').innerHTML = drawerHtml(ad);
        }
    }

    /* ========================================================
       ORDNERSTRUKTUR — flache Liste [{id, name, parentId}], Baum
       wird beim Rendern aus parentId aufgebaut (kein Sync-Risiko
       durch doppelt gepflegte children-Arrays). Bestehende flache
       Ordner ohne parentId gelten automatisch als Root-Ebene.
       ======================================================== */
    function folderById(id) { return state.folders.find(f => f.id === id) || null; }
    function folderName(folderId) {
        const f = folderById(folderId);
        return f ? f.name : null;
    }
    function folderChildren(parentId) {
        return state.folders.filter(f => (f.parentId || null) === (parentId || null));
    }
    function folderDescendantIds(folderId) {
        const out = [];
        const walk = (pid) => folderChildren(pid).forEach(f => { out.push(f.id); walk(f.id); });
        walk(folderId);
        return out;
    }
    function folderPath(folderId) {
        const path = [];
        let cur = folderById(folderId);
        while (cur) { path.unshift(cur); cur = cur.parentId ? folderById(cur.parentId) : null; }
        return path;
    }
    // Anzahl Ads direkt in diesem Ordner (recursive=true zählt auch alle Unterordner mit)
    function folderAdCount(folderId, recursive) {
        const ids = recursive ? [folderId, ...folderDescendantIds(folderId)] : [folderId];
        return state.savedAds.filter(a => ids.includes(a.folder)).length;
    }
    function makeFolderId() { return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

    function doSaveAd(ad, folderId) {
        // Creative (Bilder/Video) mit der Ad speichern, damit es dauerhaft &
        // geräteübergreifend erhalten bleibt (der Medien-Cache läuft nach 24h ab).
        const media = ad._media || getCachedMedia(ad.id);
        const saved = { ...ad, folder: folderId || null, _savedAt: Date.now() };
        if (media) saved._media = media;
        state.savedAds.unshift(saved);
        store.set('savedAds', state.savedAds);
        renderCounts();
        renderSavedView();
        updateSaveButton(ad.id);
        const fname = folderName(folderId);
        toast(`<i class="fa-solid fa-bookmark"></i> ${fname ? `In „${esc(fname)}" gespeichert` : 'Ad gespeichert'}`);
    }

    function removeSavedAd(adId) {
        state.savedAds = state.savedAds.filter(a => a.id !== adId);
        store.set('savedAds', state.savedAds);
        renderCounts();
        renderSavedView();
        updateSaveButton(adId);
        toast('<i class="fa-regular fa-bookmark"></i> Ad entfernt');
    }

    function toggleSavedAd(ad) {
        if (isAdSaved(ad.id)) {
            removeSavedAd(ad.id);
        } else if (state.folders.length) {
            openFolderModal('save', ad);
        } else {
            doSaveAd(ad, null);
        }
    }

    /* ---------- Ordner-Auswahl-Modal (Save/Move-Picker, verschachtelter Baum) ---------- */
    const folderModal = { mode: 'save', ad: null };
    let modalCreateParent = null;   // Ziel-Elternordner für die Erstellung im Modal

    function openFolderModal(mode, ad) {
        folderModal.mode = mode;
        folderModal.ad = ad || null;
        modalCreateParent = null;
        $('#folder-modal-title').innerHTML = mode === 'move'
            ? 'Verschieben nach<span class="dot">.</span>'
            : 'Speichern in<span class="dot">.</span>';
        renderFolderList();
        $('#folder-new-name').value = '';
        $('#folder-new-name').placeholder = 'Neuer Ordner …';
        $('#folder-modal').hidden = false;
    }
    function closeFolderModal() { $('#folder-modal').hidden = true; folderModal.ad = null; }

    function folderModalRow(f, depth, currentFolder) {
        const indent = 14 + depth * 18;
        let html = `<button class="folder-item ${currentFolder === f.id ? 'current' : ''}" data-folder-id="${esc(f.id)}" style="padding-left:${indent}px">
            <i class="fa-regular fa-folder"></i> ${esc(f.name)} <span class="folder-count">${folderAdCount(f.id, false)}</span>
            <span class="folder-item-add" data-folder-add="${esc(f.id)}" title="Unterordner hier anlegen"><i class="fa-solid fa-plus"></i></span>
        </button>`;
        folderChildren(f.id).forEach(c => { html += folderModalRow(c, depth + 1, currentFolder); });
        return html;
    }
    function renderFolderList() {
        const list = $('#folder-list');
        const currentFolder = folderModal.mode === 'move' && folderModal.ad ? (folderModal.ad.folder || null) : undefined;
        const rows = [`<button class="folder-item ${currentFolder === null ? 'current' : ''}" data-folder-id="">
            <i class="fa-regular fa-bookmark"></i> Ohne Ordner</button>`];
        folderChildren(null).forEach(f => rows.push(folderModalRow(f, 0, currentFolder)));
        list.innerHTML = rows.join('') || '<p class="modal-hint">Noch keine Ordner — leg unten deinen ersten an.</p>';
    }

    function chooseFolder(folderId) {
        const id = folderId || null;
        if (folderModal.mode === 'save' && folderModal.ad) {
            doSaveAd(folderModal.ad, id);
        } else if (folderModal.mode === 'move' && folderModal.ad) {
            const saved = state.savedAds.find(a => a.id === folderModal.ad.id);
            if (saved) {
                saved.folder = id;
                store.set('savedAds', state.savedAds);
                renderSavedView();
                const fname = folderName(id);
                toast(`<i class="fa-regular fa-folder-open"></i> ${fname ? `Nach „${esc(fname)}" verschoben` : 'Aus Ordner entfernt'}`);
            }
        }
        closeFolderModal();
    }

    function createFolder(parentId) {
        const input = $('#folder-new-name');
        const name = input.value.trim();
        if (!name) return;
        const folder = { id: makeFolderId(), name: name.slice(0, 40), parentId: parentId || null };
        state.folders.push(folder);
        store.set('folders', state.folders);
        input.value = '';
        modalCreateParent = null;
        input.placeholder = 'Neuer Ordner …';
        toast(`<i class="fa-solid fa-folder-plus"></i> Ordner „${esc(name)}" angelegt`);
        // Direkt verwenden: beim Speichern/Verschieben sofort auswählen
        if (folderModal.mode === 'save' || folderModal.mode === 'move') {
            chooseFolder(folder.id);
        } else {
            renderFolderList();
            renderSavedView();
        }
    }

    // Löscht einen Ordner inkl. aller Unterordner (rekursiv). Ads bleiben erhalten
    // und werden „ohne Ordner" (folder = null). Bei nicht-leeren Ordnern: Rückfrage.
    function deleteFolderRecursive(folderId) {
        const f = folderById(folderId);
        if (!f) return;
        const ids = [folderId, ...folderDescendantIds(folderId)];
        const hasContent = ids.length > 1 || state.savedAds.some(a => ids.includes(a.folder));
        if (hasContent) {
            const msg = `„${f.name}" wirklich löschen? ${ids.length > 1 ? 'Enthaltene Unterordner werden mitgelöscht. ' : ''}Ads bleiben erhalten (werden „ohne Ordner").`;
            if (!confirm(msg)) return;
        }
        state.folders = state.folders.filter(x => !ids.includes(x.id));
        state.savedAds.forEach(a => { if (ids.includes(a.folder)) a.folder = null; });
        store.set('folders', state.folders);
        store.set('savedAds', state.savedAds);
        if (ids.includes(state.savedFolder)) state.savedFolder = f.parentId || null;
        renderSavedView();
        toast(`<i class="fa-regular fa-trash-can"></i> Ordner „${esc(f.name)}" gelöscht — Ads bleiben erhalten`);
    }

    function renameFolder(folderId, name) {
        const f = folderById(folderId);
        if (!f) return;
        const trimmed = (name || '').trim();
        if (trimmed) f.name = trimmed.slice(0, 40);
        store.set('folders', state.folders);
        renderSavedView();
    }

    function moveAdToFolder(adId, folderId) {
        const ad = state.savedAds.find(a => a.id === adId);
        if (!ad) return;
        ad.folder = folderId || null;
        store.set('savedAds', state.savedAds);
        renderSavedView();
        const fname = folderId ? folderName(folderId) : null;
        toast(`<i class="fa-regular fa-folder-open"></i> ${fname ? `Nach „${esc(fname)}" verschoben` : 'Aus Ordner entfernt'}`);
    }

    /* ---------- Rechtsklick-Kontextmenü (Ordner-Baum) ---------- */
    let ctxMenuFolderId = null;
    function openFolderContextMenu(x, y, folderId) {
        closeFolderContextMenu();
        ctxMenuFolderId = folderId;
        const menu = document.createElement('div');
        menu.className = 'folder-ctx-menu';
        menu.id = 'folder-ctx-menu';
        menu.innerHTML = `
            <button data-ctx="rename"><i class="fa-solid fa-pen"></i> Umbenennen</button>
            <button data-ctx="subfolder"><i class="fa-solid fa-folder-plus"></i> Unterordner erstellen</button>
            <button data-ctx="delete" class="ctx-danger"><i class="fa-solid fa-trash-can"></i> Löschen</button>`;
        document.body.appendChild(menu);
        const vw = window.innerWidth, vh = window.innerHeight;
        requestAnimationFrame(() => {
            const rect = menu.getBoundingClientRect();
            menu.style.left = Math.max(4, Math.min(x, vw - rect.width - 8)) + 'px';
            menu.style.top = Math.max(4, Math.min(y, vh - rect.height - 8)) + 'px';
        });
    }
    function closeFolderContextMenu() {
        const el = $('#folder-ctx-menu');
        if (el) el.remove();
        ctxMenuFolderId = null;
    }

    /* ---------- Inline Umbenennen / Unterordner anlegen im Sidebar-Baum ---------- */
    function startFolderRename(folderId) {
        const item = document.querySelector(`.folder-tree-item[data-folder-id="${CSS.escape(folderId)}"]`);
        const f = folderById(folderId);
        if (!item || !f) return;
        const nameEl = item.querySelector('.ft-name');
        if (!nameEl) return;
        const input = document.createElement('input');
        input.className = 'ft-rename-input';
        input.value = f.name;
        input.maxLength = 40;
        nameEl.replaceWith(input);
        input.focus(); input.select();
        let done = false;
        const commit = () => { if (done) return; done = true; renameFolder(folderId, input.value); };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') input.blur();
            if (e.key === 'Escape') { done = true; renderSavedView(); }
        });
        input.addEventListener('blur', commit);
    }

    let treeCreateParent;   // undefined = nicht aktiv, null = Root, sonst Ordner-ID
    function startFolderCreateInline(parentId) {
        treeCreateParent = parentId;
        if (parentId) folderExpanded.add(parentId);
        renderFolderTree();
    }
    function commitTreeCreate(parentId, value) {
        const name = (value || '').trim();
        treeCreateParent = undefined;
        if (!name) { renderFolderTree(); return; }
        const folder = { id: makeFolderId(), name: name.slice(0, 40), parentId: parentId || null };
        state.folders.push(folder);
        store.set('folders', state.folders);
        renderSavedView();
        toast(`<i class="fa-solid fa-folder-plus"></i> Ordner „${esc(folder.name)}" angelegt`);
    }

    /* ---------- Swipe-File-Ansicht: Sidebar-Baum + Breadcrumb + Grid ---------- */
    const folderExpanded = new Set();   // aufgeklappte Ordner (nur UI-Zustand, nicht persistiert)

    function selectSavedFolder(folderId) {
        state.savedFolder = folderId || null;
        if (folderId) folderPath(folderId).forEach(f => folderExpanded.add(f.id));
        renderSavedView();
    }
    function toggleFolderExpanded(folderId) {
        if (folderExpanded.has(folderId)) folderExpanded.delete(folderId); else folderExpanded.add(folderId);
        renderFolderTree();
    }

    function renderFolderTreeNode(folder, depth) {
        const children = folderChildren(folder.id);
        const hasChildren = children.length > 0;
        const expanded = folderExpanded.has(folder.id);
        const count = folderAdCount(folder.id, true);
        const active = state.savedFolder === folder.id;
        let html = `<div class="folder-tree-item ${active ? 'active' : ''}" data-folder-id="${esc(folder.id)}" style="--depth:${depth}">
            <button class="ft-toggle ${hasChildren ? '' : 'ft-toggle-empty'}" data-ft-toggle="${esc(folder.id)}" ${hasChildren ? '' : 'tabindex="-1"'}>
                ${hasChildren ? `<i class="fa-solid fa-caret-${expanded ? 'down' : 'right'}"></i>` : ''}
            </button>
            <i class="fa-solid fa-folder ft-icon"></i>
            <span class="ft-name" data-ft-open="${esc(folder.id)}">${esc(folder.name)}</span>
            <span class="ft-count">${count}</span>
        </div>`;
        if (hasChildren && expanded) {
            html += `<div class="ft-children">${children.map(c => renderFolderTreeNode(c, depth + 1)).join('')}</div>`;
        }
        if (treeCreateParent === folder.id) {
            html += `<div class="ft-children"><div class="folder-tree-item ft-create-row" style="--depth:${depth + 1}">
                <i class="fa-solid fa-folder ft-icon"></i>
                <input class="ft-create-input" maxlength="40" placeholder="Ordnername …">
            </div></div>`;
        }
        return html;
    }

    function renderFolderTree() {
        const root = $('#saved-folder-tree');
        if (!root) return;
        const allActive = state.savedFolder === null;
        let html = `<div class="folder-tree-item ft-all ${allActive ? 'active' : ''}" data-folder-id="">
            <span class="ft-toggle ft-toggle-empty"></span>
            <i class="fa-solid fa-layer-group ft-icon"></i>
            <span class="ft-name" data-ft-open="">Alle Ads</span>
            <span class="ft-count">${state.savedAds.length}</span>
        </div>`;
        html += folderChildren(null).map(f => renderFolderTreeNode(f, 0)).join('');
        if (treeCreateParent === null) {
            html += `<div class="folder-tree-item ft-create-row" style="--depth:0">
                <i class="fa-solid fa-folder ft-icon"></i>
                <input class="ft-create-input" maxlength="40" placeholder="Ordnername …">
            </div>`;
        }
        root.innerHTML = html;
        const input = root.querySelector('.ft-create-input');
        if (input) {
            input.focus();
            let done = false;
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') input.blur();
                if (e.key === 'Escape') { done = true; treeCreateParent = undefined; renderFolderTree(); }
            });
            input.addEventListener('blur', () => { if (!done) commitTreeCreate(treeCreateParent, input.value); });
        }
    }

    function renderSavedBreadcrumb() {
        const el = $('#saved-breadcrumb');
        if (!el) return;
        if (state.savedFolder === null) { el.hidden = true; el.innerHTML = ''; return; }
        const path = folderPath(state.savedFolder);
        const crumbs = [`<button class="crumb" data-crumb="">Alle Ads</button>`];
        path.forEach((f, i) => {
            crumbs.push('<span class="crumb-sep"><i class="fa-solid fa-chevron-right"></i></span>');
            crumbs.push(i === path.length - 1
                ? `<span class="crumb current">${esc(f.name)}</span>`
                : `<button class="crumb" data-crumb="${esc(f.id)}">${esc(f.name)}</button>`);
        });
        el.hidden = false;
        el.innerHTML = crumbs.join('');
    }

    function renderSavedSubfolders() {
        const wrap = $('#saved-subfolder-tiles');
        if (!wrap) return;
        const children = state.savedFolder === null ? [] : folderChildren(state.savedFolder);
        if (!children.length) { wrap.hidden = true; wrap.innerHTML = ''; return; }
        wrap.hidden = false;
        wrap.innerHTML = children.map(f => `
            <button class="folder-tile" data-folder-id="${esc(f.id)}">
                <i class="fa-solid fa-folder"></i>
                <span>${esc(f.name)}</span>
                <span class="folder-tile-count">${folderAdCount(f.id, true)}</span>
            </button>`).join('');
    }

    function renderSavedView() {
        renderFolderTree();
        renderSavedBreadcrumb();
        renderSavedSubfolders();

        const grid = $('#saved-grid');
        const empty = $('#saved-empty');
        const ads = state.savedFolder === null
            ? state.savedAds
            : state.savedAds.filter(a => a.folder === state.savedFolder);
        // Mitgespeichertes Creative wieder in den Cache legen (überlebt so TTL & Gerätewechsel)
        ads.forEach(a => { if (a._media && !getCachedMedia(a.id)) setCachedMedia(a.id, a._media); });
        grid.innerHTML = ads.map((ad, i) => adCardHtml(ad, i, { savedView: true })).join('');
        scanFrames(grid);

        const hasSubfolders = state.savedFolder !== null && folderChildren(state.savedFolder).length > 0;
        if (state.savedAds.length === 0) {
            empty.innerHTML = `
                <div class="state-icon"><i class="fa-regular fa-bookmark"></i></div>
                <h3>Dein Swipe File ist leer</h3>
                <p>Speichere starke Ads mit dem Bookmark-Button — sie landen hier als Inspiration für deine nächsten Creatives.</p>`;
        } else if (ads.length === 0 && !hasSubfolders) {
            empty.innerHTML = `
                <div class="state-icon"><i class="fa-regular fa-folder-open"></i></div>
                <h3>Dieser Ordner ist leer</h3>
                <p>Ziehe Ads per Drag &amp; Drop hierher, oder wähle den Ordner über das Ordner-Symbol an der Karte.</p>`;
        } else {
            empty.innerHTML = '';
        }
    }

    function renderCounts() {
        $('#count-brands').textContent = state.brands.length;
        $('#count-saved').textContent = state.savedAds.length;
    }

    /* ========================================================
       VIEWS & UI-CHROME
       ======================================================== */
    const VIEW_ORDER = ['discover', 'brands', 'radar', 'voc', 'saved'];
    function switchView(view) {
        const prevIdx = VIEW_ORDER.indexOf(state.view);
        const newIdx = VIEW_ORDER.indexOf(view);
        state.view = view;
        document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== 'view-' + view; });
        document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
        closeNavMenu();
        // Slide-Animation in Swipe-Richtung
        const el = document.getElementById('view-' + view);
        if (el && prevIdx !== -1 && newIdx !== -1 && prevIdx !== newIdx) {
            el.classList.remove('view-enter-left', 'view-enter-right');
            void el.offsetWidth;
            el.classList.add(newIdx > prevIdx ? 'view-enter-right' : 'view-enter-left');
        }
        if (view === 'brands') renderBrandsView();
        if (view === 'saved') renderSavedView();
        if (view === 'radar') renderRadarView();
        if (view === 'voc') renderVocView();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    let toastTimer;
    function toast(html) {
        const el = $('#toast');
        el.innerHTML = html;
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
    }

    function setForceDemo(on) {
        state.forceDemo = on;
        store.set('forceDemo', on);
        updateDemoBanner();
        runSearch();
    }

    function updateDemoBanner() {
        const banner = $('#demo-banner');
        if (state.forceDemo) {
            banner.hidden = false;
            banner.querySelector('span').innerHTML =
                '<strong>Demo-Modus.</strong> Metas Freischaltung steht noch aus — du stöberst in Beispiel-Ads.';
            banner.querySelector('button').textContent = 'Echte API testen →';
        } else {
            banner.hidden = true;
        }
    }

    /* ========================================================
       SETTINGS
       ======================================================== */
    async function saveScKey() {
        const key = $('#sc-key-input').value.trim();
        const status = $('#sc-key-status');
        if (!key) {
            status.textContent = 'Bitte einen Key eingeben.';
            status.className = 'token-status err';
            return;
        }
        status.textContent = 'Teste Key … (verbraucht 1 Credit)';
        status.className = 'token-status';
        try {
            const res = await fetch(`${SC_API}/search/ads?query=nike&country=US&trim=true`, {
                headers: { 'x-api-key': key }
            });
            if (res.status === 401) throw new Error('Key ungültig.');
            if (!res.ok) throw new Error(`ScrapeCreators antwortet mit Status ${res.status}.`);
            state.scKey = key;
            store.set('scKey', key);
            status.textContent = '✓ Key funktioniert. Globale Suche ist freigeschaltet!';
            status.className = 'token-status ok';
        } catch (err) {
            status.textContent = 'Fehler: ' + err.message;
            status.className = 'token-status err';
        }
    }

    /* ========================================================
       EXPLAINER — 55s Motion-Walkthrough (Stories-Mechanik)
       ======================================================== */
    const explainer = (() => {
        const DURATIONS = [5000, 9500, 10000, 8000, 10000, 6000, 6500]; // = 55s
        const TYPE_TEXT = 'skincare';
        let idx = 0, timer = null, sceneStart = 0, remaining = 0, paused = false, open = false;
        let typeTimer = null;

        const root = () => $('#explainer');

        function buildProgress() {
            $('#x-progress').innerHTML = DURATIONS.map(() =>
                '<span class="x-seg"><span class="x-seg-fill"></span></span>').join('');
        }

        function setProgress() {
            document.querySelectorAll('.x-seg').forEach((seg, i) => {
                seg.classList.toggle('done', i < idx);
                seg.classList.toggle('running', i === idx);
                if (i === idx) seg.querySelector('.x-seg-fill').style.setProperty('--dur', DURATIONS[i] + 'ms');
            });
        }

        function typewrite() {
            clearInterval(typeTimer);
            const el = $('#x-typewriter');
            el.textContent = '';
            let i = 0;
            // startet nach dem Reveal der Suchleiste
            setTimeout(() => {
                typeTimer = setInterval(() => {
                    if (paused) return;
                    el.textContent = TYPE_TEXT.slice(0, ++i);
                    if (i >= TYPE_TEXT.length) clearInterval(typeTimer);
                }, 90);
            }, 700);
        }

        function showScene(i, { instant = false } = {}) {
            idx = Math.max(0, Math.min(i, DURATIONS.length - 1));
            clearTimeout(timer);
            document.querySelectorAll('.x-scene').forEach(s => {
                s.classList.remove('leaving');
                s.classList.toggle('active', Number(s.dataset.scene) === idx);
            });
            // Reveal-Animationen neu starten
            const active = document.querySelector(`.x-scene[data-scene="${idx}"]`);
            active.querySelectorAll('.x-in').forEach(el => {
                el.style.animation = 'none';
                void el.offsetWidth; // Reflow erzwingt Neustart
                el.style.animation = '';
            });
            if (idx === 1) typewrite();
            setProgress();
            sceneStart = Date.now();
            remaining = DURATIONS[idx];
            if (!paused) schedule(remaining);
            void instant;
        }

        function schedule(ms) {
            clearTimeout(timer);
            timer = setTimeout(() => {
                if (idx < DURATIONS.length - 1) {
                    const active = document.querySelector(`.x-scene[data-scene="${idx}"]`);
                    active.classList.add('leaving');
                    setTimeout(() => showScene(idx + 1), 380);
                } else {
                    // Ende: auf letzter Szene stehen bleiben
                    pauseAt(true);
                }
            }, ms);
        }

        function pauseAt(silent) {
            paused = true;
            clearTimeout(timer);
            remaining = Math.max(0, remaining - (Date.now() - sceneStart));
            root().classList.add('paused');
            $('#x-pause').innerHTML = '<i class="fa-solid fa-play"></i>';
            void silent;
        }

        function resume() {
            paused = false;
            root().classList.remove('paused');
            $('#x-pause').innerHTML = '<i class="fa-solid fa-pause"></i>';
            sceneStart = Date.now();
            schedule(remaining);
        }

        function start() {
            open = true;
            paused = false;
            root().hidden = false;
            root().classList.remove('paused');
            $('#x-pause').innerHTML = '<i class="fa-solid fa-pause"></i>';
            document.body.style.overflow = 'hidden';
            buildProgress();
            showScene(0);
        }

        function close() {
            open = false;
            clearTimeout(timer);
            clearInterval(typeTimer);
            root().hidden = true;
            document.body.style.overflow = '';
        }

        function bind() {
            $('#btn-explainer').addEventListener('click', start);
            $('#x-close').addEventListener('click', close);
            $('#x-pause').addEventListener('click', () => paused ? resume() : pauseAt());
            $('#x-next').addEventListener('click', () => {
                if (idx < DURATIONS.length - 1) { if (paused) resume(); showScene(idx + 1); }
                else close();
            });
            $('#x-prev').addEventListener('click', () => { if (paused) resume(); showScene(idx - 1); });
            $('#x-cta').addEventListener('click', () => { close(); openOnboarding(); });
            document.addEventListener('keydown', (e) => {
                if (!open) return;
                if (e.key === 'Escape') close();
                if (e.key === 'ArrowRight') { if (paused) resume(); showScene(idx + 1); }
                if (e.key === 'ArrowLeft') { if (paused) resume(); showScene(idx - 1); }
                if (e.key === ' ') { e.preventDefault(); paused ? resume() : pauseAt(); }
            });
        }

        return { bind, start, close, showScene, get isOpen() { return open; } };
    })();

    /* ---------- Onboarding ---------- */
    function openOnboarding() { $('#onboard-modal').hidden = false; }
    function closeOnboarding() {
        $('#onboard-modal').hidden = true;
        store.set('onboarded', true);
    }

    function openSettings() {
        $('#winner-days').value = state.winnerDays;
        $('#winner-reach').value = state.winnerReach;
        $('#radar-freq').value = String(state.radarFreqDays || 0);
        $('#sc-key-input').value = state.scKey;
        $('#sc-key-status').textContent = '';
        $('#sc-key-status').className = 'token-status';
        $('#token-input').value = state.token;
        $('#token-status').textContent = '';
        $('#token-status').className = 'token-status';
        $('#settings-modal').hidden = false;
    }
    function closeSettings() { $('#settings-modal').hidden = true; }

    async function saveToken() {
        const token = $('#token-input').value.trim();
        const status = $('#token-status');
        if (!token) {
            status.textContent = 'Bitte einen Token eingeben.';
            status.className = 'token-status err';
            return;
        }
        status.textContent = 'Teste Token …';
        status.className = 'token-status';
        try {
            const url = `${API_BASE}?access_token=${encodeURIComponent(token)}&ad_type=ALL&ad_reached_countries=${encodeURIComponent('["DE"]')}&search_terms=test&limit=1&fields=id`;
            const res = await fetch(url);
            const json = await res.json();
            if (json.error && json.error.code === 10) {
                // Token gültig, aber Ad-Library-Freischaltung von Meta steht noch aus
                state.token = token;
                store.set('token', token);
                updateDemoBanner();
                status.textContent = 'Token gespeichert — aber Meta hat den Ad-Library-Zugriff noch nicht freigeschaltet. Schritte unter facebook.com/ads/library/api abschließen (dauert meist 1–2 Tage).';
                status.className = 'token-status err';
                return;
            }
            if (json.error) throw new Error(json.error.error_user_msg || json.error.message);
            state.token = token;
            store.set('token', token);
            state.forceDemo = false;
            store.set('forceDemo', false);
            status.textContent = '✓ Token funktioniert. Viel Spaß beim Stöbern!';
            status.className = 'token-status ok';
            updateDemoBanner();
            setTimeout(() => { closeSettings(); runSearch(); }, 900);
        } catch (err) {
            status.textContent = 'Fehler: ' + err.message;
            status.className = 'token-status err';
        }
    }

    /* ========================================================
       EVENTS
       ======================================================== */
    function closeNavMenu() {
        const el = $('#nav-right-items');
        if (el) el.classList.remove('open');
    }

    // Swipe zwischen den Ansichten (mobil), wie in der Vitruv-App
    function bindSwipeNav() {
        let sx = 0, sy = 0, active = false, locked = null;
        const anyOverlayOpen = () =>
            ['#lightbox', '#settings-modal', '#auth-modal', '#copy-modal', '#folder-modal', '#onboard-modal', '#explainer', '#ad-drawer']
                .some(id => { const e = $(id); return e && !e.hidden; });

        document.addEventListener('touchstart', (e) => {
            active = false;
            if (e.touches.length !== 1 || anyOverlayOpen()) return;
            const t = e.target;
            if (t.closest && t.closest('input, select, textarea, video, .radar-table, .nav-tabs, .nav-right, [data-no-swipe]')) return;
            sx = e.touches[0].clientX; sy = e.touches[0].clientY; active = true; locked = null;
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            if (!active || locked) return;
            const dx = Math.abs(e.touches[0].clientX - sx), dy = Math.abs(e.touches[0].clientY - sy);
            if (dx < 8 && dy < 8) return;
            locked = dx > dy * 1.3 ? 'h' : 'v';
        }, { passive: true });

        document.addEventListener('touchend', (e) => {
            if (!active) return; active = false;
            if (locked !== 'h') return;
            const dx = (e.changedTouches[0] ? e.changedTouches[0].clientX : sx) - sx;
            if (Math.abs(dx) < 55) return;
            const idx = VIEW_ORDER.indexOf(state.view);
            if (idx === -1) return;
            if (dx < 0 && idx < VIEW_ORDER.length - 1) switchView(VIEW_ORDER[idx + 1]);
            else if (dx > 0 && idx > 0) switchView(VIEW_ORDER[idx - 1]);
        }, { passive: true });
    }

    // Mobil ist der Detail-Drawer ein Bottom-Sheet — nach unten wischen schließt ihn
    // (nur auf dem Griff/Header, damit vertikales Scrollen im Inhalt nicht gestört wird).
    function bindDrawerSwipe() {
        const drawer = $('#ad-drawer');
        let sy = 0, dy = 0, dragging = false;

        drawer.addEventListener('touchstart', (e) => {
            if (window.innerWidth > 640) return;
            if (drawer.querySelector('.drawer-scroll').scrollTop > 4) return;
            sy = e.touches[0].clientY; dy = 0; dragging = true;
        }, { passive: true });

        drawer.addEventListener('touchmove', (e) => {
            if (!dragging) return;
            dy = e.touches[0].clientY - sy;
            if (dy > 0) drawer.style.transform = `translateY(${dy}px)`;
        }, { passive: true });

        drawer.addEventListener('touchend', () => {
            if (!dragging) return;
            dragging = false;
            drawer.style.transform = '';
            if (dy > 90) closeDrawer();
            dy = 0;
        }, { passive: true });
    }

    function bindEvents() {
        // Nav
        document.querySelectorAll('.nav-tab').forEach(tab =>
            tab.addEventListener('click', () => switchView(tab.dataset.view)));
        $('#logo-home').addEventListener('click', (e) => { e.preventDefault(); switchView('discover'); });

        // Mobile-Menü (Top-Right-Controls einklappen)
        $('#nav-menu-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            $('#nav-right-items').classList.toggle('open');
        });
        $('#nav-right-items').addEventListener('click', (e) => { if (e.target.closest('button')) closeNavMenu(); });
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.nav-right')) closeNavMenu();
        });

        // Mobile: Filterleiste ein-/ausklappen
        const filterToggleBtn = $('#filter-toggle-btn');
        if (filterToggleBtn) {
            filterToggleBtn.addEventListener('click', () => {
                const open = $('#filters').classList.toggle('open');
                filterToggleBtn.setAttribute('aria-expanded', String(open));
            });
        }

        // Mobile: Ordner-Sidebar im Swipe File ein-/ausklappen (Accordion)
        const sidebarToggleBtn = $('#saved-sidebar-toggle');
        if (sidebarToggleBtn) {
            sidebarToggleBtn.addEventListener('click', () => {
                const sidebar = $('#saved-sidebar');
                const collapsed = sidebar.classList.toggle('collapsed');
                sidebarToggleBtn.setAttribute('aria-expanded', String(!collapsed));
            });
        }

        bindSwipeNav();

        // Suche
        $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
        ['f-status', 'f-media', 'f-platform', 'f-lang', 'f-searchtype', 'f-datemin', 'f-datemax']
            .forEach(id => $('#' + id).addEventListener('change', () => runSearch()));
        // Sortierung & Winner-Filter: nur neu rendern, kein neuer API-Call nötig
        $('#f-sort').addEventListener('change', () => { renderResults(); renderResultsMeta(); });
        $('#f-winner').addEventListener('change', () => { renderResults(); renderResultsMeta(); });

        // Format-Filter-Chips (Parker-Style) — clientseitig, kein API-Call
        $('#format-chips').addEventListener('click', (e) => {
            const chip = e.target.closest('.fchip');
            if (!chip) return;
            state.formatFilter = chip.dataset.formatFilter || null;
            renderResults(); renderResultsMeta();
        });
        $('#f-reset').addEventListener('click', () => {
            $('#f-status').value = 'ACTIVE';
            $('#f-media').value = 'ALL';
            $('#f-platform').value = '';
            $('#f-lang').value = '';
            $('#f-searchtype').value = 'KEYWORD_UNORDERED';
            $('#f-datemin').value = '';
            $('#f-datemax').value = '';
            $('#f-sort').value = '';
            $('#f-winner').checked = false;
            state.formatFilter = null;
            runSearch();
        });

        // Land (EU = offizielle API, Global = ScrapeCreators)
        const countrySel = $('#country-select');
        const addGroup = (label, countries) => {
            const group = document.createElement('optgroup');
            group.label = label;
            countries.forEach(([code, name]) => {
                const opt = document.createElement('option');
                opt.value = code; opt.textContent = name;
                group.appendChild(opt);
            });
            countrySel.appendChild(group);
        };
        addGroup('EU (Meta-API, kostenlos)', EU_COUNTRIES);
        addGroup('Global (ScrapeCreators, Key nötig)', GLOBAL_COUNTRIES);
        countrySel.value = state.country;
        if (!countrySel.value) { state.country = 'DE'; countrySel.value = 'DE'; }
        countrySel.addEventListener('change', () => {
            state.country = countrySel.value;
            store.set('country', state.country);
            closeNavMenu();
            runSearch();
        });

        // Mehr laden
        $('#btn-loadmore').addEventListener('click', () => runSearch({ append: true }));

        // Brand-Filter-Pill
        $('#active-brand-clear').addEventListener('click', () => { setActiveBrand(null); runSearch(); });

        // Brand chips (delegiert)
        $('#brand-chips').addEventListener('click', (e) => {
            const chip = e.target.closest('.chip');
            if (!chip) return;
            const brand = state.brands.find(b => b.id === chip.dataset.brandId);
            if (state.activeBrand && state.activeBrand.id === brand.id) {
                setActiveBrand(null);
            } else {
                setActiveBrand(brand);
                $('#search-input').value = '';
            }
            runSearch();
        });

        // Karten-Aktionen (delegiert über beide Grids)
        document.body.addEventListener('click', (e) => {
            const actionEl = e.target.closest('[data-action]');
            if (actionEl) {
                const action = actionEl.dataset.action;

                if (action === 'open-settings') { closeOnboarding(); openSettings(); return; }
                if (action === 'open-auth') { openAuth(); return; }
                if (action === 'use-demo') { setForceDemo(true); return; }
                if (action === 'companion-help') { openOnboarding(); return; }

                if (action === 'toggle-track') { toggleBrandTracked(actionEl.dataset.brandId); return; }

                if (action === 'view-ads' || action === 'remove-brand') {
                    const brand = state.brands.find(b => b.id === actionEl.dataset.brandId);
                    if (!brand) return;
                    if (action === 'view-ads') {
                        setActiveBrand(brand);
                        $('#search-input').value = '';
                        switchView('discover');
                        runSearch();
                    } else {
                        toggleBrand(brand.id, brand.name);
                    }
                    return;
                }

                const card = actionEl.closest('.ad-card');
                if (!card) return;
                const adId = card.dataset.adId;
                const ad = findAd(adId);   // schließt Radar-Creatives mit ein
                if (!ad) return;

                if (action === 'save-brand') toggleBrand(ad.page_id, ad.page_name);
                if (action === 'save-ad') toggleSavedAd(ad);
                if (action === 'expand-creative') { e.preventDefault(); openLightbox(ad); return; }
                if (action === 'view-copy') openCopyModal(ad);
                if (action === 'move-folder') openFolderModal('move', ad);
                if (action === 'download-creative') { downloadAdCreative(ad); return; }
                if (action === 'filter-brand') {
                    if (ad._demo) { toast('<i class="fa-solid fa-circle-info"></i> Im Demo-Modus nicht verfügbar'); return; }
                    setActiveBrand({ id: ad.page_id, name: ad.page_name });
                    $('#search-input').value = '';
                    switchView('discover');
                    runSearch();
                }
                return;
            }

            // Kein data-action getroffen: Klick auf eine Karte (abseits von Buttons/Links)
            // öffnet das Detail-Drawer-Panel.
            if (e.target.closest('a, button')) return;
            const card = e.target.closest('.ad-card');
            if (!card) return;
            const ad = findAd(card.dataset.adId);
            if (ad) openDrawer(ad);
        });

        // Detail-Drawer
        $('#drawer-close').addEventListener('click', closeDrawer);
        $('#drawer-overlay').addEventListener('click', closeDrawer);
        bindDrawerSwipe();
        $('#drawer-body').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-drawer-action]');
            if (!btn || !drawerAdId) return;
            const ad = findAd(drawerAdId);
            if (!ad) return;
            const action = btn.dataset.drawerAction;
            if (action === 'save-ad') {
                toggleSavedAd(ad);
                setTimeout(() => { if (drawerAdId === ad.id) $('#drawer-body').innerHTML = drawerHtml(ad); }, 0);
            }
            if (action === 'copy-link') copyText(ad.ad_snapshot_url || window.location.href);
            if (action === 'download') downloadAdCreative(ad);
        });

        // Ordner-Modal
        $('#folder-close').addEventListener('click', closeFolderModal);
        $('#folder-modal').addEventListener('click', (e) => {
            if (e.target === $('#folder-modal')) closeFolderModal();
        });

        // Ad-Copy-Modal
        $('#copy-close').addEventListener('click', closeCopyModal);
        $('#copy-modal').addEventListener('click', (e) => { if (e.target === $('#copy-modal')) closeCopyModal(); });
        $('#copy-copy-btn').addEventListener('click', () => { if (copyModalText) copyText(copyModalText); });

        // Creative-Lightbox: Backdrop-Klick & Close schließen (Klick auf Medium/Bar nicht)
        $('#lightbox-close').addEventListener('click', closeLightbox);
        $('#lightbox').addEventListener('click', (e) => {
            // Überall außerhalb von Bild/Video und Aktionsleiste klicken schließt
            const onMedia = e.target.tagName === 'IMG' || e.target.tagName === 'VIDEO';
            if (!onMedia && !e.target.closest('.lightbox-bar') && !e.target.closest('.lightbox-close')) closeLightbox();
        });
        $('#folder-list').addEventListener('click', (e) => {
            const addBtn = e.target.closest('[data-folder-add]');
            if (addBtn) {
                e.stopPropagation();
                modalCreateParent = addBtn.dataset.folderAdd;
                const input = $('#folder-new-name');
                input.placeholder = `Unterordner in „${folderName(modalCreateParent) || '…'}"`;
                input.focus();
                return;
            }
            const item = e.target.closest('.folder-item');
            if (item) chooseFolder(item.dataset.folderId);
        });
        $('#folder-create-btn').addEventListener('click', () => createFolder(modalCreateParent));
        $('#folder-new-name').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); createFolder(modalCreateParent); }
        });

        // ---- Swipe-File: Ordner-Sidebar-Baum ----
        $('#saved-new-root-folder').addEventListener('click', () => startFolderCreateInline(null));

        $('#saved-folder-tree').addEventListener('click', (e) => {
            const toggle = e.target.closest('[data-ft-toggle]');
            if (toggle) { toggleFolderExpanded(toggle.dataset.ftToggle); return; }
            const openEl = e.target.closest('[data-ft-open]');
            if (openEl) { selectSavedFolder(openEl.dataset.ftOpen || null); return; }
        });
        $('#saved-folder-tree').addEventListener('contextmenu', (e) => {
            const item = e.target.closest('.folder-tree-item[data-folder-id]');
            if (!item || !item.dataset.folderId || item.classList.contains('ft-create-row')) return;
            e.preventDefault();
            openFolderContextMenu(e.clientX, e.clientY, item.dataset.folderId);
        });
        document.addEventListener('click', (e) => { if (!e.target.closest('#folder-ctx-menu')) closeFolderContextMenu(); });
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('#folder-ctx-menu [data-ctx]');
            if (!btn || !ctxMenuFolderId) return;
            const fid = ctxMenuFolderId;
            const action = btn.dataset.ctx;
            closeFolderContextMenu();
            if (action === 'rename') startFolderRename(fid);
            if (action === 'subfolder') startFolderCreateInline(fid);
            if (action === 'delete') deleteFolderRecursive(fid);
        });

        $('#saved-breadcrumb').addEventListener('click', (e) => {
            const crumb = e.target.closest('.crumb[data-crumb]');
            if (crumb) selectSavedFolder(crumb.dataset.crumb || null);
        });
        $('#saved-subfolder-tiles').addEventListener('click', (e) => {
            const tile = e.target.closest('.folder-tile');
            if (tile) selectSavedFolder(tile.dataset.folderId);
        });

        // Drag & Drop: gespeicherte Ads in Ordner ziehen (Sidebar-Baum + Unterordner-Kacheln)
        $('#saved-grid').addEventListener('dragstart', (e) => {
            const card = e.target.closest('.ad-card');
            if (!card) return;
            e.dataTransfer.setData('text/mnemos-ad-id', card.dataset.adId);
            e.dataTransfer.effectAllowed = 'move';
            card.classList.add('dragging');
        });
        $('#saved-grid').addEventListener('dragend', (e) => {
            const card = e.target.closest('.ad-card');
            if (card) card.classList.remove('dragging');
        });
        [$('#saved-folder-tree'), $('#saved-subfolder-tiles')].forEach(container => {
            container.addEventListener('dragover', (e) => {
                const target = e.target.closest('.folder-tree-item, .folder-tile');
                if (!target || target.classList.contains('ft-create-row')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                target.classList.add('drag-over');
            });
            container.addEventListener('dragleave', (e) => {
                const target = e.target.closest('.folder-tree-item, .folder-tile');
                if (target) target.classList.remove('drag-over');
            });
            container.addEventListener('drop', (e) => {
                const target = e.target.closest('.folder-tree-item, .folder-tile');
                if (!target) return;
                e.preventDefault();
                target.classList.remove('drag-over');
                const adId = e.dataTransfer.getData('text/mnemos-ad-id');
                if (!adId) return;
                moveAdToFolder(adId, target.dataset.folderId || null);
            });
        });

        // ScrapeCreators-Key
        $('#sc-key-save').addEventListener('click', saveScKey);
        $('#sc-key-clear').addEventListener('click', () => {
            state.scKey = '';
            store.set('scKey', '');
            $('#sc-key-input').value = '';
            $('#sc-key-status').textContent = 'Key gelöscht.';
            $('#sc-key-status').className = 'token-status';
        });
        $('#sc-key-toggle').addEventListener('click', () => {
            const input = $('#sc-key-input');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        // Winner-Kriterien in den Einstellungen
        $('#winner-days').addEventListener('change', () => {
            state.winnerDays = Math.max(1, parseInt($('#winner-days').value, 10) || 60);
            $('#winner-days').value = state.winnerDays;
            store.set('winnerDays', state.winnerDays);
            renderResults(); renderResultsMeta(); renderSavedView();
        });
        $('#winner-reach').addEventListener('change', () => {
            state.winnerReach = Math.max(0, parseInt($('#winner-reach').value, 10) || 0);
            $('#winner-reach').value = state.winnerReach;
            store.set('winnerReach', state.winnerReach);
            renderResults(); renderResultsMeta(); renderSavedView();
        });
        $('#radar-freq').addEventListener('change', () => {
            state.radarFreqDays = parseInt($('#radar-freq').value, 10) || 0;
            store.set('radarFreqDays', state.radarFreqDays);
            toast(state.radarFreqDays
                ? '<i class="fa-solid fa-chart-line"></i> Auto-Tracking aktiviert'
                : '<i class="fa-regular fa-circle"></i> Auto-Tracking auf „nur manuell"');
            if (state.radarFreqDays) snapshotTrackedBrands();
        });

        // Explainer
        explainer.bind();

        // Onboarding
        $('#btn-help').addEventListener('click', openOnboarding);
        $('#onboard-close').addEventListener('click', closeOnboarding);
        $('#onboard-demo').addEventListener('click', closeOnboarding);
        $('#onboard-settings').addEventListener('click', () => { closeOnboarding(); openSettings(); });
        $('#onboard-modal').addEventListener('click', (e) => {
            if (e.target === $('#onboard-modal')) closeOnboarding();
        });

        // Settings
        $('#btn-settings').addEventListener('click', openSettings);
        $('#demo-banner-btn').addEventListener('click', () => {
            if (state.forceDemo) {
                setForceDemo(false); // zurück zu echten Ads
            } else {
                openOnboarding();
            }
        });
        $('#settings-close').addEventListener('click', closeSettings);
        $('#settings-modal').addEventListener('click', (e) => {
            if (e.target === $('#settings-modal')) closeSettings();
        });
        $('#token-save').addEventListener('click', saveToken);
        $('#token-clear').addEventListener('click', () => {
            state.token = '';
            store.set('token', '');
            $('#token-input').value = '';
            $('#token-status').textContent = 'Token gelöscht.';
            $('#token-status').className = 'token-status';
            updateDemoBanner();
        });
        $('#token-toggle').addEventListener('click', () => {
            const input = $('#token-input');
            input.type = input.type === 'password' ? 'text' : 'password';
        });
        // ---- Konto / Auth ----
        $('#btn-account').addEventListener('click', openAuth);
        $('#auth-close').addEventListener('click', closeAuth);
        $('#auth-modal').addEventListener('click', (e) => { if (e.target === $('#auth-modal')) closeAuth(); });
        document.querySelectorAll('.auth-tab').forEach(t =>
            t.addEventListener('click', () => setAuthTab(t.dataset.authTab)));
        $('#auth-submit').addEventListener('click', submitAuth);
        $('#auth-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitAuth(); } });
        $('#auth-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitAuth(); } });
        $('#auth-magic').addEventListener('click', doMagicLink);
        $('#auth-forgot').addEventListener('click', doForgot);
        $('#auth-signout').addEventListener('click', doSignOut);
        $('#auth-pass-toggle').addEventListener('click', () => {
            const input = $('#auth-pass');
            input.type = input.type === 'password' ? 'text' : 'password';
        });
        $('#account-cron').addEventListener('change', (e) => toggleAutoTracking(e.target.checked));

        // ---- Radar ----
        $('#radar-brand-chips').addEventListener('click', (e) => {
            const chip = e.target.closest('.chip[data-radar-brand]');
            if (!chip) return;
            const brand = state.brands.find(b => b.id === chip.dataset.radarBrand);
            if (brand) renderRadarBrand(brand);
        });
        $('#radar-refresh').addEventListener('click', () => {
            if (!state.radarBrand) return;
            if (state.radarMode === 'creatives') { delete radarCreativeCache[state.radarBrand.id]; renderRadarCreatives(); }
            else snapshotBrandNow(state.radarBrand);
        });
        $('#radar-toggle').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-radar-mode]');
            if (!btn || btn.dataset.radarMode === state.radarMode) return;
            state.radarMode = btn.dataset.radarMode;
            if (state.radarBrand) renderRadarMode();
        });
        $('#radar-format-chips').addEventListener('click', (e) => {
            const chip = e.target.closest('.fchip');
            if (!chip) return;
            state.radarFormat = chip.dataset.radarFormat || null;
            renderRadarTable();
        });

        // ---- Voice of Customer ----
        $('#voc-brand-chips').addEventListener('click', (e) => {
            const chip = e.target.closest('.chip[data-voc-brand]');
            if (!chip) return;
            state.vocBrand = chip.dataset.vocBrand || null;
            renderVocView();
        });
        $('#voc-load-comments').addEventListener('click', () => {
            const brand = state.vocBrand && state.brands.find(b => b.id === state.vocBrand);
            if (brand) loadBrandComments(brand);
        });
        $('#voc-copy-all').addEventListener('click', () => {
            const all = state.lastVocQuotes.map(q => q.text).join('\n');
            if (all) copyText(all);
        });
        $('#voc-grid').addEventListener('click', (e) => {
            const btn = e.target.closest('.voc-copy');
            if (btn) copyText(decodeURIComponent(btn.dataset.vocCopy));
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { closeSettings(); closeFolderModal(); closeAuth(); closeCopyModal(); closeLightbox(); closeDrawer(); if (!$('#onboard-modal').hidden) closeOnboarding(); }
            if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
                e.preventDefault();
                $('#search-input').focus();
            }
        });
    }

    /* ========================================================
       CLOUD ACCOUNTS (Supabase)
       ======================================================== */
    const Cloud = () => window.MnemosCloud;

    function mergeById(localArr, cloudArr) {
        const out = [...localArr];
        const seen = new Set(localArr.map(x => x.id));
        cloudArr.forEach(x => { if (!seen.has(x.id)) { out.push(x); seen.add(x.id); } });
        return out;
    }
    function mergeAds(localArr, cloudArr) {
        const out = [...localArr];
        const seen = new Set(localArr.map(x => String(x.id)));
        cloudArr.forEach(x => { if (!seen.has(String(x.id))) { out.push(x); seen.add(String(x.id)); } });
        return out.sort((a, b) => (b._savedAt || 0) - (a._savedAt || 0));
    }

    async function bootstrapCloud() {
        const cloud = Cloud();
        if (!cloud || !cloud.available()) { updateAccountUI(); return; }
        await cloud.init();
        state.user = cloud.user();
        cloud.onChange((u) => { state.user = u; updateAccountUI(); });
        updateAccountUI();
        if (state.user) {
            await hydrateFromCloud();
            snapshotTrackedBrands();   // build rank history in the background
        }
    }

    // First login = merge guest data with cloud, then push the union up.
    async function hydrateFromCloud() {
        const cloud = Cloud();
        if (!cloud || !cloud.isLoggedIn()) return;
        let remote;
        try { remote = await cloud.pullAll(); }
        catch (e) { console.warn('hydrate', e); return; }

        state.brands = mergeById(state.brands, remote.brands);
        state.folders = mergeById(state.folders, remote.folders);
        state.savedAds = mergeAds(state.savedAds, remote.savedAds);

        store.setLocal('brands', state.brands);
        store.setLocal('folders', state.folders);
        store.setLocal('savedAds', state.savedAds);

        // Push the merged union so the cloud also holds any local-only guest data.
        try {
            await Promise.all([
                cloud.syncBrands(state.brands),
                cloud.syncFolders(state.folders),
                cloud.syncSavedAds(state.savedAds)
            ]);
        } catch (e) { console.warn('push-merge', e); }

        renderBrandChips();
        renderBrandsView();
        renderSavedView();
        renderCounts();
    }

    function accountInitial() {
        const u = state.user;
        const s = (u && (u.name || u.email)) || '';
        return (s.trim()[0] || 'M').toUpperCase();
    }

    function updateAccountUI() {
        const cloud = Cloud();
        const label = $('#account-label');
        const btn = $('#btn-account');
        if (!btn) return;
        if (state.user) {
            const u = state.user;
            label.textContent = u.name || (u.email || '').split('@')[0] || 'Konto';
            btn.classList.add('is-in');
            btn.querySelector('i').className = 'fa-solid fa-circle-user';
        } else {
            label.textContent = (cloud && cloud.available()) ? 'Anmelden' : 'Konto';
            btn.classList.remove('is-in');
            btn.querySelector('i').className = 'fa-regular fa-user';
        }
    }

    let authTab = 'signin';
    function openAuth() {
        const cloud = Cloud();
        const configured = cloud && cloud.available();
        $('#auth-disabled').hidden = !!configured;
        $('#auth-forms').hidden = !!state.user || !configured;
        $('#auth-account').hidden = !state.user;

        if (state.user) {
            $('#auth-title').innerHTML = 'Dein Konto<span class="dot">.</span>';
            $('#account-avatar').textContent = accountInitial();
            $('#account-name').textContent = state.user.name || 'Angemeldet';
            $('#account-email').textContent = state.user.email || '';
            // Auto-tracking-Option nur zeigen, wenn ein Meta-Token vorhanden ist
            $('#account-cron-row').hidden = !state.token;
        } else {
            $('#auth-title').innerHTML = 'Willkommen<span class="dot">.</span>';
            setAuthTab('signin');
            $('#auth-status').textContent = '';
        }
        $('#auth-modal').hidden = false;
    }
    function closeAuth() { $('#auth-modal').hidden = true; }

    function setAuthTab(tab) {
        authTab = tab;
        document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.authTab === tab));
        const isSignup = tab === 'signup';
        $('#auth-name-label').hidden = !isSignup;
        $('#auth-name').hidden = !isSignup;
        $('#auth-submit').textContent = isSignup ? 'Konto erstellen' : 'Einloggen';
        $('#auth-pass').setAttribute('autocomplete', isSignup ? 'new-password' : 'current-password');
        $('#auth-status').textContent = '';
    }

    function authBusy(on, msg) {
        $('#auth-submit').disabled = on;
        if (msg) { $('#auth-status').textContent = msg; $('#auth-status').className = 'auth-status'; }
    }
    function authError(e) {
        const map = {
            'Invalid login credentials': 'E-Mail oder Passwort falsch.',
            'User already registered': 'Diese E-Mail hat bereits ein Konto — bitte einloggen.'
        };
        const raw = (e && e.message) || String(e);
        $('#auth-status').textContent = map[raw] || raw;
        $('#auth-status').className = 'auth-status err';
    }

    async function submitAuth() {
        const cloud = Cloud();
        if (!cloud || !cloud.available()) return;
        const email = $('#auth-email').value.trim();
        const pass = $('#auth-pass').value;
        if (!email || !pass) { $('#auth-status').textContent = 'Bitte E-Mail und Passwort eingeben.'; $('#auth-status').className = 'auth-status err'; return; }
        authBusy(true, 'Einen Moment …');
        try {
            if (authTab === 'signup') {
                const name = $('#auth-name').value.trim();
                const res = await cloud.signUp(email, pass, name);
                if (!res.session) { // E-Mail-Bestätigung aktiv
                    authBusy(false);
                    $('#auth-status').textContent = 'Fast fertig — bestätige deine E-Mail, dann einloggen.';
                    $('#auth-status').className = 'auth-status';
                    setAuthTab('signin');
                    return;
                }
            } else {
                await cloud.signIn(email, pass);
            }
            await onAuthedIn();
        } catch (e) { authBusy(false); authError(e); }
    }

    async function onAuthedIn() {
        state.user = Cloud().user();
        updateAccountUI();
        await hydrateFromCloud();
        authBusy(false);
        closeAuth();
        toast(`<i class="fa-solid fa-cloud"></i> Angemeldet — deine Sammlung ist jetzt gesichert`);
        snapshotTrackedBrands();
        if (state.view === 'radar') renderRadarView();
    }

    async function doMagicLink() {
        const cloud = Cloud();
        const email = $('#auth-email').value.trim();
        if (!email) { $('#auth-status').textContent = 'Bitte zuerst deine E-Mail eingeben.'; $('#auth-status').className = 'auth-status err'; return; }
        try {
            await cloud.signInMagic(email);
            $('#auth-status').textContent = 'Login-Link gesendet — schau in dein Postfach.';
            $('#auth-status').className = 'auth-status';
        } catch (e) { authError(e); }
    }

    async function doForgot() {
        const cloud = Cloud();
        const email = $('#auth-email').value.trim();
        if (!email) { $('#auth-status').textContent = 'Bitte zuerst deine E-Mail eingeben.'; $('#auth-status').className = 'auth-status err'; return; }
        try {
            await cloud.resetPassword(email);
            $('#auth-status').textContent = 'Passwort-Reset gesendet — prüfe deine E-Mails.';
            $('#auth-status').className = 'auth-status';
        } catch (e) { authError(e); }
    }

    async function doSignOut() {
        await Cloud().signOut();
        state.user = null;
        updateAccountUI();
        closeAuth();
        toast('<i class="fa-regular fa-user"></i> Abgemeldet — lokale Daten bleiben in diesem Browser');
        renderBrandsView();
        if (state.view === 'radar') renderRadarView();
    }

    async function toggleAutoTracking(on) {
        const cloud = Cloud();
        if (!cloud || !cloud.isLoggedIn()) return;
        try {
            await cloud.saveSecret(on ? state.token : null, state.country);
            toast(on
                ? '<i class="fa-solid fa-cloud"></i> Auto-Tracking aktiviert'
                : '<i class="fa-regular fa-cloud"></i> Auto-Tracking deaktiviert');
        } catch (e) { console.warn(e); }
    }

    /* ========================================================
       RADAR — Impressions-Ranking & Verlauf pro Brand
       ======================================================== */
    // Aktive Ads einer Brand holen (für den Snapshot) — EU via Meta-API, sonst ScrapeCreators.
    // Ads einer Brand fürs Radar holen — marktübergreifend, brand- statt landzentriert.
    // Primär: Meta über alle EU-Länder + UK (kostenlos). Fallback (nur allowSc + Key):
    // ScrapeCreators weltweit — für reine US-Brands, die Metas offizielle API nicht zeigt.
    async function fetchBrandAds(brand, { allowSc = false } = {}) {
        try {
            const params = new URLSearchParams();
            params.set('ad_type', 'ALL');
            params.set('ad_reached_countries', JSON.stringify(RADAR_COUNTRIES));
            params.set('ad_active_status', 'ACTIVE');
            params.set('search_page_ids', JSON.stringify([brand.id]));
            params.set('fields', FIELDS);
            params.set('limit', '100');
            const json = await fetchAds(metaUrl(params.toString()));
            const ads = json.data || [];
            if (ads.length) return ads;
        } catch (e) { /* weiter zum Fallback */ }

        if (allowSc && state.scKey) {
            const params = new URLSearchParams();
            params.set('country', 'ALL');
            params.set('status', 'ACTIVE');
            params.set('pageId', brand.id);
            const json = await fetchScAds(`${SC_API}/company/ads?${params.toString()}`);
            return (json.searchResults || json.results || []).map(mapScAd);
        }
        return [];
    }

    // Auto-Snapshot im Hintergrund — kostenlos über die marktübergreifende Meta-Suche
    // (EU + UK), nie ScrapeCreators. Frequenz per Einstellung (Standard: täglich).
    async function snapshotTrackedBrands() {
        const cloud = Cloud();
        if (!cloud || !cloud.isLoggedIn() || state.snapshotting) return;
        if (state.forceDemo) return;

        const freq = state.radarFreqDays || 1;   // 0 = aus, sonst alle N Tage
        if (state.radarFreqDays === 0) return;

        state.snapshotting = true;
        try {
            const tracked = state.brands.filter(b => b.tracked !== false);
            for (const brand of tracked) {
                try {
                    if (!(await cloud.snapshotDue(brand.id, freq))) continue;
                    const ads = await fetchBrandAds(brand);   // gratis, kein SC
                    if (ads.length) await cloud.snapshotBrand(brand, ads, { runtimeDays });
                } catch (e) { /* eine Brand überspringen, Rest läuft weiter */ }
            }
        } finally { state.snapshotting = false; }
    }

    async function snapshotBrandNow(brand) {
        const cloud = Cloud();
        if (!cloud || !cloud.isLoggedIn()) return;
        toast('<i class="fa-solid fa-satellite-dish"></i> Snapshot wird geholt …');
        try {
            const ads = await fetchBrandAds(brand, { allowSc: true });
            if (!ads.length) { toast('<i class="fa-solid fa-circle-info"></i> Keine aktiven Ads gefunden (EU/UK) — evtl. reine US-Brand'); return; }
            const res = await cloud.snapshotBrand(brand, ads, { runtimeDays });
            if (!res || !res.written) {
                toast('<i class="fa-solid fa-triangle-exclamation"></i> Konnte nicht gespeichert werden — bitte nochmal');
                return;
            }
            toast(`<i class="fa-solid fa-check"></i> ${esc(brand.name)} aktualisiert (${res.written} Ads)`);
            renderRadarBrand(brand);
        } catch (e) { toast('<i class="fa-solid fa-triangle-exclamation"></i> Snapshot fehlgeschlagen'); }
    }

    function renderRadarView() {
        const cloud = Cloud();
        const chips = $('#radar-brand-chips');
        const panel = $('#radar-panel');
        const empty = $('#radar-empty');
        panel.hidden = true;

        if (!cloud || !cloud.available()) {
            chips.innerHTML = '';
            empty.innerHTML = `
                <div class="state-icon"><i class="fa-solid fa-chart-line"></i></div>
                <h3>Radar braucht ein Konto</h3>
                <p>Trage in <code>supabase-config.js</code> deine Supabase-Zugangsdaten ein, dann misst Mnemos täglich das Ranking deiner Brands. Siehe <code>SUPABASE_SETUP.md</code>.</p>`;
            return;
        }
        if (!state.user) {
            chips.innerHTML = '';
            empty.innerHTML = `
                <div class="state-icon"><i class="fa-solid fa-chart-line"></i></div>
                <h3>Melde dich an, um zu tracken</h3>
                <p>Das Impressions-Ranking wird pro Tag in deinem Konto gespeichert. <button class="inline-link" data-action="open-auth">Konto erstellen →</button></p>`;
            return;
        }
        if (!state.brands.length) {
            chips.innerHTML = '';
            empty.innerHTML = `
                <div class="state-icon"><i class="fa-regular fa-star"></i></div>
                <h3>Noch keine Brands zum Tracken</h3>
                <p>Speichere Brands über den Stern — Mnemos snapshottet ihr Ranking dann täglich automatisch.</p>`;
            return;
        }
        empty.innerHTML = '';
        chips.innerHTML = state.brands.map(b => {
            const tracked = b.tracked !== false;
            const on = state.radarBrand && state.radarBrand.id === b.id;
            return `<button class="chip ${on ? 'active' : ''} ${tracked ? '' : 'muted'}" data-radar-brand="${esc(b.id)}">
                <i class="fa-solid ${tracked ? 'fa-chart-line' : 'fa-circle-pause'}"></i>${esc(b.name)}
            </button>`;
        }).join('');

        const isEu = EU_SET.has(state.country);
        const costNote = isEu
            ? 'EU-Land: Tracking läuft automatisch & kostenlos (Meta-API).'
            : 'Nicht-EU-Land: Auto-Tracking ist aus (spart ScrapeCreators-Credits). Nutze „Jetzt aktualisieren" pro Brand — 1 Snapshot ≈ 1 Credit.';

        const active = state.radarBrand && state.brands.find(b => b.id === state.radarBrand.id);
        if (active) renderRadarBrand(active);
        else {
            empty.innerHTML = `
                <div class="state-icon"><i class="fa-solid fa-hand-pointer"></i></div>
                <h3>Wähle eine Brand</h3>
                <p>Klick auf eine Brand oben, um ihr Ranking und den Verlauf zu sehen.</p>
                <p class="radar-cost-note"><i class="fa-solid fa-circle-info"></i> ${costNote}</p>`;
        }
    }

    // Mini-Sparkline für den Rang-Verlauf (niedriger Rang = besser → oben).
    function rankSparkline(series, maxRank) {
        const pts = series.map((r, i) => ({ i, r })).filter(p => p.r != null);
        if (pts.length < 2) return '<span class="spark-none">—</span>';
        const w = 88, h = 22, pad = 2;
        const n = series.length;
        const top = Math.max(1, maxRank);
        const x = (i) => pad + (n === 1 ? 0 : (i * (w - 2 * pad) / (n - 1)));
        const y = (r) => pad + ((r - 1) * (h - 2 * pad) / Math.max(1, top - 1));
        const d = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.r).toFixed(1)}`).join(' ');
        const last = pts[pts.length - 1];
        return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
            <path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
            <circle cx="${x(last.i).toFixed(1)}" cy="${y(last.r).toFixed(1)}" r="2.2" fill="currentColor"/>
        </svg>`;
    }

    let radarData = null;   // zwischengespeicherte Verlaufsdaten der aktiven Brand
    async function renderRadarBrand(brand) {
        state.radarBrand = { id: brand.id, name: brand.name };
        const panel = $('#radar-panel');
        const empty = $('#radar-empty');
        const table = $('#radar-table');
        empty.innerHTML = '';
        panel.hidden = false;
        $('#radar-brand-avatar').innerHTML = brandAvatarInner(brand.id, brand.name);
        $('#radar-brand-name').textContent = brand.name;
        $('#radar-brand-meta').textContent = 'Lade Verlauf …';
        table.innerHTML = '<div class="radar-loading"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';
        // Chips aktiv markieren
        document.querySelectorAll('#radar-brand-chips .chip').forEach(c =>
            c.classList.toggle('active', c.dataset.radarBrand === brand.id));

        let rows;
        try { rows = await Cloud().getBrandHistory(brand.id, 60); }
        catch (e) { table.innerHTML = '<p class="radar-hint">Verlauf konnte nicht geladen werden.</p>'; return; }

        if (!rows.length) {
            $('#radar-brand-meta').textContent = 'Noch keine Daten';
            table.innerHTML = `<div class="radar-hint">
                <p>Für <strong>${esc(brand.name)}</strong> gibt es noch keinen Snapshot.
                Klick auf <strong>„Jetzt aktualisieren"</strong> — ab dann baut Mnemos täglich den Verlauf auf.</p></div>`;
            return;
        }

        // Nach Tag gruppieren
        const dates = [...new Set(rows.map(r => r.snapshot_date))].sort();  // asc
        const latest = dates[dates.length - 1];
        const latestRows = rows.filter(r => r.snapshot_date === latest).sort((a, b) => a.rank - b.rank);
        const maxRank = Math.max(...rows.map(r => r.rank || 1));

        // Rang-Serie je Ad über die Tage
        const rankByAd = {};
        rows.forEach(r => { (rankByAd[r.ad_id] = rankByAd[r.ad_id] || {})[r.snapshot_date] = r.rank; });
        const prevDate = dates.length > 1 ? dates[dates.length - 2] : null;
        const prevRank = {};
        if (prevDate) rows.filter(r => r.snapshot_date === prevDate).forEach(r => { prevRank[r.ad_id] = r.rank; });

        state.radarFormat = null;   // Format-Filter bei Brand-Wechsel zurücksetzen
        state.radarAds = [];        // findAd-Kontext; Creatives kommen aus radarCreativeCache
        radarData = { dates, latest, latestRows, maxRank, rankByAd, prevDate, prevRank };
        renderRadarMode();
    }

    // Umschalten zwischen Ranking-Liste und Creative-Ansicht
    function renderRadarMode() {
        document.querySelectorAll('#radar-toggle button').forEach(b =>
            b.classList.toggle('active', b.dataset.radarMode === state.radarMode));
        if (state.radarMode === 'creatives') renderRadarCreatives();
        else renderRadarTable();
    }

    // Creative-Ansicht: die aktuellen Ads der Brand in Rang-Reihenfolge als echte Karten.
    // Pro Brand für die Sitzung gecacht → beim Zurückkommen sofort da (kein Neu-Laden).
    const radarCreativeCache = {};
    async function renderRadarCreatives() {
        const table = $('#radar-table');
        $('#radar-format-chips').hidden = true;
        const brand = state.radarBrand;
        if (!brand) return;

        let ads = radarCreativeCache[brand.id];
        if (!ads) {
            table.innerHTML = '<div class="radar-loading"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';
            try {
                ads = await fetchBrandAds(brand, { allowSc: true });
                ads.sort((a, b) => (b.eu_total_reach || 0) - (a.eu_total_reach || 0));
                radarCreativeCache[brand.id] = ads;
            } catch (e) {
                table.innerHTML = '<div class="radar-hint"><p>Creatives konnten nicht geladen werden.</p></div>';
                return;
            }
        }
        // Zwischenzeitlich umgeschaltet oder Brand gewechselt? → nicht rendern
        if (state.radarMode !== 'creatives' || !state.radarBrand || state.radarBrand.id !== brand.id) return;

        state.radarAds = ads;
        $('#radar-brand-meta').innerHTML = `${ads.length} aktive Ads · nach Reichweite geordnet`;

        if (!ads.length) {
            table.innerHTML = '<div class="radar-hint"><p>Keine aktiven Ads gefunden.</p></div>';
            return;
        }
        table.innerHTML = `<div class="results-grid radar-creatives">${
            ads.map((ad, i) => `<div class="radar-creative-item"><span class="radar-rank-badge">#${i + 1}</span>${adCardHtml(ad, i)}</div>`).join('')
        }</div>`;
        scanFrames(table);
    }

    // Format einer Snapshot-Zeile aus der Headline ableiten (Snapshots speichern nur die Headline)
    function radarRowFormats(r) {
        return detectFormats({ id: 'radar-' + r.ad_id, ad_creative_bodies: [r.headline || ''], ad_creative_link_titles: [r.headline || ''] });
    }

    function renderRadarTable() {
        if (!radarData) return;
        const { dates, latest, latestRows, maxRank, rankByAd, prevDate, prevRank } = radarData;
        const table = $('#radar-table');
        const chipsEl = $('#radar-format-chips');

        // Format-Chips aus den erkannten Formaten der Top-Ads
        const counts = {};
        latestRows.forEach(r => radarRowFormats(r).forEach(f => { counts[f] = (counts[f] || 0) + 1; }));
        const present = AD_FORMATS.filter(f => counts[f.id]);
        if (present.length) {
            chipsEl.hidden = false;
            const cr = [`<button class="fchip ${state.radarFormat === null ? 'active' : ''}" data-radar-format=""><i class="fa-solid fa-layer-group"></i>Alle <span class="fchip-count">${latestRows.length}</span></button>`];
            present.forEach(f => cr.push(`<button class="fchip ${state.radarFormat === f.id ? 'active' : ''}" data-radar-format="${f.id}" title="Nur ${esc(f.label)}-Ads im Ranking"><i class="fa-solid ${f.icon}"></i>${esc(f.label)} <span class="fchip-count">${counts[f.id]}</span></button>`));
            chipsEl.innerHTML = cr.join('');
        } else { chipsEl.hidden = true; chipsEl.innerHTML = ''; }

        const shown = state.radarFormat ? latestRows.filter(r => radarRowFormats(r).includes(state.radarFormat)) : latestRows;

        $('#radar-brand-meta').innerHTML =
            `${shown.length}${state.radarFormat ? ` / ${latestRows.length}` : ''} aktive Ads · ${dates.length} ${dates.length === 1 ? 'Tag' : 'Tage'} getrackt · Stand ${fmtDate(latest)}`;

        const head = `<div class="radar-row radar-head">
            <span class="rc-rank">#</span><span class="rc-trend"></span>
            <span class="rc-ad">Ad</span><span class="rc-reach">Reichweite</span>
            <span class="rc-days">Laufzeit</span><span class="rc-spark">Rang-Verlauf</span><span></span></div>`;

        const body = shown.map(r => {
            const reach = r.reach != null ? Number(r.reach) : null;
            const days = r.runtime_days || 0;
            const winner = days >= state.winnerDays || (reach || 0) >= state.winnerReach;
            const series = dates.map(d => rankByAd[r.ad_id] ? (rankByAd[r.ad_id][d] ?? null) : null);
            const daysHere = series.filter(v => v != null).length;

            // Trend ggü. Vortag
            let trend = '<span class="rc-flat">•</span>';
            if (prevDate) {
                const pv = prevRank[r.ad_id];
                if (pv == null) trend = '<span class="rc-new">NEU</span>';
                else if (r.rank < pv) trend = `<span class="rc-up"><i class="fa-solid fa-caret-up"></i>${pv - r.rank}</span>`;
                else if (r.rank > pv) trend = `<span class="rc-down"><i class="fa-solid fa-caret-down"></i>${r.rank - pv}</span>`;
            }

            return `<div class="radar-row">
                <span class="rc-rank">${r.rank}${winner ? ' <i class="fa-solid fa-trophy rc-trophy" title="Winner"></i>' : ''}</span>
                <span class="rc-trend">${trend}</span>
                <span class="rc-ad" title="${esc(r.headline || '')}">
                    <a class="rc-headline" href="https://www.facebook.com/ads/library/?id=${encodeURIComponent(r.ad_id)}" target="_blank" rel="noopener" title="Ad in der Meta Ad Library ansehen">${esc(r.headline || '(kein Text)')}<i class="fa-solid fa-arrow-up-right-from-square"></i></a>
                    <span class="rc-meta">${daysHere}× im Ranking${r.is_active ? '' : ' · beendet'}</span>
                </span>
                <span class="rc-reach">${reach != null ? fmtReach(reach) : '—'}</span>
                <span class="rc-days">${days} T</span>
                <span class="rc-spark">${rankSparkline(series, maxRank)}</span>
                <a class="rc-watch" href="https://www.facebook.com/ads/library/?id=${encodeURIComponent(r.ad_id)}" target="_blank" rel="noopener" title="Ad ansehen"><i class="fa-solid fa-play"></i></a>
            </div>`;
        }).join('');

        table.innerHTML = head + (body || `<div class="radar-hint"><p>Keine ${esc((FORMAT_MAP[state.radarFormat] || {}).label || '')}-Ads im aktuellen Ranking.</p></div>`);
    }

    /* ========================================================
       VOICE OF CUSTOMER — Kundensprache aus Ads & Kommentaren
       Zieht zitierfähige, emotional aufgeladene Phrasen aus den
       geladenen/gespeicherten Ads (gratis) und optional echten
       FB-Kommentaren (ScrapeCreators, kostet Credits).
       ======================================================== */
    const VOICE_POS = /\b(liebe|lieben|geliebt|endlich|begeistert|überzeugt|empfehle|empfehlung|beste[rns]?|genial|perfekt|wahnsinn|unglaublich|dankbar|süchtig|funktioniert|sofort|nie wieder|seit ich|verändert|lebensverändernd|obsessed|love|amazing|incredible|best|game[- ]?changer|changed my life|hooked|finally|never again|works|life[- ]?saver|holy grail|highly recommend|so good)\b/i;
    const FIRST_PERSON = /\b(ich|mein|meine|meinem|meiner|mir|mich|wir|uns|unser)\b|\b(i|i've|i'm|my|me|we|our)\b/i;

    function splitSentences(text) {
        return String(text || '').replace(/\s+/g, ' ')
            .split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
    }

    function scoreQuote(s, { testimonial = false, comment = false } = {}) {
        const words = s.split(/\s+/).length;
        if (words < 3 || words > 26) return 0;
        let score = 0;
        if (testimonial) score += 3;
        if (comment) score += 2;
        if (VOICE_POS.test(s)) score += 3;
        if (FIRST_PERSON.test(s)) score += 2;
        if (/[""„»«]/.test(s)) score += 2;
        if (/[★⭐✩]/.test(s)) score += 2;
        if (words >= 5 && words <= 16) score += 1;
        return score;
    }

    function extractQuotesFromAd(ad) {
        const testimonial = detectFormats(ad).includes('testimonial');
        const raw = ad._demo ? [ad._demo.body, ad._demo.headline] : (ad.ad_creative_bodies || []);
        const text = stripTags(raw.join('\n'));
        const cands = [];
        (text.match(/[""„»«]([^""„»«]{8,180})[""«»]/g) || []).forEach(q => cands.push(q));
        splitSentences(text).forEach(s => cands.push(s));
        const out = [];
        cands.forEach(s => {
            s = s.replace(/^[\s"“„»«']+|[\s"”«»']+$/g, '').replace(/\s+/g, ' ').trim();
            const sc = scoreQuote(s, { testimonial });
            if (sc >= 4) out.push({ text: s, brand: ad.page_name || 'Unbekannt', brandId: ad.page_id, score: sc, source: 'ad' });
        });
        return out;
    }

    function vocPool() {
        const map = new Map();
        [...state.results, ...state.savedAds].forEach(ad => { if (ad && ad.id && !map.has(ad.id)) map.set(ad.id, ad); });
        return [...map.values()];
    }

    function buildVocQuotes(brandId) {
        let quotes = [];
        vocPool().forEach(ad => {
            if (brandId && ad.page_id !== brandId) return;
            quotes = quotes.concat(extractQuotesFromAd(ad));
        });
        state.vocComments.forEach(c => { if (!brandId || c.brandId === brandId) quotes.push(c); });
        quotes.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
        const seen = new Set(); const uniq = [];
        quotes.forEach(q => {
            const n = q.text.toLowerCase().replace(/[^a-z0-9äöü]/g, '').slice(0, 70);
            if (n.length < 12 || seen.has(n)) return;
            seen.add(n); uniq.push(q);
        });
        return uniq.slice(0, 90);
    }

    function vocBrandsInPool() {
        const map = new Map();
        vocPool().forEach(ad => { if (ad.page_id && !map.has(ad.page_id)) map.set(ad.page_id, ad.page_name || 'Unbekannt'); });
        state.vocComments.forEach(c => { if (c.brandId && !map.has(c.brandId)) map.set(c.brandId, c.brand); });
        return [...map.entries()].map(([id, name]) => ({ id, name }));
    }

    function renderVocView() {
        const chips = $('#voc-brand-chips');
        const grid = $('#voc-grid');
        const empty = $('#voc-empty');
        const hint = $('#voc-hint');
        const brands = vocBrandsInPool();

        // Brand-Chips
        if (brands.length) {
            const rows = [`<button class="chip ${state.vocBrand === null ? 'active' : ''}" data-voc-brand=""><i class="fa-solid fa-layer-group"></i>Alle</button>`];
            brands.forEach(b => rows.push(
                `<button class="chip ${state.vocBrand === b.id ? 'active' : ''}" data-voc-brand="${esc(b.id)}"><i class="fa-solid fa-tag"></i>${esc(b.name)}</button>`));
            chips.innerHTML = rows.join('');
        } else chips.innerHTML = '';

        const quotes = buildVocQuotes(state.vocBrand);
        state.lastVocQuotes = quotes;

        // „Echte Kommentare laden" nur für eine gewählte Watchlist-Brand + SC-Key
        const selBrand = state.vocBrand && state.brands.find(b => b.id === state.vocBrand);
        const canLoad = !!(selBrand && state.scKey);
        const loadBtn = $('#voc-load-comments');
        loadBtn.hidden = !canLoad;
        if (canLoad) loadBtn.innerHTML = state.vocLoading
            ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Lädt …'
            : `<i class="fa-solid fa-comments"></i> Echte Kommentare von ${esc(selBrand.name)} (~4 Credits)`;
        $('#voc-copy-all').hidden = quotes.length === 0;

        // Hinweiszeile
        const adCount = vocPool().length;
        if (!adCount && !state.vocComments.length) {
            hint.textContent = '';
        } else {
            const parts = [`${quotes.length} Kundenstimmen aus ${adCount} Ads`];
            if (state.vocComments.length) parts.push(`${state.vocComments.length} echte Kommentare`);
            if (!state.scKey) parts.push('für echte Kommentare: ScrapeCreators-Key in den Einstellungen');
            hint.textContent = parts.join(' · ');
        }

        grid.innerHTML = quotes.map(q => `
            <div class="voc-card">
                <p class="voc-quote">„${esc(q.text)}"</p>
                <div class="voc-card-foot">
                    <span class="voc-src ${q.source}"><i class="fa-solid ${q.source === 'comment' ? 'fa-comment' : 'fa-rectangle-ad'}"></i> ${q.source === 'comment' ? 'Kommentar' : 'Ad'} · ${esc(q.brand)}</span>
                    <button class="voc-copy" data-voc-copy="${encodeURIComponent(q.text)}" title="Kopieren"><i class="fa-regular fa-copy"></i></button>
                </div>
            </div>`).join('');

        if (quotes.length === 0) {
            empty.innerHTML = adCount
                ? `<div class="state-icon"><i class="fa-solid fa-comment-dots"></i></div>
                   <h3>Noch keine starken Stimmen gefunden</h3>
                   <p>Lade Testimonial-Ads über „Entdecken" (Format-Filter „Testimonial") oder eine Brand mit vielen Reviews — dann tauchen hier die zitierfähigen Phrasen auf.</p>`
                : `<div class="state-icon"><i class="fa-solid fa-magnifying-glass"></i></div>
                   <h3>Erst Ads laden</h3>
                   <p>Such unter „Entdecken" nach einer Brand oder einem Keyword. Mnemos zieht dann automatisch die Kundenstimmen aus den Ads — besonders aus Testimonials.</p>`;
        } else empty.innerHTML = '';
    }

    // ScrapeCreators: FB-Posts der Brand → Kommentare → in den VoC-Pool
    function scText(o) {
        return (o && (o.text || o.comment || o.body || o.message || (o.data && o.data.text))) || '';
    }
    function harvestComments(list, brand) {
        let added = 0;
        (list || []).forEach(c => {
            const t = stripTags(scText(c)).replace(/\s+/g, ' ').trim();
            const sc = scoreQuote(t, { comment: true });
            if (sc >= 3 && t.split(/\s+/).length >= 3) {
                const norm = t.toLowerCase().replace(/[^a-z0-9äöü]/g, '').slice(0, 70);
                if (!state.vocComments.some(x => x.brandId === brand.id && x._n === norm)) {
                    state.vocComments.push({ text: t, brand: brand.name, brandId: brand.id, score: sc, source: 'comment', _n: norm });
                    added++;
                }
            }
        });
        return added;
    }

    async function loadBrandComments(brand) {
        if (!state.scKey || state.vocLoading) return;
        state.vocLoading = true;
        renderVocView();
        try {
            // 1) Öffentliche Posts der Facebook-Page holen — WICHTIG: über die URL,
            //    nicht pageId (pageId liefert bei vielen Pages 0 Posts zurück).
            const pageUrl = `https://www.facebook.com/${encodeURIComponent(brand.id)}`;
            const pRes = await fetch(`${SC_ROOT}/facebook/profile/posts?url=${encodeURIComponent(pageUrl)}`, { headers: { 'x-api-key': state.scKey } });
            const pJson = await pRes.json().catch(() => ({}));
            if (!pRes.ok || pJson.success === false) {
                console.warn('[Mnemos VoC] profile/posts', pRes.status, pJson);
                toast(`<i class="fa-solid fa-triangle-exclamation"></i> ${esc(pJson.error || pJson.message || ('Fehler ' + pRes.status))}`);
                return;
            }
            const posts = pJson.posts || (pJson.data && pJson.data.posts) || pJson.results || (Array.isArray(pJson) ? pJson : []);
            if (!posts.length) {
                toast('<i class="fa-solid fa-circle-info"></i> Keine öffentlichen Facebook-Posts gefunden — viele Brands posten fast nur auf Instagram.');
                return;
            }

            // 2) Beispiel-Kommentare aus den Posts einsammeln (ohne Extra-Credits)
            let added = 0;
            posts.forEach(p => { added += harvestComments(p.topComments || p.top_comments || p.comments, brand); });

            // 3) Kommentare nachladen — nur Posts, die überhaupt Kommentare haben
            //    (leere Reels überspringen = keine verschwendeten Credits).
            const withComments = posts
                .filter(p => (p.commentCount || 0) > 0 && (p.url || p.permalink || p.post_url))
                .sort((a, b) => (b.commentCount || 0) - (a.commentCount || 0))
                .slice(0, 4);
            for (const post of withComments) {
                const link = post.url || post.permalink || post.post_url;
                try {
                    const cRes = await fetch(`${SC_ROOT}/facebook/post/comments?url=${encodeURIComponent(link)}`, { headers: { 'x-api-key': state.scKey } });
                    const cJson = await cRes.json().catch(() => ({}));
                    const comments = cJson.comments || (cJson.data && cJson.data.comments) || cJson.results || (Array.isArray(cJson) ? cJson : []);
                    added += harvestComments(comments, brand);
                } catch (e) { /* Post überspringen */ }
            }

            toast(added
                ? `<i class="fa-solid fa-comments"></i> ${added} Kundenstimmen geladen`
                : `<i class="fa-solid fa-circle-info"></i> ${posts.length} Posts gefunden, aber kaum Kommentare (diese Brand postet wenig auf Facebook)`);
        } catch (e) {
            console.warn('[Mnemos VoC]', e);
            toast('<i class="fa-solid fa-triangle-exclamation"></i> Kommentare konnten nicht geladen werden');
        } finally {
            state.vocLoading = false;
            renderVocView();
        }
    }

    async function copyText(text) {
        try { await navigator.clipboard.writeText(text); toast('<i class="fa-regular fa-copy"></i> Kopiert'); }
        catch { toast('<i class="fa-solid fa-triangle-exclamation"></i> Kopieren nicht möglich'); }
    }

    /* ---------- Ad-Copy-Modal: vollständigen Anzeigentext ansehen ---------- */
    let copyModalText = '';
    function openCopyModal(ad) {
        const titles = (ad._demo ? [stripTags(ad._demo.headline)] : (ad.ad_creative_link_titles || [])).filter(Boolean);
        const bodies = (ad._demo ? [ad._demo.body] : (ad.ad_creative_bodies || [])).filter(Boolean);
        const captions = (ad.ad_creative_link_captions || []).filter(Boolean);

        $('#copy-brand').innerHTML = brandAvatarHtml(ad.page_id, ad.page_name) +
            `<div><strong>${esc(ad.page_name || 'Unbekannt')}</strong><span>${runtimeDays(ad)} Tage aktiv${isWinner(ad) ? ' · 🏆 Winner' : ''}</span></div>`;

        const sec = [];
        if (titles.length) sec.push(`<div class="copy-sec"><span class="copy-label">Headline</span>${titles.map(t => `<p>${esc(t)}</p>`).join('')}</div>`);
        if (bodies.length) sec.push(`<div class="copy-sec"><span class="copy-label">Primary Text${bodies.length > 1 ? ` · ${bodies.length} Varianten` : ''}</span>${bodies.map(b => `<p class="copy-text">${esc(b).replace(/\n/g, '<br>')}</p>`).join('')}</div>`);
        if (captions.length) sec.push(`<div class="copy-sec"><span class="copy-label">Anzeige-Link</span>${captions.map(c => `<p>${esc(c)}</p>`).join('')}</div>`);
        if (!sec.length) sec.push('<p class="copy-empty">Für diese Ad ist kein Text hinterlegt — öffne das Creative, um sie in der Ad Library zu sehen.</p>');
        $('#copy-body').innerHTML = sec.join('');

        copyModalText = [...titles, ...bodies].join('\n\n');
        const snap = $('#copy-snapshot');
        if (ad.ad_snapshot_url) { snap.hidden = false; snap.href = ad.ad_snapshot_url; } else snap.hidden = true;
        $('#copy-copy-btn').style.display = copyModalText ? '' : 'none';
        $('#copy-modal').hidden = false;
    }
    function closeCopyModal() { $('#copy-modal').hidden = true; }

    /* ---------- Creative-Lightbox: groß ansehen + Download ---------- */
    function proxyDownloadUrl(url, filename) {
        return `${APP_ORIGIN}/api/download?url=${encodeURIComponent(url)}&name=${encodeURIComponent(filename)}`;
    }
    function openLightbox(ad) {
        const media = ad._media || getCachedMedia(ad.id);
        const stage = $('#lightbox-media');
        const dl = $('#lightbox-download');
        const isVid = media && !!media.video;
        const imgUrl = media && ((media.images && media.images[0]) || media.poster);
        const nameBase = `${(ad.page_name || 'ad').replace(/[^\w]+/g, '-')}-${ad.id}`;

        if (isVid) {
            stage.innerHTML = `<video src="${esc(media.video)}" controls autoplay playsinline></video>`;
            dl.hidden = false;
            dl.onclick = () => downloadCreative(media.video, nameBase);
        } else if (imgUrl) {
            stage.innerHTML = `<img src="${esc(imgUrl)}" alt="Ad Creative">`;
            dl.hidden = false;
            dl.onclick = () => downloadCreative(imgUrl, nameBase);
        } else {
            // Kein Medien-URL (z. B. nur Companion-Poster): auf Ad Library verweisen
            stage.innerHTML = `<div class="lightbox-none"><i class="fa-regular fa-image"></i><p>Kein direktes Creative verfügbar — in der Ad Library ansehen.</p></div>`;
            dl.hidden = true;
        }

        $('#lightbox-info').innerHTML = `<strong>${esc(ad.page_name || 'Unbekannt')}</strong><span>${runtimeDays(ad)} Tage aktiv${isWinner(ad) ? ' · 🏆 Winner' : ''}</span>`;
        const fb = $('#lightbox-fb');
        if (ad.ad_snapshot_url) { fb.hidden = false; fb.href = ad.ad_snapshot_url; } else fb.hidden = true;

        const box = $('#lightbox');
        box.hidden = false;
        requestAnimationFrame(() => box.classList.add('show'));
        document.body.style.overflow = 'hidden';
    }
    function closeLightbox() {
        const box = $('#lightbox');
        if (box.hidden) return;
        box.classList.remove('show');
        document.body.style.overflow = '';
        setTimeout(() => { box.hidden = true; $('#lightbox-media').innerHTML = ''; }, 260);
    }
    async function downloadCreative(url, nameBase) {
        toast('<i class="fa-solid fa-download"></i> Download startet …');
        // Über den Proxy laden (fbcdn erlaubt keinen Cross-Origin-Direktdownload)
        const a = document.createElement('a');
        a.href = proxyDownloadUrl(url, nameBase);
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    /* ========================================================
       CONTEXTUAL DRAWER — Ad-Detail-Seitenpanel
       Klick auf eine Karte (abseits der Buttons) öffnet ein
       Slide-in-Panel rechts mit allen Details der Ad.
       ======================================================== */
    function drawerRow(label, valueHtml) {
        if (!valueHtml) return '';
        return `<div class="drawer-row"><span class="drawer-label">${esc(label)}</span><div class="drawer-value">${valueHtml}</div></div>`;
    }

    function drawerHtml(ad) {
        const media = ad._media || getCachedMedia(ad.id);
        const mediaInner = media ? mediaHtml(ad, media) : null;
        const active = !ad.ad_delivery_stop_time;
        const bodies = (ad._demo ? [ad._demo.body] : (ad.ad_creative_bodies || [])).filter(Boolean);
        const titles = (ad._demo ? [stripTags(ad._demo.headline)] : (ad.ad_creative_link_titles || [])).filter(Boolean);
        const captions = (ad.ad_creative_link_captions || []).filter(Boolean);
        const cta = ad._cta || (ad._demo && ad._demo.cta) || null;
        const landing = getLandingUrl(ad);
        const platforms = (ad.publisher_platforms || [])
            .map(p => `<span class="drawer-platform"><i class="${PLATFORM_ICONS[p.toLowerCase()] || 'fa-solid fa-bullhorn'}"></i> ${esc(p)}</span>`)
            .join('');
        const runTime = ad.ad_delivery_start_time
            ? `${fmtDate(ad.ad_delivery_start_time)} → ${active ? 'läuft noch' : fmtDate(ad.ad_delivery_stop_time)}`
            : null;
        const score = adRankScore(ad);
        const tier = scoreTier(score);
        const shops = dupInfo(ad);
        const adSaved = isAdSaved(ad.id);

        return `
        <div class="drawer-media" data-ad-id="${esc(ad.id)}">
            <div class="ad-frame">
                <div class="frame-media">${mediaInner || (ad._demo
                    ? `<div class="demo-creative" style="background:linear-gradient(160deg, ${ad._demo.grad[0]}, ${ad._demo.grad[1]})">
                        <span class="dc-tag">${esc(ad._demo.tag)}</span>
                        <div><div class="dc-headline">${ad._demo.headline}</div>
                        <p class="dc-body" style="margin-top:14px">${esc(ad._demo.body)}</p></div></div>`
                    : `<div class="drawer-media-empty" data-drawer-media><i class="fa-regular fa-image fa-spin-pulse"></i><p>Creative wird geladen …</p></div>`)}</div>
                <div class="rank-badge rank-${tier}" title="Performance Score">${score == null ? '—' : score}</div>
            </div>
        </div>

        <div class="drawer-brand">
            ${brandAvatarHtml(ad.page_id, ad.page_name)}
            <div>
                <strong>${esc(ad.page_name || 'Unbekannt')}</strong>
                <span>Page ID: ${esc(ad.page_id || '—')}</span>
            </div>
        </div>

        <div class="drawer-badges">
            ${isWinner(ad) ? '<span class="meta-badge winner"><i class="fa-solid fa-trophy"></i> Winner</span>' : ''}
            ${active ? '<span class="meta-badge live">Live</span>' : '<span class="meta-badge ended"><i class="fa-regular fa-circle-stop"></i> Beendet</span>'}
            ${dupBadgeHtml(ad)}
        </div>

        ${shops ? `<div class="drawer-dup-list">
            <span class="drawer-label">Läuft auch bei</span>
            <ul>${shops.filter(s => s.id !== ad.page_id).map(s => `<li><i class="fa-solid fa-shop"></i> ${esc(s.name)}</li>`).join('')}</ul>
        </div>` : ''}

        ${drawerRow('Primary Text', bodies.length ? bodies.map(b => `<p class="drawer-copy">${esc(b).replace(/\n/g, '<br>')}</p>`).join('') : '')}
        ${drawerRow('Headline', titles.length ? titles.map(t => `<p>${esc(t)}</p>`).join('') : '')}
        ${drawerRow('Link Caption', captions.length ? captions.map(c => `<p>${esc(c)}</p>`).join('') : '')}
        ${drawerRow('CTA-Button', cta ? `<span class="drawer-cta-pill">${esc(cta)}</span>` : '')}
        ${drawerRow('Landingpage', landing ? `<a href="${esc(landing)}" target="_blank" rel="noopener">${esc(landing)} <i class="fa-solid fa-arrow-up-right-from-square"></i></a>` : '')}
        ${drawerRow('Plattformen', platforms || '')}
        ${drawerRow('Laufzeit', runTime ? `${esc(runTime)} <span class="drawer-days">(${runtimeDays(ad)} Tage)</span>` : '')}
        ${drawerRow('EU-Reichweite', ad.eu_total_reach != null ? esc(fmtReach(ad.eu_total_reach)) : (ad._impressions ? esc(ad._impressions) + ' Impressionen' : ''))}

        <div class="drawer-actions">
            <button class="btn btn-outline ${adSaved ? 'btn-saved' : ''}" data-drawer-action="save-ad">
                <i class="${adSaved ? 'fa-solid' : 'fa-regular'} fa-bookmark"></i>${adSaved ? 'Gespeichert' : 'Speichern'}
            </button>
            ${!ad._demo && ad.ad_snapshot_url ? '<button class="btn btn-outline" data-drawer-action="download"><i class="fa-solid fa-download"></i> Creative laden</button>' : ''}
            ${ad.ad_snapshot_url ? `<a class="btn btn-outline" href="${esc(ad.ad_snapshot_url)}" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square"></i> Ad Library</a>` : ''}
            <button class="btn btn-outline" data-drawer-action="copy-link"><i class="fa-regular fa-copy"></i> Link kopieren</button>
        </div>`;
    }

    let drawerAdId = null;
    function openDrawer(ad) {
        drawerAdId = ad.id;
        $('#drawer-body').innerHTML = drawerHtml(ad);
        $('#drawer-overlay').hidden = false;
        $('#ad-drawer').hidden = false;
        $('#ad-drawer').setAttribute('aria-hidden', 'false');
        requestAnimationFrame(() => {
            $('#drawer-overlay').classList.add('show');
            $('#ad-drawer').classList.add('show');
        });
        document.body.style.overflow = 'hidden';
        scanDrawerFrame(ad);
    }
    function closeDrawer() {
        const box = $('#ad-drawer');
        if (box.hidden) return;
        box.classList.remove('show');
        $('#drawer-overlay').classList.remove('show');
        box.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        drawerAdId = null;
        setTimeout(() => { box.hidden = true; $('#drawer-overlay').hidden = true; $('#drawer-body').innerHTML = ''; }, 260);
    }

    /* ========================================================
       STARTSEITE: KURATIERTE „AKTUELLE WINNER"
       Statische featured.json → funktioniert für jeden Besucher
       ohne Token. Wird beim Öffnen (vor jeder Suche) angezeigt.
       ======================================================== */
    async function fetchFeatured() {
        for (const url of [FEATURED_URL, FEATURED_FALLBACK]) {
            try {
                const res = await fetch(url, { cache: 'no-cache' });
                if (!res.ok) continue;
                const data = await res.json();
                const items = Array.isArray(data) ? data : (data.ads || []);
                if (items.length) return items;
            } catch (e) { /* nächste Quelle */ }
        }
        return [];
    }

    async function loadFeatured() {
        try {
            const items = await fetchFeatured();
            if (!items.length) return false;

            state.results = items.map(e => e.ad || e).filter(Boolean);
            items.forEach(e => { const ad = e.ad || e; if (ad && e.media) setCachedMedia(ad.id, e.media); });
            state.featured = true;
            state.demo = false;
            state.forceDemo = false;
            state._hasMore = false;
            state.nextUrl = null;
            renderResults();
            renderResultsMeta();
            setStateBox(state.results.length ? null : 'welcome');
            $('#btn-loadmore').hidden = true;
            $('#featured-head').hidden = false;
            updateDemoBanner();
            return true;
        } catch (e) { return false; }
    }

    /* ========================================================
       PWA — Service Worker & "Zum Startbildschirm hinzufügen"
       ======================================================== */
    function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('sw.js').catch(() => { /* z. B. file:// — kein Problem */ });
        });
    }

    let deferredInstallPrompt = null;
    function bindInstallPrompt() {
        const btn = $('#btn-install');
        if (!btn) return;
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredInstallPrompt = e;
            btn.hidden = false;
        });
        btn.addEventListener('click', async () => {
            if (!deferredInstallPrompt) return;
            btn.hidden = true;
            deferredInstallPrompt.prompt();
            await deferredInstallPrompt.userChoice.catch(() => {});
            deferredInstallPrompt = null;
        });
        window.addEventListener('appinstalled', () => { btn.hidden = true; deferredInstallPrompt = null; });
    }

    /* ========================================================
       INIT
       ======================================================== */
    function init() {
        bindEvents();
        renderBrandChips();
        renderCounts();
        updateDemoBanner();
        registerServiceWorker();
        bindInstallPrompt();
        // Companion-Extension anpingen (falls sie vor uns geladen wurde)
        window.postMessage({ source: 'mnemos-app', type: 'ping' }, '*');

        // Startseite: kuratierte Winner laden; klappt das nicht, alte Logik.
        loadFeatured().then(ok => {
            if (ok) return;
            if (state.token && !state.forceDemo) {
                setStateBox('welcome');
            } else {
                // Demo direkt zeigen, damit die App nicht leer wirkt
                runSearch();
            }
        });

        // Erste Nutzung ohne Keys: Einrichtungs-Guide zeigen
        if (!store.get('onboarded', false) && !state.token && !state.scKey) {
            openOnboarding();
        }

        // Cloud-Konto initialisieren (Session wiederherstellen, ggf. hydrieren)
        bootstrapCloud().catch(e => console.warn('cloud bootstrap', e));
    }

    init();
})();
