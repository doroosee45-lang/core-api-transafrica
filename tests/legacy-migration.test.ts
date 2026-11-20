/**
 * Reprise MongoDB → PostgreSQL sur un vrai mongod, alimenté avec des documents
 * au format des modèles Mongoose du backend MERN (models/*.js).
 */
import bcrypt from "bcryptjs";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { PASSWORD, setupHarness, type Harness } from "./support/harness.js";

let h: Harness;
let mongod: MongoMemoryServer;
let uri: string;
let run: typeof import("../src/migration/legacy.js").runLegacyMigration;
const id = () => new ObjectId();
const ids = { agKin: id(), agBzv: id(), agNone: id(), uSuper: id(), uAdminRdc: id(), uAgentNoAgency: id(), uAgent: id(), uClient: id(), uBadHash: id(),
  cSender: id(), cReceiver: id(), pkg: id(), pkgNoAgency: id(), pay: id(), flight: id() };

beforeAll(async () => {
  h = await setupHarness();
  mongod = await MongoMemoryServer.create({ binary: { systemBinary: process.env.MONGOD_BINARY ?? "C:\\Program Files\\MongoDB\\Server\\8.2\\bin\\mongod.exe" } });
  uri = mongod.getUri("colis");
  const c = new MongoClient(uri);
  await c.connect();
  const m = c.db();
  const hash = await bcrypt.hash(PASSWORD, 4); // même format que bcryptjs du backend existant
  const t0 = new Date("2026-10-01T08:00:00Z");
  await m.collection("agencies").insertMany([
    { _id: ids.agKin, name: "Kinshasa Gombe", code: "AGC-0001", address: { street: "Bd du 30 juin", city: "Kinshasa", country: "RDC" }, status: "actif" },
    { _id: ids.agBzv, name: "Brazzaville", code: "AGC-0002", address: { city: "Brazzaville", country: "CONGO" }, status: "inactif" },
    { _id: ids.agNone, name: "Agence inconnue", code: "AGC-0003", address: { country: "FRANCE" } },
  ]);
  await m.collection("users").insertMany([
    { _id: ids.uSuper, firstName: "Super", lastName: "Admin", email: "root@legacy.test", password: hash, role: "superadmin", isActive: true, emailVerified: true },
    { _id: ids.uAdminRdc, firstName: "Admin", lastName: "RDC", email: "admin.rdc@legacy.test", password: hash, role: "admin", countries: ["RDC"], isActive: true, emailVerified: true },
    { _id: ids.uAgentNoAgency, firstName: "Sans", lastName: "Agence", email: "orphan@legacy.test", password: hash, role: "agent", isActive: true, emailVerified: true },
    { _id: ids.uAgent, firstName: "Agent", lastName: "Kin", email: "agent@legacy.test", password: hash, role: "driver", agency: ids.agKin, isActive: true, emailVerified: true },
    { _id: ids.uClient, firstName: "Grace", lastName: "Legacy", email: "Grace@Legacy.test", password: hash, role: "client", isActive: true, emailVerified: true,
      pushTokens: [{ token: "ExponentPushToken[legacy-device-1]", platform: "android" }] },
    { _id: ids.uBadHash, firstName: "X", lastName: "Y", email: "plain@legacy.test", password: "plaintext!", role: "client" },
  ]);
  await m.collection("clients").insertMany([
    { _id: ids.cSender, firstName: "Grace", lastName: "Legacy", phone: "+1 514 000", country: "CANADA", agency: ids.agKin, user: ids.uClient, isActive: true },
    { _id: ids.cReceiver, firstName: "Paul", lastName: "Mbala", phone: "+243 81", country: "RDC", isActive: true },
  ]);
  await m.collection("packages").insertMany([
    { _id: ids.pkg, trackingNumber: "TAC-1A2B3C4D", sender: ids.cSender, receiver: ids.cReceiver, weight: 12.5, length: 40, width: 30, height: 20,
      packageType: "clothing", declaredValue: 300, origin: "CANADA", destination: "RDC", agency: ids.agKin, status: "transit",
      pricePerKg: 10, extraFees: 5, totalPrice: 130, currency: "CAD", isPaid: true, createdBy: ids.uAgent, createdAt: t0,
      trackingHistory: [
        { status: "registered", location: "CANADA", description: "Colis enregistré", date: t0 },
        { status: "preparing", date: new Date("2026-10-02T08:00:00Z"), updatedBy: ids.uAgent },
        { status: "transit", location: "Aéroport", date: new Date("2026-10-03T08:00:00Z") },
      ] },
    { _id: ids.pkgNoAgency, trackingNumber: "TAC-99999999", sender: ids.cSender, receiver: ids.cReceiver, weight: 1, origin: "CANADA", destination: "CONGO", status: "registered" },
  ]);
  await m.collection("payments").insertOne({ _id: ids.pay, invoiceNumber: "INV-2026-00042", client: ids.cSender, packages: [ids.pkg, ids.pkgNoAgency],
    amount: 130, amountPaid: 130, currency: "CAD", method: "mobile_money", status: "paid", paidAt: new Date("2026-10-01T09:00:00Z") });
  await m.collection("flights").insertOne({ _id: ids.flight, flightNumber: "AF908", origin: "Montréal", destination: "Kinshasa", status: "published" });
  await m.collection("kilooffers").insertOne({ seller: ids.uAgent, originCountry: "CANADA", destinationCountry: "RDC", availableWeight: 20, pricePerKg: 12 });
  await m.collection("quoterequests").insertOne({ reference: "DEV-2026-0007", fullName: "Jean K", email: "jk@x.test", phone: "+1", originCountry: "CANADA", destinationCountry: "RDC", status: "contacted" });
  await c.close();
  ({ runLegacyMigration: run } = await import("../src/migration/legacy.js"));
}, 240_000);

