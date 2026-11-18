# Mnemos — Konten & Rank-Tracking einrichten (Supabase)

Mnemos speichert Brands, Swipe File und Ordner jetzt **in einem Konto** statt nur
im Browser — geräteübergreifend gesichert. Außerdem misst der **Radar** täglich das
Impressions-Ranking deiner Brands (Parker-Style).

Du hast die zwei Zugangsdaten schon eingetragen (`supabase-config.js`):

```js
url:     'https://<your-project-ref>.supabase.co'
anonKey: 'sb_publishable_…'   // öffentlich, durch Row-Level-Security geschützt
```

Es fehlt nur noch **ein Schritt**, dann funktionieren Konten sofort.

---

## Schritt 1 — Tabellen anlegen (Pflicht, ~1 Minute)

1. Supabase-Dashboard öffnen → dein Projekt → **SQL Editor** → **New query**
2. Den kompletten Inhalt von [`supabase/schema.sql`](supabase/schema.sql) einfügen
3. **Run** klicken

Das legt die Tabellen `brands`, `folders`, `saved_ads`, `brand_snapshots`,
`user_secrets` an — alle mit Row-Level-Security, sodass jeder Nutzer nur seine
eigenen Daten sieht. Danach: Mnemos neu laden → **Anmelden** → Konto erstellen. Fertig.

> Prüfen, ob es geklappt hat: in Mnemos oben rechts auf **Anmelden**. Wenn kein
> „nicht konfiguriert"-Hinweis erscheint und du dich registrieren kannst, läuft alles.

---

## Schritt 2 — E-Mail-Bestätigung (optional)

Standardmäßig verlangt Supabase eine E-Mail-Bestätigung bei der Registrierung.
Mnemos kommt damit klar (zeigt „bestätige deine E-Mail, dann einloggen").

Willst du, dass Nutzer **sofort ohne Bestätigung** loslegen:
Dashboard → **Authentication → Providers → Email** → *Confirm email* **aus**.

Optional Google-Login: gleicher Ort → **Google** aktivieren und Client-ID/Secret hinterlegen.

---

## Schritt 3 — Tägliches Auto-Tracking rund um die Uhr (optional)

Ohne diesen Schritt funktioniert der Radar trotzdem: Mnemos macht **bei jedem
Öffnen** der App einen Snapshot pro getrackter Brand (max. 1× pro Tag). So baut
sich der Verlauf auf, solange du die App regelmäßig nutzt.

Für echte 24/7-Messung (auch wenn niemand die App offen hat):

1. **Supabase CLI** installieren und einloggen
   ```bash
   npm i -g supabase
   supabase login
   supabase link --project-ref <your-project-ref>
   ```
2. **Edge Function deployen**
   ```bash
   supabase functions deploy track-brands --no-verify-jwt
   ```
3. **Cron-Secret setzen** (frei wählbarer, langer String)
   ```bash
   supabase secrets set CRON_SECRET=dein-langer-zufalls-string
   ```
4. Im Dashboard → **Database → Extensions**: `pg_cron` und `pg_net` aktivieren.
5. Im **SQL Editor** [`supabase/schema-cron.sql`](supabase/schema-cron.sql) öffnen,
   `<PROJECT_REF>` und `<CRON_SECRET>` ersetzen, **Run**.

Der serverseitige Tracker braucht deinen **Meta-Token**. Den speicherst du bewusst
über **Konto → „Meta-Token für tägliches Auto-Tracking speichern"** (nur wenn ein
Token hinterlegt ist). Er landet in `user_secrets` (RLS-geschützt, nur du + die
Function per Service-Role).

---

## Wie das Ranking gemessen wird

Die Meta Ad Library gibt für kommerzielle Ads keine exakten Impressionen her.
Mnemos nutzt das ehrlichste öffentliche Signal — **EU-Reichweite** (bzw.
ScrapeCreators-Impressionen außerhalb der EU) — und berechnet daraus **täglich einen
Rang pro Ad innerhalb der Brand**. Wer über Tage oben bleibt, gibt Geld aus = Winner.

Der Radar zeigt pro Brand: Rang, Trend ggü. Vortag (▲/▼/NEU), Reichweite, Laufzeit,
Winner-Badge 🏆 und eine Sparkline des Rang-Verlaufs.

---

## Dateien

| Datei | Zweck |
|---|---|
| `supabase-config.js` | URL + Public Key (bereits ausgefüllt) |
| `supabase-sync.js` | Cloud-Layer: Auth, Sync, Snapshots (`window.MnemosCloud`) |
| `supabase/schema.sql` | Tabellen + Row-Level-Security (**Schritt 1**) |
| `supabase/functions/track-brands/index.ts` | Optionaler täglicher Tracker |
| `supabase/schema-cron.sql` | Optionaler Cron-Zeitplan |

Ohne ausgefüllte `supabase-config.js` läuft Mnemos wie bisher im reinen
Gast-Modus (localStorage) weiter — nichts geht kaputt.
