import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { type MailchimpConfig, MailchimpClient, type ProfileRecord, subscriberHash, syncRecord } from "./mailchimp.ts";

const cfg: MailchimpConfig = { apiKey: "secret-us21", listId: "LIST1", waitlistStatus: "subscribed" };

function fake(status = 200) {
  const calls: { method: string; url: string; body: any }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url, body: init.body ? JSON.parse(init.body as string) : undefined });
    return new Response(status === 204 ? null : "{}", { status });
  }) as typeof fetch;
  return { calls, mc: new MailchimpClient(cfg, fn) };
}

const profile = (p: Partial<ProfileRecord>): ProfileRecord => ({
  kind: "profile", email: "a@b.com", old_email: null, display_name: "Ana Lee",
  pro_subscriber: true, marketing_opt_in: true, deletion_requested: false, ...p,
});

Deno.test("subscriber hash is md5 of lowercased email", () => {
  assertEquals(subscriberHash(" Ana@Example.COM "), "cdb9d6a1dddc375a09cc83e3001598dc");
});

Deno.test("waitlist signup upserts and tags", async () => {
  const { calls, mc } = fake();
  const r = await syncRecord(mc, cfg, { kind: "waitlist", name: "Ana Maria Lee", email: "Ana@x.com", source: "landing", wants_to_test: true });
  assertEquals(r.action, "upserted");
  assertEquals(calls[0].method, "PUT");
  assertEquals(calls[0].url, `https://us21.api.mailchimp.com/3.0/lists/LIST1/members/${subscriberHash("ana@x.com")}`);
  assertEquals(calls[0].body.status_if_new, "subscribed");
  assertEquals(calls[0].body.status, undefined);
  assertEquals(calls[0].body.merge_fields, { FNAME: "Ana", LNAME: "Maria Lee" });
  assertEquals(calls[1].body.tags.map((t: any) => t.name), ["waitlist", "source:landing", "beta-tester"]);
});

Deno.test("opted-in profile is subscribed with plan tag", async () => {
  const { calls, mc } = fake();
  await syncRecord(mc, cfg, profile({ pro_subscriber: false }));
  assertEquals(calls[0].body.status, "subscribed");
  assertEquals(calls[1].body.tags, [{ name: "app-user", status: "active" }, { name: "pro", status: "inactive" }]);
});

Deno.test("opt-out only unsubscribes, never creates", async () => {
  const { calls, mc } = fake(404);
  const r = await syncRecord(mc, cfg, profile({ marketing_opt_in: false }));
  assertEquals(r.action, "unsubscribed");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "PATCH");
});

Deno.test("deletion archives the member", async () => {
  const { calls, mc } = fake(204);
  const r = await syncRecord(mc, cfg, profile({ deletion_requested: true }));
  assertEquals(r.action, "archived");
  assertEquals(calls.map((c) => c.method), ["DELETE"]);
});

Deno.test("email change unsubscribes the old address first", async () => {
  const { calls, mc } = fake();
  await syncRecord(mc, cfg, profile({ old_email: "old@b.com" }));
  assertEquals(calls[0].method, "PATCH");
  assertEquals(calls[0].url.endsWith(subscriberHash("old@b.com")), true);
  assertEquals(calls[1].method, "PUT");
});

Deno.test("Mailchimp errors surface", async () => {
  const { mc } = fake(400);
  await assertRejects(() => syncRecord(mc, cfg, profile({})), Error, "400");
});

Deno.test("api key without data center is rejected", () => {
  let threw = false;
  try { new MailchimpClient({ ...cfg, apiKey: "nodc" }); } catch { threw = true; }
  assertEquals(threw, true);
});