afterAll(async () => { await mongod?.stop(); await h?.teardown(); });

const count = async (sql: string) => (await h.pool.query(sql)).rows[0].n;

describe("Reprise des données MongoDB (Document de migration §7, §8, §14)", () => {
  it("analyse à blanc : rapport complet, aucune écriture", async () => {
    const r = await run({ mongoUri: uri, apply: false, operator: "test" });
    expect(r.mode).toBe("dry_run");
    expect(r.entities.agency).toMatchObject({ source: 3, migrated: 2, needs_review: 1 });
    expect(r.entities.parcel).toMatchObject({ migrated: 1, needs_review: 1 }); // agences simulées résolues
    expect(r.entities.user).toMatchObject({ migrated: 5, needs_review: 1 });
    expect(await count(`select count(*)::int n from canada.agencies where legacy_ref is not null`)).toBe(0);
    expect(await count(`select count(*)::int n from shared.external_id_mappings`)).toBe(0);
    expect(await count(`select count(*)::int n from auth.users`)).toBe(0);
  });

  it("exécution : comptes, rôles sans privilège supplémentaire, hash bcrypt conservé", async () => {
    const r = await run({ mongoUri: uri, apply: true, operator: "test" });
    expect(r.entities.user).toMatchObject({ migrated: 5, needs_review: 1, failed: 0 });
    const roles = (await h.pool.query(
      `select u.email, r.code, ur.scope_type, ur.scope_country from auth.users u
         left join access.user_roles ur on ur.user_id = u.id left join access.roles r on r.id = ur.role_id order by u.email`)).rows;
    expect(roles).toEqual(expect.arrayContaining([
      { email: "root@legacy.test", code: "canada_administrator", scope_type: "global", scope_country: null },
      { email: "admin.rdc@legacy.test", code: "canada_administrator", scope_type: "country", scope_country: "CD" },
      { email: "agent@legacy.test", code: "canada_agent", scope_type: "agency", scope_country: null },
      { email: "grace@legacy.test", code: "canada_client", scope_type: "own", scope_country: null },
      { email: "orphan@legacy.test", code: null, scope_type: null, scope_country: null },
    ]));
    expect(r.reconciliation.staff_without_role).toBe(1);
    expect(r.entities.user.issues.find((i) => i.reason.includes("non bcrypt"))).toBeTruthy();
    // L'ancien mot de passe fonctionne via Supabase Auth (hash d'origine transmis tel quel).
    const login = await h.api.post("/api/v1/auth/login").send({ email: "grace@legacy.test", password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.data.context.roles).toEqual(["canada_client"]);
    expect(await count(`select count(*)::int n from shared.user_devices where push_token = 'ExponentPushToken[legacy-device-1]'`)).toBe(1);
  });

  it("colis : numéro de suivi public conservé, historique transposé, aucun diviseur inventé", async () => {
    const p = (await h.pool.query(`select * from canada.parcels where reference = 'TAC-1A2B3C4D'`)).rows[0];
    expect(p).toMatchObject({ origin_country: "CA", destination_country: "CD", status: "in_transit", actual_weight_kg: "12.500", billable_weight_kg: "12.500", volumetric_divisor: null });
    const ev = (await h.pool.query(`select to_status, source from canada.parcel_events where parcel_id = $1 order by occurred_at`, [p.id])).rows;
    expect(ev.map((e) => e.to_status)).toEqual(["received", "inspected", "in_transit"]);
    const pub = await h.api.get("/api/v1/public/tracking/TAC-1A2B3C4D");
    expect(pub.status).toBe(200);
    expect(pub.body.data.status).toBe("in_transit");
    const pricing = await count(`select count(*)::int n from audit.audit_events where action = 'legacy.parcel.pricing_snapshot' and resource_id = '${p.id}'`);
    expect(pricing).toBe(1);
    const own = await h.api.get("/api/v1/me/parcels").set(h.auth((await h.api.post("/api/v1/auth/login").send({ email: "grace@legacy.test", password: PASSWORD })).body.data.session.access_token));
    expect(own.body.data.map((x: any) => x.reference)).toEqual(["TAC-1A2B3C4D"]);
  });

  it("paiements : montants et devise réconciliés, encaissement historique marqué non vérifiable", async () => {
    const pay = (await h.pool.query(`select * from canada.payments where legacy_invoice_number = 'INV-2026-00042'`)).rows[0];
    expect(pay).toMatchObject({ amount_due: "130.00", amount_paid: "130.00", currency: "CAD", status: "succeeded" });
    const tx = (await h.pool.query(`select source, evidence from canada.payment_transactions where payment_id = $1`, [pay.id])).rows;
    expect(tx).toEqual([{ source: "legacy_migration", evidence: expect.objectContaining({ verifiable_source: false }) }]);
    expect(await count(`select count(*)::int n from canada.payment_parcels where payment_id = '${pay.id}'`)).toBe(1); // le colis sans agence n'est pas repris
  });

  it("éléments non transposables signalés, jamais devinés ; rapport de réconciliation", async () => {
    const r = await run({ mongoUri: uri, apply: false, operator: "test" });
    const map = (await h.pool.query(`select entity_type, migration_status, control_result from shared.external_id_mappings where migration_status <> 'migrated' order by entity_type`)).rows;
    expect(map.map((x) => x.entity_type)).toEqual(expect.arrayContaining(["agency", "flight", "parcel", "user"]));
    expect(map.find((x) => x.entity_type === "flight").control_result).toMatch(/IATA/);
    expect(map.find((x) => x.entity_type === "parcel").control_result).toMatch(/agence/);
    expect(r.not_migrated.kilooffers.documents).toBe(1);
    expect(await count(`select count(*)::int n from canada.flights`)).toBe(0);
    expect(await count(`select status from canada.requests where reference = 'DEV-2026-0007'`.replace("status", "count(*)::int n"))).toBe(1);
  });

  it("idempotence : une seconde exécution ne crée aucun doublon ; la source MongoDB est intacte", async () => {
    const before = await count(`select (select count(*) from canada.parcels) + (select count(*) from auth.users) + (select count(*) from canada.payments) + (select count(*) from canada.parcel_events) as n`);
    const r = await run({ mongoUri: uri, apply: true, operator: "test" });
    expect(r.entities.parcel.migrated).toBe(0);
    expect(r.entities.parcel.already).toBe(1);
    expect(r.entities.user.already).toBe(5);
    const after = await count(`select (select count(*) from canada.parcels) + (select count(*) from auth.users) + (select count(*) from canada.payments) + (select count(*) from canada.parcel_events) as n`);
    expect(after).toBe(before);
    const c = new MongoClient(uri); await c.connect();
    expect(await c.db().collection("packages").countDocuments()).toBe(2);
    expect(await c.db().collection("users").countDocuments()).toBe(6);
    await c.close();
    expect(await count(`select count(*)::int n from shared.migration_runs where mode = 'apply' and report is not null`)).toBe(2);
  });
});
