import { db, unwrap } from './supabase.js';
import { envInt } from './config.js';
import { fetchSubmissions, submissionPages, webflowConfigured } from './webflow.js';
import { classifyEmail } from './classify.js';

const CONCURRENCY = 4;
const QUICK_MAX_PAGES = 5; // the automatic check never reads more than 500 submissions

async function mapLimit(items, limit, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) await fn(items[next++]);
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function filterUnseen(sourceIds) {
  const seen = new Set();
  for (let i = 0; i < sourceIds.length; i += 100) {
    const chunk = sourceIds.slice(i, i + 100);
    const rows = unwrap(await db().from('ingested_messages').select('source_id').in('source_id', chunk));
    for (const row of rows) seen.add(row.source_id);
  }
  return sourceIds.filter((id) => !seen.has(id));
}

/** Classifies one normalised item and stores it (and the fact that we've seen it). */
async function record(source, item) {
  const result = classifyEmail(item);

  if (result.outcome !== 'ignore') {
    const isLead = result.outcome === 'lead';
    unwrap(
      await db()
        .from('mail_items')
        .upsert(
          {
            source,
            source_id: item.sourceId,
            source_thread_id: item.sourceThreadId,
            category: isLead ? null : result.outcome,
            is_lead: isLead,
            subject: item.subject,
            sender_email: item.fromEmail,
            sender_name: item.fromName || null,
            body_snippet: result.snippet,
            body_full: item.body,
            received_at: item.receivedAt,
          },
          { onConflict: 'source_id', ignoreDuplicates: true },
        ),
    );
  }

  unwrap(
    await db()
      .from('ingested_messages')
      .upsert({ source, source_id: item.sourceId, outcome: result.outcome }, { onConflict: 'source_id' }),
  );
  return result.outcome;
}

const newSummary = (found, batchSize) => ({
  found,
  processed: 0,
  failed: 0,
  remaining: found - batchSize,
  outcomes: {},
});

async function runPool(source, ids, summary, load) {
  await mapLimit(ids, CONCURRENCY, async (id) => {
    try {
      const outcome = await record(source, await load(id));
      summary.processed += 1;
      summary.outcomes[outcome] = (summary.outcomes[outcome] || 0) + 1;
    } catch (error) {
      // Not recorded in ingested_messages, so the next run retries it.
      summary.failed += 1;
      console.error(`[ingest:${source}] ${id} failed:`, error.message);
    }
  });
}

/**
 * Full sweep: reads every page back to the lookback limit, so anything missed earlier is caught.
 * Quick: Webflow lists newest first, so read pages only until one has nothing new on it. That is
 * usually just the first page, and each page costs a few seconds. The daily run and the Sync
 * button do the full sweep, so a quick run never has to be perfect.
 */
async function ingestWebflow({ quick = false } = {}) {
  const lookbackDays = envInt('WEBFLOW_LOOKBACK_DAYS', 90);
  const cap = envInt('WEBFLOW_MAX_PER_RUN', 300);

  if (quick) {
    const summary = newSummary(0, 0);
    let pagesRead = 0;
    for await (const items of submissionPages(lookbackDays)) {
      pagesRead += 1;
      const bySourceId = new Map(items.map((item) => [item.sourceId, item]));
      const unseen = await filterUnseen([...bySourceId.keys()]);
      // Stop at a page that holds some of our entries and none new: we've reached ground we already
      // know. A page with none of our entries at all (all newsletter sign-ups, say) proves nothing,
      // so keep reading, within a small limit.
      if (items.length > 0 && unseen.length === 0) break;
      if (pagesRead >= QUICK_MAX_PAGES) break;
      summary.found += unseen.length;
      const room = Math.max(0, cap - summary.processed - summary.failed);
      await runPool('webflow', unseen.slice(0, room), summary, async (id) => bySourceId.get(id));
      if (summary.processed + summary.failed >= cap) break;
    }
    summary.remaining = summary.found - summary.processed - summary.failed;
    return summary;
  }

  const items = await fetchSubmissions(lookbackDays);
  const bySourceId = new Map(items.map((item) => [item.sourceId, item]));
  const unseen = await filterUnseen([...bySourceId.keys()]);
  const batch = unseen.slice(0, cap);
  const summary = newSummary(unseen.length, batch.length);
  await runPool('webflow', batch, summary, async (id) => bySourceId.get(id));
  return summary;
}

/** Pulls new website-form submissions, classifies them and stores them. Safe to re-run. */
export async function runIngest({ quick = false } = {}) {
  const sources = {};
  // One source today (Webflow forms); keep the list shape so another can be added.
  const jobs = [['webflow', webflowConfigured, ingestWebflow]];

  for (const [name, configured, run] of jobs) {
    if (!configured()) {
      sources[name] = { skipped: 'not configured' };
      continue;
    }
    try {
      sources[name] = await run({ quick });
    } catch (error) {
      console.error(`[ingest:${name}]`, error.message);
      sources[name] = { error: error.message };
    }
  }

  const done = Object.values(sources);
  return {
    processed: done.reduce((sum, s) => sum + (s.processed || 0), 0),
    failed: done.reduce((sum, s) => sum + (s.failed || 0), 0),
    sources,
  };
}
