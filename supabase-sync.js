/* ============================================================
   Mnemos — Cloud layer (Supabase)
   ------------------------------------------------------------
   Accounts + cloud-synced swipe file / brands / folders, plus
   the Parker-style brand rank snapshots & history.

   Exposes a tiny surface used by app.js:  window.MnemosCloud
   Degrades to a no-op when supabase-config.js is blank, so the
   app keeps working in guest (localStorage-only) mode.
   ============================================================ */
(function () {
    'use strict';

    const cfg = window.MNEMOS_SUPABASE || {};
    const hasConfig = !!(cfg.url && cfg.anonKey && window.supabase);

    let client = null;
    let session = null;
    const listeners = [];

    if (hasConfig) {
        client = window.supabase.createClient(cfg.url, cfg.anonKey, {
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
        });
    }

    const uid = () => session && session.user ? session.user.id : null;
    const withUser = (row) => ({ ...row, user_id: uid() });

    function emit() {
        const info = MnemosCloud.user();
        listeners.forEach(fn => { try { fn(info); } catch (e) { console.error(e); } });
    }

    /* ---------------- data mappers ---------------- */
    function adToRow(ad) {
        return withUser({
            ad_id: String(ad.id),
            folder: ad.folder || null,
            data: ad,
            saved_at: ad._savedAt ? new Date(ad._savedAt).toISOString() : new Date().toISOString()
        });
    }
    const rowToAd = (r) => ({ ...r.data, folder: r.folder || null, _savedAt: new Date(r.saved_at).getTime() });

    /* ---------------- generic "replace whole collection" ----------------
       Upsert everything currently in the client, then delete rows the
       client no longer has. Keeps cloud == local after any mutation. */
    async function replaceCollection(table, rows, idCol, currentIds) {
        if (!client || !uid()) return;
        try {
            if (rows.length) {
                const { error } = await client.from(table).upsert(rows);
                if (error) throw error;
            }
            let q = client.from(table).delete().eq('user_id', uid());
            if (currentIds.length) q = q.not(idCol, 'in', `(${currentIds.map(quote).join(',')})`);
            const { error: delErr } = await q;
            if (delErr) throw delErr;
        } catch (e) { console.warn('[Mnemos cloud] sync', table, e.message || e); }
    }
    const quote = (v) => `"${String(v).replace(/"/g, '""')}"`;

    const MnemosCloud = {
        enabled: hasConfig,
        available() { return hasConfig; },
        isLoggedIn() { return !!uid(); },
        user() {
            if (!session || !session.user) return null;
            const u = session.user;
            return { id: u.id, email: u.email || '', name: (u.user_metadata && u.user_metadata.name) || '' };
        },
        onChange(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i > -1) listeners.splice(i, 1); }; },

        /* ---------- session bootstrap ---------- */
        async init() {
            if (!client) return null;
            const { data } = await client.auth.getSession();
            session = data.session || null;
            client.auth.onAuthStateChange((_evt, s) => { session = s || null; emit(); });
            return this.user();
        },

        /* ---------- auth ---------- */
        async signUp(email, password, name) {
            if (!client) throw new Error('Cloud nicht konfiguriert');
            const { data, error } = await client.auth.signUp({
                email, password,
                options: { data: { name: name || '' }, emailRedirectTo: window.location.origin }
            });
            if (error) throw error;
            session = data.session || session;
            return data;
        },
        async signIn(email, password) {
            if (!client) throw new Error('Cloud nicht konfiguriert');
            const { data, error } = await client.auth.signInWithPassword({ email, password });
            if (error) throw error;
            session = data.session || null;
            emit();
            return data;
        },
        async signInMagic(email) {
            if (!client) throw new Error('Cloud nicht konfiguriert');
            const { error } = await client.auth.signInWithOtp({
                email, options: { emailRedirectTo: window.location.href.split('#')[0] }
            });
            if (error) throw error;
            return true;
        },
        async resetPassword(email) {
            if (!client) throw new Error('Cloud nicht konfiguriert');
            const { error } = await client.auth.resetPasswordForEmail(email, {
                redirectTo: window.location.href.split('#')[0]
            });
            if (error) throw error;
            return true;
        },
        async signOut() {
            if (!client) return;
            await client.auth.signOut();
            session = null;
            emit();
        },

        /* ---------- pull everything for the logged-in user ---------- */
        async pullAll() {
            if (!client || !uid()) return { brands: [], savedAds: [], folders: [] };
            const [b, s, f] = await Promise.all([
                client.from('brands').select('id,name,tracked,created_at').eq('user_id', uid()),
                client.from('saved_ads').select('ad_id,folder,data,saved_at').eq('user_id', uid()),
                client.from('folders').select('id,name,parent_id,created_at').eq('user_id', uid())
            ]);
            return {
                brands: (b.data || []).map(r => ({ id: r.id, name: r.name, tracked: r.tracked !== false })),
                savedAds: (s.data || []).map(rowToAd).sort((x, y) => (y._savedAt || 0) - (x._savedAt || 0)),
                folders: (f.data || []).map(r => ({ id: r.id, name: r.name, parentId: r.parent_id || null }))
            };
        },

        /* ---------- whole-collection sync (called from store.set) ---------- */
        async syncBrands(list) {
            await replaceCollection('brands',
                list.map(b => withUser({ id: b.id, name: b.name, tracked: b.tracked !== false })),
                'id', list.map(b => b.id));
        },
        async syncFolders(list) {
            await replaceCollection('folders',
                list.map(f => withUser({ id: f.id, name: f.name, parent_id: f.parentId || null })),
                'id', list.map(f => f.id));
        },
        async syncSavedAds(list) {
            await replaceCollection('saved_ads', list.map(adToRow), 'ad_id', list.map(a => String(a.id)));
        },

        /* ---------- rank snapshots (Parker-style) ---------- */
        // Upsert today's snapshot for one brand. `ads` = the fetched ad objects.
        async snapshotBrand(brand, ads, helpers) {
            if (!client || !uid() || !ads || !ads.length) return { written: 0 };
            const today = new Date().toISOString().slice(0, 10);
            // Nach Reichweite sortieren UND nach ad_id deduplizieren — doppelte ad_ids
            // (Meta/SC über mehrere Placements) würden sonst den ganzen Upsert killen.
            const seenIds = new Set();
            const ranked = [...ads]
                .sort((a, b) => (b.eu_total_reach || 0) - (a.eu_total_reach || 0))
                .filter(ad => { const k = String(ad.id); if (seenIds.has(k)) return false; seenIds.add(k); return true; });
            const rows = ranked.map((ad, i) => withUser({
                brand_id: brand.id,
                snapshot_date: today,
                ad_id: String(ad.id),
                page_name: ad.page_name || brand.name,
                headline: ((ad.ad_creative_link_titles || [])[0] || (ad.ad_creative_bodies || [])[0] || '').slice(0, 300),
                reach: ad.eu_total_reach ?? null,
                impressions: ad._impressions || null,
                runtime_days: helpers && helpers.runtimeDays ? helpers.runtimeDays(ad) : null,
                is_active: !ad.ad_delivery_stop_time,
                rank: i + 1
            }));
            const { error } = await client.from('brand_snapshots')
                .upsert(rows, { onConflict: 'user_id,brand_id,snapshot_date,ad_id' });
            if (error) { console.warn('[Mnemos cloud] snapshot', error.message); return { written: 0 }; }
            return { written: rows.length, date: today };
        },
        // Has today already been snapshotted for this brand?
        async hasSnapshotToday(brandId) {
            if (!client || !uid()) return true; // don't snapshot when logged out
            const today = new Date().toISOString().slice(0, 10);
            const { count } = await client.from('brand_snapshots')
                .select('ad_id', { count: 'exact', head: true })
                .eq('user_id', uid()).eq('brand_id', brandId).eq('snapshot_date', today);
            return (count || 0) > 0;
        },
        // Ist ein neuer Snapshot fällig? (kein Snapshot in den letzten freqDays Tagen)
        async snapshotDue(brandId, freqDays) {
            if (!client || !uid()) return false;
            const { data } = await client.from('brand_snapshots')
                .select('snapshot_date').eq('user_id', uid()).eq('brand_id', brandId)
                .order('snapshot_date', { ascending: false }).limit(1);
            if (!data || !data.length) return true;   // noch nie → fällig
            const days = Math.floor((Date.now() - new Date(data[0].snapshot_date).getTime()) / 864e5);
            return days >= (freqDays || 1);
        },
        // Full history for a brand → rows grouped by day (newest first).
        async getBrandHistory(brandId, days) {
            if (!client || !uid()) return [];
            const since = new Date(Date.now() - (days || 60) * 864e5).toISOString().slice(0, 10);
            const { data } = await client.from('brand_snapshots')
                .select('snapshot_date,ad_id,page_name,headline,reach,impressions,runtime_days,is_active,rank')
                .eq('user_id', uid()).eq('brand_id', brandId)
                .gte('snapshot_date', since)
                .order('snapshot_date', { ascending: false })
                .order('rank', { ascending: true });
            return data || [];
        },
        // Which brands have any snapshot history?
        async trackedBrandIds() {
            if (!client || !uid()) return [];
            const { data } = await client.from('brand_snapshots')
                .select('brand_id').eq('user_id', uid());
            return [...new Set((data || []).map(r => r.brand_id))];
        },

        /* ---------- optional: store Meta token for the always-on cron ---------- */
        async saveSecret(metaToken, country) {
            if (!client || !uid()) return;
            await client.from('user_secrets').upsert(withUser({
                meta_token: metaToken || null, country: country || 'DE', updated_at: new Date().toISOString()
            }));
        }
    };

    window.MnemosCloud = MnemosCloud;
})();
