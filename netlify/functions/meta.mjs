/* ============================================================
   Netlify Function — geteilter Meta-Ad-Library-Zugang.
   Nutzt das serverseitige META_TOKEN (deins), damit Tester die
   EU-Suche nutzen können, ohne selbst den komplizierten
   Graph-API-Token einzurichten. Token bleibt serverseitig.

   Route: /api/meta?<ads_archive-Query ohne access_token>
   ============================================================ */

const API = 'https://graph.facebook.com/v21.0/ads_archive';

export default async (req) => {
    const u = new URL(req.url);
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const token = process.env.META_TOKEN;
    if (!token) {
        return new Response(JSON.stringify({ error: { message: 'Shared Meta access not configured yet.' } }), { status: 200, headers });
    }

    // Query des Clients übernehmen, aber den access_token immer serverseitig setzen.
    const params = new URLSearchParams(u.search);
    params.delete('access_token');
    params.set('access_token', token);

    let json;
    try {
        const r = await fetch(`${API}?${params.toString()}`);
        json = await r.json();
    } catch (e) {
        return new Response(JSON.stringify({ error: { message: 'Upstream fetch failed' } }), { status: 200, headers });
    }

    // paging.next zurück über den Proxy leiten und den Token entfernen
    if (json && json.paging && json.paging.next) {
        try {
            const nu = new URL(json.paging.next);
            nu.searchParams.delete('access_token');
            json.paging.next = `${u.protocol}//${u.host}/api/meta?${nu.searchParams.toString()}`;
        } catch { /* ignore */ }
    }

    return new Response(JSON.stringify(json), { status: 200, headers });
};

export const config = { path: '/api/meta' };
