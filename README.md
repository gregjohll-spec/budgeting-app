# Steady Budget

A calm, simple envelope budgeting app for a two-adult household. You list your priorities (rent, food, bills), add money when it comes in, and the app suggests how to split it so each priority is ready by its due date.

- Works in a phone browser and can be added to the Home Screen (iPhone and Android).
- Both adults see and change the same data, and the app shows who changed what.
- FoodShare money only goes to food priorities, and housing assistance only to housing.
- It never connects to a bank and never moves money.

## Try it

Open `index.html` through any web server (for example `python3 -m http.server`). With no database details in `config.js`, the app runs in **example mode**: it shows made-up data that is saved only on that device.

## Connect the shared database (Supabase)

1. Create a free project at [supabase.com](https://supabase.com).
2. In the dashboard, open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and press **Run**.
3. Open **Authentication → URL Configuration**. Set **Site URL** to the address where the app is hosted (for example `https://<your-github-name>.github.io/budgeting-app/`) and add the same address under **Redirect URLs**.
4. Set up a sender for sign-in emails. Supabase's built-in sender only emails your Supabase team, about 2 an hour. For family and friends, connect your own under **Authentication → Emails → SMTP Settings** (this app uses Resend: host `smtp.resend.com`, port `465`, username `resend`, password = a Resend API key). The sender address must end in exactly the domain Resend verified, including any subdomain (for example `signin@updates.example.com`).
   Then edit both the **Confirm signup** email (first sign-in) and the **Magic Link** email (later sign-ins) and add this line, so people can type a code if the link opens in the wrong browser:
   `Or enter this code in the app: {{ .Token }}`
5. Open **Project Settings → API**. Copy the **Project URL** and the **publishable** key (older projects call it **anon public**) into `config.js`. Never put the secret or `service_role` key in this app.

The publishable key is meant to be public. Row-level security in `schema.sql` makes sure each person can only reach their own household's data.

## Turn on reminders

Reminders send a calm note to a phone when a bill is due soon and still needs money (once on the chosen day before, and again the day before it's due).

1. In Supabase, open **Edge Functions → Deploy a new function → Via Editor**. Name it `send-reminders`, replace the sample code with everything in `supabase/functions/send-reminders/index.ts`, and press **Deploy**.
2. Open the function's **Details** and turn **off** "Verify JWT with legacy secret" (or "Enforce JWT verification"), then save. The daily schedule calls it without signing in.
3. In the **SQL Editor**, run everything in `supabase/reminders.sql`. It adds the reminder tables and checks every day at 14:00 UTC (8 AM Central).
4. In the app, tap **Reminders → Turn on reminders**. On an iPhone, add the app to the Home Screen first (iOS 16.4 or newer).

## Host it (GitHub Pages)

In the repository on GitHub, open **Settings → Pages**, choose **Deploy from a branch**, pick `main` and `/ (root)`, and save. The app appears at `https://<your-github-name>.github.io/budgeting-app/` after a minute.

## Files

| File | What it does |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The screens |
| `budget.js` | The money math (suggested split, set-aside plan, due-date status) |
| `store.js` | Saving and loading: Supabase for real use, the device for example mode |
| `supabase/schema.sql` | Database tables, access rules, and household setup |
| `icons.js` | The line icons and progress rings |
| `supabase/reminders.sql`, `supabase/functions/send-reminders/` | Daily reminders before due dates |
| `sw.js`, `manifest.webmanifest`, `icons/` | Home Screen install and offline support |
| `vendor/` | A copy of supabase-js 2.45.4 (MIT license) |

## Tests

```
npm test
```
