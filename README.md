# Zopper Service Triage

Internal dashboard that pulls emails from `marketingext@zopper.com`, sorts them into **Partnership** or **Complaints / Enquiries**, and lets the marketing team escalate any item to the concerned person through a one-item magic link. There are no user accounts. Access is either the shared marketing password or a magic link.

- **Frontend:** React (JS) + Vite SPA, Poppins, lucide-react
- **Backend:** one Node router (`server/router.js`) served as a Vercel function (`api/[...route].js`) in production and by `server/dev.js` locally
- **Data:** Supabase Postgres, reached only through the backend with the service-role key
- **Classification:** keyword rules only (no AI service). Mail the rules can't place goes to an admin-only **Needs sorting** tab, where the team moves it to the right tab with one click.
- **Email out:** Resend

## Run locally

```bash
npm install
cp .env.example .env        # fill in the values, see below
# run the files in supabase/migrations/ in order (0001, 0002) in the Supabase SQL editor
npm run dev                 # web on :5173, API on :8787 (Vite proxies /api)
npm test                    # access-control + classifier tests (no network or keys needed)
```

Minimum to see the dashboard: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_PASSWORD`, `SESSION_SECRET`. Everything else degrades gracefully (see the table).

## Environment variables

| Variable | Needed for | If missing |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | everything | API returns 500 |
| `ADMIN_PASSWORD` | the shared marketing password | login fails with 500 |
| `SESSION_SECRET` | signing the admin cookie (32+ chars) | login fails with 500 |
| `APP_URL` | magic links and the logo in emails | defaults to `http://localhost:5173` |
| `MAGIC_LINK_TTL_DAYS` | link expiry | 7 |
| `RESEND_API_KEY`, `MAIL_FROM` | sending escalation emails | the modal shows the link so it can be shared by hand |
| `GMAIL_MAILBOX`, `GOOGLE_SERVICE_ACCOUNT_JSON` | ingestion | "Sync" fails; items can only be added to the DB by hand |
| `CRON_SECRET` | scheduled `/api/ingest` | only an admin can trigger sync |
| `INGEST_LOOKBACK_DAYS`, `INGEST_MAX_PER_RUN` | ingestion window and batch size | 3 days, 20 per run |

`MAIL_FROM` must use a domain verified in Resend. Until then Resend only delivers to your own account's address.

## Gmail ingestion setup (one-off)

The credentials come from **Google Cloud Console**, but one step happens in the **Google Workspace Admin console** (step 3) and needs a Workspace super admin. `marketingext@zopper.com` must be a Google Workspace mailbox.

