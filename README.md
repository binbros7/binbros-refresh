# Bin Bros Dashboard Refresh — GitHub Actions

Fully automated, hands-off refresh of both Bin Bros dashboards.

GitHub spins up Ubuntu + headless Chromium twice a day (06:00 + 20:00 SAST), logs into Bin Bros, scrapes **everything** (clients, profiles with estate/bins/street, contacts/phones, invoices, payments, and optionally AddPay), then redeploys both Netlify sites — all in one ~3 minute run.

**Zero ongoing cost.** GitHub Actions includes 2 000 minutes/month free on private repos; this workflow uses ~3 min/run × 2 runs/day × 30 days ≈ 180 min/month.

---

## Setup — first time only

### 1. Create a GitHub account (skip if you already have one)

Sign up at https://github.com/signup. Free.

### 2. Create a new **private** repo

In the top-right plus menu → **New repository**:

- Name: `binbros-refresh` (any name is fine — must be **Private**)
- Initialize with: nothing (no README, no .gitignore, no license — this folder has them already)
- Click **Create repository**

### 3. Push this folder to the repo

In Terminal on your Mac:

```bash
cd path/to/binbros-github-actions
git init
git add .
git commit -m "Initial: Bin Bros refresh workflow"
git branch -M main
git remote add origin git@github.com:<your-username>/binbros-refresh.git
git push -u origin main
```

If you don't have `git` set up with SSH, use the HTTPS variant GitHub shows you on the empty-repo page. If `npm` is missing or you've never used Node on this Mac, install it once: `brew install node`.

Once pushed, you should be able to refresh the GitHub repo page in your browser and see the files.

### 4. Add the secrets

In the GitHub repo, click **Settings → Secrets and variables → Actions → New repository secret**. Add each of these (one at a time):

| Secret name           | Value                                                            |
|-----------------------|------------------------------------------------------------------|
| `BINBROS_EMAIL`       | your Bin Bros admin login email                                  |
| `BINBROS_PASSWORD`    | your Bin Bros admin password                                     |
| `DASHBOARD_PASSWORD`  | `Bin#Bro#123` (the AES key used to encrypt the dashboard data)   |
| `NETLIFY_TOKEN`       | `nfp_H8HhNi2Dat7gyKsEjspVE2mHtzs4w9zv1cb1` (Netlify PAT)         |
| `ADDPAY_EMAIL`        | *optional* — your AddPay admin email (skip to disable AddPay)    |
| `ADDPAY_PASSWORD`     | *optional* — your AddPay admin password                          |

GitHub stores these encrypted at rest. They're injected into the workflow run as environment variables and never logged.

### 5. Test it

Open the repo in GitHub → **Actions** tab → **Bin Bros Dashboard Refresh** → **Run workflow** (dropdown on the right) → **Run workflow**. Click into the run; you'll see step-by-step logs. The whole thing should take 2–3 minutes.

On success, the dashboards on both Netlify URLs will be updated with the latest data — hard-reload to confirm.

If the AddPay step is configured, you'll see lines like:

```
[2026-06-02T18:13:42.000Z] Scraping clients table
[2026-06-02T18:13:50.000Z] Clients: {"stage":"clients","count":160}
[2026-06-02T18:14:30.000Z] Profiles: {"stage":"profiles+contacts","profiles":160,"withPhone":133}
...
[2026-06-02T18:16:01.000Z] Deploy: {"mdb":"ready","odb":"ready","totals":{...}}
```

After the first successful run, the cron takes over and fires automatically twice a day. Nothing on your Mac needs to be running.

---

## Watching it

- **GitHub Actions tab** — see every run, success or failure
- **Run summary artifact** — every run uploads a `run-summary.json` (and `run-error.log` if it failed) artifact, retained 14 days
- **Notifications** — GitHub emails you when a scheduled run fails (Settings → Notifications → Actions → Workflows in repos owned by me)

---

## Updating the workflow

Just edit the file and `git push`. The next scheduled run uses the new code.

To pause: comment out the `schedule:` block in `.github/workflows/refresh.yml`, push. Or **disable** the workflow from the Actions tab.

To rotate a credential: change the secret in **Settings → Secrets and variables → Actions**. Takes effect on the next run.

---

## How it works

The driver script `scripts/refresh.mjs`:

1. Fetches the **latest** `refresh.js` from the deployed Netlify dashboard. This is the same scrape+encrypt+deploy module that the browser-based pipeline uses, so the two stay perfectly in sync.
2. Launches headless Chromium via Playwright.
3. Drives the browser through each scrape stage (clients → profiles+contacts → invoices → payments → optionally AddPay).
4. Calls `binbrosDeploy()` inside the page, which builds the dashboard data, reconciles AddPay if present, encrypts with AES-GCM, and deploys both Netlify sites via the Netlify Deploy API.

Per run it makes roughly 350–400 HTTP calls to Bin Bros (one per client for profile + contacts) plus a handful to AddPay and Netlify — well within GitHub Actions' generous limits.

---

## Cleanup of the old browser-based scheduler

Once this workflow is running cleanly for a couple of days, you can disable the local `binbros-dashboard-refresh` scheduled task (the one that needs Chrome open on your Mac) — either through Cowork's task list, or by editing the schedule SKILL. Up to you. There's no harm in running both.
