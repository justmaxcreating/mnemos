// ============================================================
//  Mnemos — daily brand rank tracker  (Supabase Edge Function)
//
//  Records one snapshot per tracked brand per day: every active ad,
//  its EU reach, runtime, and its rank *within the brand* that day.
//  Over time this is the Parker-style "impressions rank history".
//
//  This is the OPTIONAL always-on path. The web app also snapshots
//  client-side whenever a signed-in user opens Mnemos, so tracking
//  works even without deploying this function.
//
//  Deploy:   supabase functions deploy track-brands --no-verify-jwt
//  Schedule: see supabase/schema-cron.sql (pg_cron → pg_net, daily).
//  Secrets:  SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected
//            automatically; set a shared CRON_SECRET to gate calls.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const API_VERSION = "v21.0";
const FIELDS = [
  "id", "page_id", "page_name",
  "ad_creative_bodies", "ad_creative_link_titles",
  "ad_delivery_start_time", "ad_delivery_stop_time",
  "eu_total_reach",
].join(",");

type Ad = {
  id: string;
  page_name?: string;
  ad_creative_bodies?: string[];
  ad_creative_link_titles?: string[];
  ad_delivery_start_time?: string;
  ad_delivery_stop_time?: string;
  eu_total_reach?: number;
};

function runtimeDays(ad: Ad): number {
  if (!ad.ad_delivery_start_time) return 0;
  const start = new Date(ad.ad_delivery_start_time).getTime();
  const end = ad.ad_delivery_stop_time
    ? new Date(ad.ad_delivery_stop_time).getTime()
    : Date.now();
  return Math.max(0, Math.round((end - start) / 864e5));
}

async function fetchBrandAds(token: string, country: string, pageId: string): Promise<Ad[]> {
  const url = new URL(`https://graph.facebook.com/${API_VERSION}/ads_archive`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("ad_reached_countries", JSON.stringify([country]));
  url.searchParams.set("search_page_ids", JSON.stringify([pageId]));
  url.searchParams.set("ad_active_status", "ACTIVE");
  url.searchParams.set("ad_type", "ALL");
  url.searchParams.set("fields", FIELDS);
  url.searchParams.set("limit", "100");

  const ads: Ad[] = [];
  let next: string | null = url.toString();
  let guard = 0;
  while (next && guard++ < 10) {
    const res = await fetch(next);
    if (!res.ok) break;
    const json = await res.json();
    (json.data || []).forEach((a: Ad) => ads.push(a));
    next = json.paging?.next ?? null;
  }
  return ads;
}

Deno.serve(async (req) => {
  // Gate: require the shared secret so only the scheduler can invoke this.
  const secret = Deno.env.get("CRON_SECRET");
  if (secret) {
    const got = req.headers.get("x-cron-secret") ?? new URL(req.url).searchParams.get("secret");
    if (got !== secret) return new Response("forbidden", { status: 403 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const today = new Date().toISOString().slice(0, 10);
  let usersDone = 0, brandsDone = 0, rowsWritten = 0;

  // Only users who stored a Meta token can be tracked server-side.
  const { data: secrets } = await supabase
    .from("user_secrets")
    .select("user_id, meta_token, country")
    .not("meta_token", "is", null);

  for (const sec of secrets ?? []) {
    if (!sec.meta_token) continue;
    const { data: brands } = await supabase
      .from("brands")
      .select("id, name")
      .eq("user_id", sec.user_id)
      .eq("tracked", true);

    for (const brand of brands ?? []) {
      let ads: Ad[] = [];
      try {
        ads = await fetchBrandAds(sec.meta_token, sec.country || "DE", brand.id);
      } catch (_e) { continue; }
      if (!ads.length) continue;

      // Rank within the brand by reach (best public proxy for spend).
      ads.sort((a, b) => (b.eu_total_reach || 0) - (a.eu_total_reach || 0));

      const rows = ads.map((ad, i) => ({
        user_id: sec.user_id,
        brand_id: brand.id,
        snapshot_date: today,
        ad_id: String(ad.id),
        page_name: ad.page_name || brand.name,
        headline: (ad.ad_creative_link_titles?.[0] || ad.ad_creative_bodies?.[0] || "").slice(0, 300),
        reach: ad.eu_total_reach ?? null,
        impressions: null,
        runtime_days: runtimeDays(ad),
        is_active: !ad.ad_delivery_stop_time,
        rank: i + 1,
      }));

      const { error } = await supabase
        .from("brand_snapshots")
        .upsert(rows, { onConflict: "user_id,brand_id,snapshot_date,ad_id" });
      if (!error) rowsWritten += rows.length;
      brandsDone++;
    }
    usersDone++;
  }

  return Response.json({ ok: true, date: today, usersDone, brandsDone, rowsWritten });
});
