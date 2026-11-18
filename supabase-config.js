/* ============================================================
   Mnemos — Supabase connection config
   ------------------------------------------------------------
   Fill in the two values from your Supabase project:
     Dashboard → Project Settings → API
       • Project URL   → url
       • anon / public → anonKey   (safe to expose; RLS protects data)

   Leave them blank to run Mnemos in guest-only mode (localStorage,
   no accounts) exactly like before.
   ============================================================ */
window.MNEMOS_SUPABASE = {
    url: '',
    anonKey: ''
};
