import { randomUUID } from "node:crypto";
import { setupHarness, type Harness } from "./support/harness.js";

let h: Harness;
let w: Awaited<ReturnType<Harness["world"]>>;
let admin: any, agent: any, client: any;
const token = async (u: any, aal?: "aal1" | "aal2") => h.auth(await u.token(aal));

beforeAll(async () => {
  h = await setupHarness();
  w = await h.world();
  admin = await h.makeUser("audit.atomicity.admin@ta.test", {
    mfa: true, roles: [{ role: "canada_administrator", scope_type: "global" }],
  });
  agent = await h.makeUser("audit.atomicity.agent@ta.test", {
    roles: [{ role: "canada_agent", scope_type: "agency", scope_id: w.cn }],
  });
  client = await h.makeUser("audit.atomicity.client@ta.test", {
    roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD" },
  });
});
afterAll(async () => { await h?.teardown(); });

it("rolls a catalog insert back when its required audit write fails", async () => {
  const iata = randomUUID().replace(/-/g, "").slice(0, 2).toUpperCase();
  const name = `Audit rollback ${randomUUID()}`;
  await h.pool.query(`create function public.fail_catalog_audit_probe() returns trigger language plpgsql as $$
    begin raise exception 'injected audit failure'; end $$`);
  await h.pool.query(`create trigger fail_catalog_audit_probe before insert on audit.audit_events
    for each row when (new.action = 'canada.airline.created') execute function public.fail_catalog_audit_probe()`);

  const response = await h.api.post("/api/v1/canada/airlines")
    .set(await token(admin, "aal2"))
    .send({ iata_code: iata, name });
  expect(response.status).toBe(500);
  expect((await h.pool.query(`select count(*)::int n from canada.airlines where iata_code=$1`, [iata])).rows[0].n).toBe(0);
});

it("rolls an invitation revocation back when its access audit write fails", async () => {
  const invitation = await h.api.post("/api/v1/access/invitations").set(await token(admin, "aal2")).set(h.idem())
    .send({ email: "audit.invitee@ta.test", role_code: "canada_agent", scope_type: "agency", scope_id: w.cn, expires_in_hours: 24 });
  expect(invitation.status).toBe(201);
  const id = invitation.body.data.invitation_id as string;
  const auditsBefore = Number((await h.pool.query(`select count(*)::int n from audit.access_changes where change_type='invite_revoke' and role_id=(select role_id from access.invitations where id=$1)`, [id])).rows[0].n);

  await h.pool.query(`create function public.fail_invite_revoke_audit_probe() returns trigger language plpgsql as $$
    begin raise exception 'injected access audit failure'; end $$`);
  await h.pool.query(`create trigger fail_invite_revoke_audit_probe before insert on audit.access_changes
    for each row when (new.change_type = 'invite_revoke') execute function public.fail_invite_revoke_audit_probe()`);
  const failed = await h.api.post(`/api/v1/access/invitations/${id}/revoke`).set(await token(admin, "aal2"))
    .send({ reason: "Position supprimée" });
  expect(failed.status).toBe(500);
  expect((await h.pool.query(`select status from access.invitations where id=$1`, [id])).rows[0].status).toBe("pending");
  expect(Number((await h.pool.query(`select count(*)::int n from audit.access_changes where change_type='invite_revoke' and role_id=(select role_id from access.invitations where id=$1)`, [id])).rows[0].n)).toBe(auditsBefore);

  await h.pool.query(`drop trigger fail_invite_revoke_audit_probe on audit.access_changes`);
  await h.pool.query(`drop function public.fail_invite_revoke_audit_probe()`);
  const retried = await h.api.post(`/api/v1/access/invitations/${id}/revoke`).set(await token(admin, "aal2"))
    .send({ reason: "Position supprimée" });
  expect(retried.status).toBe(200);
  expect((await h.pool.query(`select status from access.invitations where id=$1`, [id])).rows[0].status).toBe("revoked");
});

