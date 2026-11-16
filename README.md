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
4. Open **Authentication → Email Templates → Magic Link** and add this line to the message, so people can type a code if the link opens in the wrong browser:
   `Or enter this code in the app: {{ .Token }}`
5. Open **Project Settings → API**. Copy the **Project URL** and the **publishable** key (older projects call it **anon public**) into `config.js`. Never put the secret or `service_role` key in this app.

The publishable key is meant to be public. Row-level security in `schema.sql` makes sure each person can only reach their own household's data.

## Host it (GitHub Pages)

In the repository on GitHub, open **Settings → Pages**, choose **Deploy from a branch**, pick `main` and `/ (root)`, and save. The app appears at `https://<your-github-name>.github.io/budgeting-app/` after a minute.

## Files

| File | What it does |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The screens |
| `budget.js` | The money math (suggested split, set-aside plan, due-date status) |
| `store.js` | Saving and loading: Supabase for real use, the device for example mode |
| `supabase/schema.sql` | Database tables, access rules, and household setup |
| `sw.js`, `manifest.webmanifest`, `icons/` | Home Screen install and offline support |
| `vendor/` | A copy of supabase-js 2.45.4 (MIT license) |

## Tests

```
npm test
```
