// mailchimp-sync: pushes CardCue Pro waitlist signups and opted-in app users
// into a Mailchimp audience.
//
// Called by:
//   * the waitlist_mailchimp_sync / profiles_mailchimp_sync triggers (pg_net), one record per call
//   * a person, for a backfill:  POST {"backfill": true}
// Both must send the service role key as the bearer token.
//
// Secrets (supabase secrets set ...):
//   MAILCHIMP_API_KEY            e.g. abc123...-us21
//   MAILCHIMP_LIST_ID            the audience id
//   MAILCHIMP_WAITLIST_STATUS    optional: "subscribed" (default) or "pending" for double opt-in

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { MailchimpClient, type MailchimpConfig, type SyncRecord, syncRecord } from "./mailchimp.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function config(): MailchimpConfig {
  const apiKey = Deno.env.get("MAILCHIMP_API_KEY") ?? "";
  const listId = Deno.env.get("MAILCHIMP_LIST_ID") ?? "";
  if (!apiKey || !listId) throw new Error("MAILCHIMP_API_KEY and MAILCHIMP_LIST_ID must be set");
  const s = Deno.env.get("MAILCHIMP_WAITLIST_STATUS");
  return { apiKey, listId, waitlistStatus: s === "pending" ? "pending" : "subscribed" };
}

async function backfill(mc: MailchimpClient, cfg: MailchimpConfig) {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const records: SyncRecord[] = [];

  const { data: wl, error: e1 } = await db.from("waitlist").select("name, email, source, wants_to_test");
  if (e1) throw e1;
  for (const w of wl ?? []) records.push({ kind: "waitlist", ...w });

  // Only opted-in accounts with no pending deletion. Everyone else is left out of Mailchimp.
  const { data: pr, error: e2 } = await db
    .from("profiles")
    .select("email, display_name, pro_subscriber")
    .eq("marketing_opt_in", true)
    .is("deletion_requested_at", null);
  if (e2) throw e2;
  for (const p of pr ?? []) {
    records.push({ kind: "profile", old_email: null, marketing_opt_in: true, deletion_requested: false, ...p });
  }

  const counts: Record<string, number> = {};
  const errors: string[] = [];
  for (const r of records) {
    try {
      const res = await syncRecord(mc, cfg, r);
      counts[res.action] = (counts[res.action] ?? 0) + 1;
    } catch (err) {
      errors.push(String(err));
    }
  }
  return { total: records.length, counts, errors: errors.slice(0, 20), error_count: errors.length };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  // verify_jwt lets any signed-in user through; this function is for the server only.
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceKey || req.headers.get("Authorization") !== `Bearer ${serviceKey}`) {
    return json(401, { error: "service role only" });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid JSON" });
  }

  try {
    const cfg = config();
    const mc = new MailchimpClient(cfg);
    if (body.backfill === true) return json(200, await backfill(mc, cfg));
    if (body.kind !== "waitlist" && body.kind !== "profile") return json(400, { error: "kind must be waitlist or profile" });
    const result = await syncRecord(mc, cfg, body as unknown as SyncRecord);
    console.log("mailchimp-sync", body.kind, result.action);
    return json(200, result);
  } catch (err) {
    // Log the message without the record's email.
    console.error("mailchimp-sync failed:", String(err).replace(/[^\s@]+@[^\s@]+/g, "<email>"));
    return json(502, { error: "sync failed" });
  }
});
