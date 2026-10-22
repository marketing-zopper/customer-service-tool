# Zopper Service Triage

Internal dashboard that pulls the website's contact-form submissions from Webflow (read-only), sorts them into **Partnership** or **Complaints / Enquiries**, and lets the marketing team notify the concerned person about any item by email, with the full details and a one-item magic link. There are no user accounts. Access is either the shared marketing password or a magic link.

- **Frontend:** React (JS) + Vite SPA, Poppins, lucide-react. CRM-style layout: a dark brand-blue translucent sidebar, a frosted-glass main panel with underlined status tabs and a search toolbar, and a data table (#, Sender, Query, Received, Status, Actions). On narrower screens each row becomes a compact card, and on phones the sidebar becomes a top bar.
- **Backend:** one Node router (`server/router.js`) served as a Vercel function (`api/index.js`) in production and by `server/dev.js` locally
- **Data:** Supabase Postgres, reached only through the backend with the service-role key
- **Classification:** keyword rules only (no AI service). Anything the rules can't place goes to **Partnership**, which is the catch-all; the team moves a wrong one to Complaints with one click.
- **Email out:** Resend

## Run locally

```bash
npm install
cp .env.example .env        # fill in the values, see below
# run the files in supabase/migrations/ in order (0001 to 0007) in the Supabase SQL editor
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
| `RESEND_API_KEY`, `MAIL_FROM` | sending notification emails | the modal shows the link so it can be shared by hand |
| `WEBFLOW_API_TOKEN`, `WEBFLOW_SITE_ID` | pulling form submissions | "Sync" reports "not configured" and nothing is imported |
| `WEBFLOW_FORMS`, `WEBFLOW_LOOKBACK_DAYS`, `WEBFLOW_MAX_PER_RUN` | which forms, how far back, batch size | the two lead forms, 90 days, 300 per run |

`MAIL_FROM` must use a domain verified in Resend. Until then Resend only delivers to your own account's address.

## Webflow form submissions

The two website forms **"Lead Generation (Contact Page)"** and **"Lead Generation (Component)"** are the only source (override with `WEBFLOW_FORMS`, names separated by `|`). Every other form on the site (newsletter, program sign-ups, quote forms) is ignored.

- **Read-only.** `server/lib/webflow.js` is the only code that talks to Webflow and it only sends `GET` requests. Nothing is created, edited, deleted or published on the Webflow site.
- Setup: Webflow → Site settings → Apps & integrations → API access → generate a site token (read access to forms is enough). Set `WEBFLOW_API_TOKEN` and `WEBFLOW_SITE_ID`.
- Two ways it runs, and nothing else (there is no scheduled job): (1) **automatically in the background whenever a marketing team member opens the dashboard** (or returns to a tab that has been idle), as a *quick* check that reads Webflow's newest page and stops at the first page with nothing new, usually one request of 1.5 to 4 seconds; (2) the **Sync** button, a *full sweep* of every page back to `WEBFLOW_LOOKBACK_DAYS`. A browser that has synced in the last 2 minutes doesn't repeat the automatic check, and shared-link visitors never trigger one. A submission that fails to process isn't recorded, so the next sync retries it (the quick check re-reads the newest page every time, so a failure is retried on the very next open). Each submission is stored once (de-duplicated as `webflow:<id>`); `WEBFLOW_LOOKBACK_DAYS` (default 90) bounds how far back the full sweep looks.
- Mapping: sender = Email, name = First + Last Name, subject = `Contact form – <Organisation>`, message = the form's free-text box (Webflow calls it "Field"). Organisation, designation and phone are appended to the full message. Sorting is based on the message only.

## Only new entries, ever

Every Webflow submission is recorded by id in `ingested_messages` the first time it's seen, whatever happens to it afterwards (stored, dropped as a job seeker, deleted, archived, moved). A sync only handles ids it hasn't recorded, so old items are never re-added, never overwritten, and a deleted item never returns. Overlapping syncs are safe because `source_id` is unique in the database. `server/test/ingest.test.js` covers this.

## Deploy (Vercel)

Import the repo, set the env vars above, deploy. `vercel.json` rewrites every non-`/api` path to the SPA and sends every `/api/...` request to the one API function. There is no cron job: entries are pulled when someone opens the dashboard, and whenever someone presses **Sync**, so nothing is imported while nobody is looking (the next visit catches up).

## How access works

- **Marketing team (5 people):** pick a name, enter the shared password. The server checks the name against `admin_names` and the password against `ADMIN_PASSWORD` (constant-time), then sets a signed, httpOnly, 30-day cookie carrying the name. That name is stored as `created_by` on any link they generate. Sessions can't be revoked individually, so rotate `SESSION_SECRET` to sign everyone out.
- **Magic link:** `/dashboard/<section>?token=…`. The token is 256 bits of randomness. Only its SHA-256 is stored. The page sends it in an `x-magic-token` header so it stays out of API logs. The backend checks it on every request: the link only works for its category, and an item-scoped link only for that one item. Link holders can change status but can't notify, move, archive or delete. An expired or unknown link shows the branded "access restricted" screen.
- **Everything else:** the sign-in screen.

## Defaults I chose for the open assumptions (change if wrong)

1. **Ingestion:** Webflow's form-submissions API, read when the dashboard is opened and when **Sync** is pressed (no scheduled job, no webhooks). An earlier version also read a Gmail mailbox; that was removed because only the website forms are used. It's in the git history (`server/lib/gmail.js`) if it's ever needed again.
2. **Admin access:** shared password plus name dropdown, as specified. There's no per-person revocation or rate limiting beyond a 600 ms delay on failed logins. Consider a longer, non-guessable password.
3. **Link expiry:** 7 days (`MAGIC_LINK_TTL_DAYS`).
4. **Email provider:** Resend.

## Deviations from the written spec

- `mail_items.category` is **nullable**, but only for leads (a check constraint enforces this). Leads are stored with `is_lead = true` and appear on neither tab. There's no UI for them yet; query `mail_items where is_lead`.
- There is no "Needs sorting" tab. Items the rules can't place are filed under Partnership. (The database enum still has an unused `unsorted` value; migration 0005 moved all such items to Partnership.)
- The `partnership_status` / `complaint_status` enums are replaced by one check constraint on `status` that allows the right values per category (and the API validates too).
- `magic_links.token` is stored as **`token_hash`** (SHA-256) so a database leak doesn't expose live links.
- Added `mail_items.source_id` and an `ingested_messages` table for de-duplication, including submissions that were ignored. (Column names still carry a `source` / `mail_` flavour from the earlier Gmail version.)
- Added an `ignore` outcome in classification: auto-replies, bounces, no-reply senders and job seekers aren't stored.
- Both tabs share one status set: **Active** (default), **In review**, **Notified**, **Resolved**. Pressing **Notify** (or choosing "Notified" in the dropdown, as a marketing user) opens the Notify form, sends the email and sets the status to Notified.

## How the rules classify

All in `server/lib/classify.js`; edit the keyword lists there to tune it. Each side is scored: a keyword in the subject counts 3, in the first 1,500 characters of the message counts 1 (capped at 6 hits). Clear complaint words ("refund", "not working"…) count fully; everyday service/insurance words ("claims", "policy", "service"…) count half because partnership pitches use them too. A side wins only with enough points (3, or 0.5 for a message under 300 characters) **and** at least twice the other side's score. Otherwise the item is filed under Partnership. A **lead** is purchase wording (quote, pricing, premium, group insurance, purchase…) with no partnership or complaint wording at all. Leads are hidden from both tabs, so if real messages are landing there, tighten `LEAD_RE`.

**Web-form senders with an executive title** (founder, CEO, director, VP, head, MD, partner…) at a named organisation, and no complaint wording, get a boost toward Partnership, so a one-line "Interested in the product" from a bank VP isn't left as an unsure guess. Everyday titles like "Manager" or "Owner" don't count (individual customers type them too), and junk like "NA" never does. This tie-breaker never applies to purchase/quote requests (those stay leads) or complaints.

**Job seekers and students** (internship, resume, vacancies, "work in your company", "join your company", wanting to become a POSP/agent/retailer, notice period…) are dropped entirely: never stored, shown on no tab, and recorded as "ignore" so they aren't re-imported. A message is only dropped if it has no strong complaint wording and fewer than two partnership terms, so a customer or business that happens to use one of those words still reaches the team. The list is `JOB_SEEKER_RE` in `server/lib/classify.js`.

**Archive / delete.** Admins can **Archive** an item on the Partnership and Complaints tabs: it leaves the active list (and its status is untouched) and appears under the tab's **Archived** toggle, where **Restore** brings it back. A magic link sent for one specific item still opens it after archiving. **Delete** exists only on Partnership (where anything unplaced lands), is permanent, and the sync remembers the item so it isn't re-imported. Complaints can be archived but not deleted.

Admins can correct any wrong guess with **Move to Partnership / Complaints** on a card. Moving an item resets its status to "Active".

## Search

The frosted search box next to each tab's title searches that tab (active or archived, whichever you're viewing): the sender's name and email, the subject, and the full message, which for website forms also contains the phone number, organisation and designation. Every word you type must match somewhere ("acme founder" finds items mentioning both), case doesn't matter, and symbols like `%` or `_` are searched literally. Press `/` to jump to it and `Esc` to clear it. Your search stays when you switch tabs. The filtering happens in the database (`server/lib/search.js`) after the same access checks as the normal list, so a shared link can never find items outside its own.

## Replies from the person notified

Someone who opens a notification link sees one item and a **"Your response"** panel (in the sidebar's empty space on wide screens, under the item on narrow ones) with a status dropdown and a comment box. One button saves both together (`POST /api/items/:id/respond`), so the team sees why the status changed, and saving is a single atomic database step (the `respond_to_item` function, migration 0007), so a comment can never be recorded without the status change it claims. The choices are Active, In review and Resolved ("Notified" is only shown while it's the current status). The row itself shows the status as a plain pill for them, so there's a single place to change it.

Comments are stored in `item_comments` (migration 0006) with who wrote them (the link's recipient email, or a team member's name), their role, the status they set, and the time. A status-only update is recorded too, but only written comments are counted. The team sees a "N comments" badge on the row, and the full thread, oldest first, when they open the item. A comment is plain text (up to 2,000 characters). The same rules as everywhere apply: a link can only reach its own item, and nothing is shown to anyone who couldn't already see that item.

## Notification emails

**Notify** emails the concerned person everything needed to act without opening the dashboard: the sender's name, email, phone, organisation and designation, when it was received (IST), which form it came from, the **complete message**, an optional note, and the one-item link. The form asks the marketing employee for **their own email (required)**: it is copied on the email and set as Reply-To, because the email itself is sent from the shared `MAIL_FROM` address. The address is remembered in that browser. If the email can't be sent, the item still becomes Notified but its card shows a red "Email … was not sent" warning, and the form shows the link to share by hand.

## Layout

```
api/index.js                 Vercel entry (vercel.json rewrites every /api/... path here), calls server/router.js
server/router.js             routes + handlers
server/lib/                  auth, supabase, webflow, ingest, classify, mail
server/test/                 node:test suites
supabase/migrations/         schema
src/                         React app (components/, api.js, sections.js, styles.css)
```