1. In [Google Cloud Console](https://console.cloud.google.com), create a project and enable the **Gmail API** (APIs & Services → Library).
2. IAM & Admin → Service Accounts → create one → Keys → Add key → JSON. Keep the file private. Note the service account's numeric **Client ID** (Details tab → Advanced settings).
3. In [Workspace Admin](https://admin.google.com) → Security → Access and data control → API controls → **Domain-wide delegation** → Add new, with that Client ID and the scope `https://www.googleapis.com/auth/gmail.readonly`.
4. Set `GOOGLE_SERVICE_ACCOUNT_JSON` to the key file's contents (raw JSON, or base64 of it) and `GMAIL_MAILBOX=marketingext@zopper.com`.
5. Set `CRON_SECRET` to a random string and deploy.

Each run looks at the inbox for the last `INGEST_LOOKBACK_DAYS` days, skips anything already recorded in `ingested_messages`, and processes up to `INGEST_MAX_PER_RUN` new messages. A message that fails to process isn't recorded, so the next run retries it.

## Webflow form submissions

The two website forms **"Lead Generation (Contact Page)"** and **"Lead Generation (Component)"** are pulled in alongside Gmail (override with `WEBFLOW_FORMS`, names separated by `|`). Every other form on the site (newsletter, program sign-ups, quote forms) is ignored.

- **Read-only.** `server/lib/webflow.js` is the only code that talks to Webflow and it only sends `GET` requests. Nothing is created, edited, deleted or published on the Webflow site.
- Setup: Webflow → Site settings → Apps & integrations → API access → generate a site token (read access to forms is enough). Set `WEBFLOW_API_TOKEN` and `WEBFLOW_SITE_ID`.
- Runs in the same daily job and **Sync** button as Gmail. Each submission is stored once (de-duplicated as `webflow:<id>`); `WEBFLOW_LOOKBACK_DAYS` (default 90) bounds how far back it looks.
- Mapping: sender = Email, name = First + Last Name, subject = `Contact form – <Organisation>`, message = the form's free-text box (Webflow calls it "Field"). Organisation, designation and phone are appended to the full message. Sorting is based on the message only.

## Only new entries, ever

Every Gmail message and Webflow submission is recorded by id in `ingested_messages` the first time it's seen, whatever happens to it afterwards (stored, dropped as a job seeker, deleted, archived, moved). A sync only handles ids it hasn't recorded, so old items are never re-added, never overwritten, and a deleted item never returns. Overlapping syncs are safe because `source_id` is unique in the database. `server/test/ingest.test.js` covers this.

## Deploy (Vercel)

Import the repo, set the env vars above, deploy. `vercel.json` rewrites every non-`/api` path to the SPA and runs `/api/ingest` once a day at 04:00 UTC (09:30 IST), which fits Vercel's free plan. Admins can also press **Sync** in the dashboard at any time to pull new mail immediately.

## How access works

- **Marketing team (5 people):** pick a name, enter the shared password. The server checks the name against `admin_names` and the password against `ADMIN_PASSWORD` (constant-time), then sets a signed, httpOnly, 30-day cookie carrying the name. That name is stored as `created_by` on any link they generate. Sessions can't be revoked individually, so rotate `SESSION_SECRET` to sign everyone out.
- **Magic link:** `/dashboard/<section>?token=…`. The token is 256 bits of randomness. Only its SHA-256 is stored. The page sends it in an `x-magic-token` header so it stays out of API logs. The backend checks it on every request: the link only works for its category, and an item-scoped link only for that one item. Link holders can change status but can't escalate. An expired or unknown link shows the branded "access restricted" screen.
- **Everything else:** the sign-in screen.

## Defaults I chose for the open assumptions (change if wrong)

1. **Ingestion:** Gmail API polling (daily, plus the Sync button) with a delegated service account, not Pub/Sub push. If the mailbox is on Exchange/Outlook, replace `server/lib/gmail.js`; the rest is unchanged.
2. **Admin access:** shared password plus name dropdown, as specified. There's no per-person revocation or rate limiting beyond a 600 ms delay on failed logins. Consider a longer, non-guessable password.
3. **Link expiry:** 7 days (`MAGIC_LINK_TTL_DAYS`).
4. **Email provider:** Resend.

## Deviations from the written spec

- `mail_items.category` is **nullable**, but only for leads (a check constraint enforces this). Leads are stored with `is_lead = true` and appear on neither tab. There's no UI for them yet; query `mail_items where is_lead`.
- Added a third category, **`unsorted`**, shown on an admin-only "Needs sorting" tab (magic links can never reach it). Items there can't be escalated until they're moved to Partnership or Complaints / Enquiries.
- The `partnership_status` / `complaint_status` enums are replaced by one check constraint on `status` that allows the right values per category (and the API validates too).
- `magic_links.token` is stored as **`token_hash`** (SHA-256) so a database leak doesn't expose live links.
- Added `mail_items.gmail_message_id` / `gmail_thread_id` and an `ingested_messages` table for de-duplication, including messages that were ignored.
- Added an `ignore` outcome in classification: auto-replies, bounces and no-reply senders aren't stored.
- Choosing "Escalated to team" in the dropdown opens the escalate dialog for marketing users, since escalation needs a recipient. Escalating a partnership records the recipient but leaves its status alone (there's no escalated state for partnerships).

## How the rules classify

All in `server/lib/classify.js`; edit the keyword lists there to tune it. Each side is scored: a keyword in the subject counts 3, in the first 1,500 characters of the message counts 1 (capped at 6 hits). Clear complaint words ("refund", "not working"…) count fully; everyday service/insurance words ("claims", "policy", "service"…) count half because partnership pitches use them too. A side wins only with enough points (3, or 0.5 for a message under 300 characters) **and** at least twice the other side's score. Otherwise the item goes to Needs sorting. A **lead** is purchase wording (quote, pricing, premium, group insurance, purchase…) with no partnership or complaint wording at all. Leads are hidden from both tabs, so if real messages are landing there, tighten `LEAD_RE`.

**Web-form senders with an executive title** (founder, CEO, director, VP, head, MD, partner…) at a named organisation, and no complaint wording, get a boost toward Partnership, so a one-line "Interested in the product" from a bank VP isn't lost in Needs sorting. Everyday titles like "Manager" or "Owner" don't count (individual customers type them too), and junk like "NA" never does. This tie-breaker never applies to purchase/quote requests (those stay leads) or complaints.

**Job seekers and students** (internship, resume, vacancies, "work in your company", "join your company", wanting to become a POSP/agent/retailer, notice period…) are dropped entirely: never stored, shown on no tab, and recorded as "ignore" so they aren't re-imported. A message is only dropped if it has no strong complaint wording and fewer than two partnership terms, so a customer or business that happens to use one of those words still reaches the team. The list is `JOB_SEEKER_RE` in `server/lib/classify.js`.

**Archive / delete.** Admins can **Archive** an item on the Partnership and Complaints tabs: it leaves the active list (and its status is untouched) and appears under the tab's **Archived** toggle, where **Restore** brings it back. A magic link sent for one specific item still opens it after archiving. **Delete** exists only on Needs sorting, is permanent, and the sync remembers the item so it isn't re-imported.

Admins can correct any wrong guess with **Move to Partnership / Complaints** on a card. Moving an item resets its status to "In review".

## Layout

```
api/[...route].js            Vercel entry, calls server/router.js
server/router.js             routes + handlers
server/lib/                  auth, supabase, gmail, ingest, classify, mail
server/test/                 node:test suites
supabase/migrations/         schema
src/                         React app (components/, api.js, sections.js, styles.css)
```
