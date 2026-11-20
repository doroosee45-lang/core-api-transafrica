import { createHmac, randomBytes } from "node:crypto";
import { env, setEnvForTests } from "../src/config/env.js";
import { setEmailTransportForTests } from "../src/integrations/email.js";
import { setupHarness, type Harness } from "./support/harness.js";

let h: Harness;
const SECRET = `whsec_${randomBytes(24).toString("base64")}`;

function signed(body: object, opts: { secret?: string; ts?: number; id?: string } = {}) {
  const raw = JSON.stringify(body);
  const id = opts.id ?? `msg_${randomBytes(6).toString("hex")}`;
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const key = Buffer.from((opts.secret ?? SECRET).slice(6), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
  return { raw, headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}`, "Content-Type": "application/json" } };
}

beforeAll(async () => {
  h = await setupHarness();
  setEnvForTests({ ...env(), RESEND_WEBHOOK_SECRET: SECRET });
  let n = 0;
  setEmailTransportForTests(async () => ({ status: "accepted", providerMessageId: `re_${++n}` }));
});
afterAll(async () => { setEmailTransportForTests(null); await h?.teardown(); });

describe("Webhook Resend : statut réel de délivrance (Cahier §8.7)", () => {
  it("accepté → délivré uniquement sur événement signé ; doublon ignoré ; signature falsifiée ou ancienne refusée", async () => {
    const w = await h.world();
    const agent = await h.makeUser("agent.wh@ta.test", { roles: [{ role: "canada_agent", scope_type: "agency", scope_id: w.cn }] });
    const c = await h.makeUser("dest@ta.test", { roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD" } });
    await h.api.post("/api/v1/canada/parcels").set(h.auth(await agent.token())).set(h.idem())
      .send({ client_id: c.clientId, recipient_name: "X", origin_country: "CN", destination_country: "CD", origin_agency_id: w.cn, received_now: false });
    const { runWorkerOnce } = await import("../src/modules/notifications/worker.js");
    await runWorkerOnce();
    const d = (await h.pool.query(`select id, status, provider_message_id from shared.notification_deliveries where channel = 'email' and destination = 'dest@ta.test'`)).rows[0];
    expect(d.status).toBe("accepted"); // accepté par le fournisseur ≠ délivré

    const ev = signed({ type: "email.delivered", data: { email_id: d.provider_message_id, to: ["dest@ta.test"] } });
    const ok = await h.api.post("/api/v1/webhooks/resend").set(ev.headers).send(ev.raw);
    expect(ok.body.data).toEqual({ duplicate: false, applied: true });
    expect((await h.pool.query(`select status, delivered_at from shared.notification_deliveries where id = $1`, [d.id])).rows[0].status).toBe("delivered");
    const again = await h.api.post("/api/v1/webhooks/resend").set(ev.headers).send(ev.raw);
    expect(again.body.data.duplicate).toBe(true);

    const forged = signed({ type: "email.bounced", data: { email_id: d.provider_message_id, to: ["dest@ta.test"] } }, { secret: `whsec_${randomBytes(24).toString("base64")}` });
    expect((await h.api.post("/api/v1/webhooks/resend").set(forged.headers).send(forged.raw)).status).toBe(400);
    const old = signed({ type: "email.bounced", data: { email_id: d.provider_message_id } }, { ts: Math.floor(Date.now() / 1000) - 3600 });
    expect((await h.api.post("/api/v1/webhooks/resend").set(old.headers).send(old.raw)).status).toBe(400);
  });

  it("rebond : adresse ajoutée à la liste de suppression, envois suivants « skipped »", async () => {
    const b = signed({ type: "email.bounced", data: { email_id: "re_unknown", to: ["Bounce@Example.org"], bounce: { message: "Mailbox does not exist" } } });
    expect((await h.api.post("/api/v1/webhooks/resend").set(b.headers).send(b.raw)).status).toBe(200);
    expect((await h.pool.query(`select reason from shared.email_suppressions where email_normalized = 'bounce@example.org'`)).rows[0].reason).toBe("bounced");
  });

  it("RLS : documents et réclamations inaccessibles aux rôles Supabase exposés", async () => {
    const c = await h.pool.connect();
    try {
      for (const table of ["canada.documents", "canada.support_tickets", "canada.support_messages", "canada.payment_parcels"]) {
        await c.query("begin");
        await c.query("set local role authenticated");
        await expect(c.query(`select * from ${table}`)).rejects.toThrow(/permission denied/);
        await c.query("rollback");
      }
    } finally { c.release(); }
  });
});
