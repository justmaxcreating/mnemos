/* ============================================================
   Netlify Function — Download-Proxy für Ad-Creatives.
   fbcdn erlaubt keinen Cross-Origin-Direktdownload; diese Function
   holt das Medium serverseitig und schickt es mit
   Content-Disposition: attachment zurück → echter Download.

   Sicherheit: nur *.fbcdn.net erlaubt (kein offener Proxy).
   Route: /api/download?url=<encoded>&name=<filename>
   ============================================================ */

export default async (req) => {
    const u = new URL(req.url);
    const target = u.searchParams.get('url');
    let name = (u.searchParams.get('name') || 'mnemos-creative').replace(/[^\w.\-]+/g, '_').slice(0, 80);
    if (!target) return new Response('missing url', { status: 400 });

    let host;
    try { host = new URL(target).host; } catch { return new Response('bad url', { status: 400 }); }
    if (!/(^|\.)fbcdn\.net$/i.test(host)) return new Response('forbidden host', { status: 403 });

    let res;
    try { res = await fetch(target); } catch { return new Response('fetch error', { status: 502 }); }
    if (!res.ok) return new Response('upstream ' + res.status, { status: 502 });

    const ct = res.headers.get('content-type') || 'application/octet-stream';
    const ext = ct.includes('video') ? 'mp4' : (ct.includes('png') ? 'png' : (ct.includes('gif') ? 'gif' : 'jpg'));

    return new Response(res.body, {
        status: 200,
        headers: {
            'Content-Type': ct,
            'Content-Disposition': `attachment; filename="${name}.${ext}"`,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600'
        }
    });
};

export const config = { path: '/api/download' };
