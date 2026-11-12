// Mailchimp Marketing API client and the sync rules for CardCue Pro.
// Kept free of Supabase imports so it can be tested with a fake fetch.

import { createHash } from "node:crypto";

export type Fetch = typeof fetch;

export interface MailchimpConfig {
  apiKey: string; // "<key>-us21": the suffix is the data center
  listId: string; // audience id
  waitlistStatus: "subscribed" | "pending"; // pending = Mailchimp sends a confirm email
}

export interface WaitlistRecord {
  kind: "waitlist";
  name: string | null;
  email: string;
  source: string | null;
  wants_to_test: boolean | null;
}

export interface ProfileRecord {
  kind: "profile";
  email: string | null;
  old_email: string | null; // email before this update, when it changed
  display_name: string | null;
  pro_subscriber: boolean | null;
  marketing_opt_in: boolean;
  deletion_requested: boolean;
}

export type SyncRecord = WaitlistRecord | ProfileRecord;

export type SyncResult =
  | { action: "upserted"; email: string }
  | { action: "unsubscribed"; email: string }
  | { action: "archived"; email: string }
  | { action: "skipped"; reason: string };

export function subscriberHash(email: string): string {
  return createHash("md5").update(email.trim().toLowerCase()).digest("hex");
}

export function splitName(full: string | null): { FNAME: string; LNAME: string } {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  return { FNAME: parts[0] ?? "", LNAME: parts.slice(1).join(" ") };
}

export class MailchimpClient {
  private base: string;
  private auth: string;

  constructor(private cfg: MailchimpConfig, private fetchFn: Fetch = fetch) {
    const dc = cfg.apiKey.split("-").pop();
    if (!dc || dc === cfg.apiKey) throw new Error("MAILCHIMP_API_KEY must end in -<dc>, e.g. -us21");
    this.base = `https://${dc}.api.mailchimp.com/3.0/lists/${cfg.listId}/members`;
    this.auth = "Basic " + btoa(`cardcue:${cfg.apiKey}`);
  }

  private async call(method: string, path: string, body?: unknown, okStatuses: number[] = []) {
    const res = await this.fetchFn(this.base + path, {
      method,
      headers: { Authorization: this.auth, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok || okStatuses.includes(res.status)) {
      await res.body?.cancel();
      return res.status;
    }
    const text = await res.text();
    throw new Error(`Mailchimp ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  }

  /** Create or update a member. status only applies to new members unless forceStatus. */
  upsert(email: string, status: string, mergeFields: Record<string, string>, forceStatus = false) {
    const body: Record<string, unknown> = {
      email_address: email.trim(),
      status_if_new: status,
      merge_fields: mergeFields,
    };
    if (forceStatus) body.status = status;
    return this.call("PUT", `/${subscriberHash(email)}`, body);
  }

  setTags(email: string, tags: Record<string, boolean>) {
    return this.call("POST", `/${subscriberHash(email)}/tags`, {
      tags: Object.entries(tags).map(([name, on]) => ({ name, status: on ? "active" : "inactive" })),
    });
  }

  /** Unsubscribe an existing member; a 404 (never in the audience) is fine. */
  unsubscribe(email: string) {
    return this.call("PATCH", `/${subscriberHash(email)}`, { status: "unsubscribed" }, [404]);
  }

  /** Archive (not permanently delete) a member; a 404 is fine. */
  archive(email: string) {
    return this.call("DELETE", `/${subscriberHash(email)}`, undefined, [404]);
  }
}

export async function syncRecord(mc: MailchimpClient, cfg: MailchimpConfig, r: SyncRecord): Promise<SyncResult> {
  if (r.kind === "waitlist") {
    if (!r.email?.includes("@")) return { action: "skipped", reason: "no email" };
    await mc.upsert(r.email, cfg.waitlistStatus, splitName(r.name));
    const tags: Record<string, boolean> = { waitlist: true };
    if (r.source) tags[`source:${r.source}`.slice(0, 100)] = true;
    if (r.wants_to_test) tags["beta-tester"] = true;
    await mc.setTags(r.email, tags);
    return { action: "upserted", email: r.email };
  }

  // Profile: the account's email moved, so stop mailing the old address.
  if (r.old_email && r.old_email.toLowerCase() !== (r.email ?? "").toLowerCase()) {
    await mc.unsubscribe(r.old_email);
  }
  if (!r.email?.includes("@")) return { action: "skipped", reason: "no email" };

  if (r.deletion_requested) {
    await mc.archive(r.email);
    return { action: "archived", email: r.email };
  }
  if (!r.marketing_opt_in) {
    // Never adds anyone; only takes back a previous opt-in.
    await mc.unsubscribe(r.email);
    return { action: "unsubscribed", email: r.email };
  }
  // The user opted in inside the app, so set them subscribed even if they had unsubscribed before.
  await mc.upsert(r.email, "subscribed", splitName(r.display_name), true);
  await mc.setTags(r.email, { "app-user": true, pro: !!r.pro_subscriber });
  return { action: "upserted", email: r.email };
}