it("rolls a document confirmation back when its required audit write fails", async () => {
  const parcel = await h.api.post("/api/v1/canada/parcels").set(await token(agent)).set(h.idem()).send({
    client_id: client.clientId, recipient_name: "Document test", origin_country: "CN", destination_country: "CD",
    origin_agency_id: w.cn, destination_agency_id: w.cd, warehouse_id: w.whCn, category: "clothing", received_now: true,
  });
  expect(parcel.status).toBe(201);
  const bytes = Buffer.from("%PDF-1.4 audit transaction proof");
  const declaration = await h.api.post("/api/v1/canada/documents").set(await token(agent)).set(h.idem()).send({
    entity_type: "parcel", entity_id: parcel.body.data.id, kind: "proof_of_receipt", original_name: "proof.pdf",
    mime_type: "application/pdf", size_bytes: bytes.length,
  });
  expect(declaration.status).toBe(201);
  const upload = await fetch(declaration.body.data.upload.upload_url, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: bytes });
  expect(upload.status).toBe(200);
  const id = declaration.body.data.id as string;
  const auditsBefore = Number((await h.pool.query(`select count(*)::int n from audit.audit_events where resource_id=$1 and action='canada.document.uploaded'`, [id])).rows[0].n);

  await h.pool.query(`create function public.fail_document_audit_probe() returns trigger language plpgsql as $$
    begin raise exception 'injected document audit failure'; end $$`);
  await h.pool.query(`create trigger fail_document_audit_probe before insert on audit.audit_events
    for each row when (new.action = 'canada.document.uploaded') execute function public.fail_document_audit_probe()`);
  const failed = await h.api.post(`/api/v1/canada/documents/${id}/complete`).set(await token(agent));
  expect(failed.status).toBe(500);
  expect((await h.pool.query(`select status, stored_size from canada.documents where id=$1`, [id])).rows[0]).toEqual({ status: "pending_upload", stored_size: null });
  expect(Number((await h.pool.query(`select count(*)::int n from audit.audit_events where resource_id=$1 and action='canada.document.uploaded'`, [id])).rows[0].n)).toBe(auditsBefore);

  await h.pool.query(`drop trigger fail_document_audit_probe on audit.audit_events`);
  await h.pool.query(`drop function public.fail_document_audit_probe()`);
  const retried = await h.api.post(`/api/v1/canada/documents/${id}/complete`).set(await token(agent));
  expect(retried.status).toBe(200);
  expect(retried.body.data.status).toBe("uploaded");
});

it("applies notification preference batches atomically when a later upsert fails", async () => {
  const categories = ["batch-first", "batch-fails"];
  await h.pool.query(`create function public.fail_preference_probe() returns trigger language plpgsql as $$
    begin raise exception 'injected preference failure'; end $$`);
  await h.pool.query(`create trigger fail_preference_probe before insert or update on shared.notification_preferences
    for each row when (new.category = 'batch-fails') execute function public.fail_preference_probe()`);
  const preferences = categories.map((category) => ({ channel: "email", category, enabled: false }));
  const failed = await h.api.put("/api/v1/me/notification-preferences").set(await token(client)).send({ preferences });
  expect(failed.status).toBe(500);
  expect(Number((await h.pool.query(`select count(*)::int n from shared.notification_preferences where user_id=$1 and category=any($2::text[])`, [client.id, categories])).rows[0].n)).toBe(0);

  await h.pool.query(`drop trigger fail_preference_probe on shared.notification_preferences`);
  await h.pool.query(`drop function public.fail_preference_probe()`);
  const retried = await h.api.put("/api/v1/me/notification-preferences").set(await token(client)).send({ preferences });
  expect(retried.status).toBe(200);
  expect(Number((await h.pool.query(`select count(*)::int n from shared.notification_preferences where user_id=$1 and category=any($2::text[])`, [client.id, categories])).rows[0].n)).toBe(2);
});
