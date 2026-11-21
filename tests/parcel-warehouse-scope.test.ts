import { setupHarness, type Harness } from "./support/harness.js";

let h: Harness;
let w: Awaited<ReturnType<Harness["world"]>>;
let client: any;
let agentOrigin: any;
let agentMulti: any;
let otherWarehouse: string;
let inactiveWarehouse: string;

const token = async (u: any) => h.auth(await u.token());

async function newReceivedParcel(actor = agentOrigin) {
  const r = await h.api.post("/api/v1/canada/parcels").set(await token(actor)).set(h.idem()).send({
    client_id: client.clientId, recipient_name: "Warehouse test", origin_country: "CN", destination_country: "CD",
    origin_agency_id: w.cn, destination_agency_id: w.cd, warehouse_id: w.whCn, category: "clothing", received_now: true,
  });
  expect(r.status).toBe(201);
  return r.body.data.id as string;
}

async function snapshot(parcelId: string) {
  const parcel = (await h.pool.query(`select status, current_warehouse_id, row_version from canada.parcels where id=$1`, [parcelId])).rows[0];
  const measurements = Number((await h.pool.query(`select count(*)::int n from canada.parcel_measurements where parcel_id=$1`, [parcelId])).rows[0].n);
  const events = Number((await h.pool.query(`select count(*)::int n from canada.parcel_events where parcel_id=$1`, [parcelId])).rows[0].n);
  return { parcel, measurements, events };
}

beforeAll(async () => {
  h = await setupHarness();
  w = await h.world();
  client = await h.makeUser("warehouse.client@ta.test", { roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD" } });
  agentOrigin = await h.makeUser("warehouse.agent.cn@ta.test", { roles: [{ role: "canada_agent", scope_type: "agency", scope_id: w.cn }] });
  const otherAgency = (await h.pool.query(
    `insert into canada.agencies(code, name, country_code, city, timezone) values ('CN-OTHER-WH','Other CN agency','CN','Guangzhou','Asia/Shanghai') returning id`)).rows[0].id;
  otherWarehouse = (await h.pool.query(
    `insert into canada.warehouses(agency_id, country_code, code, name) values ($1,'CN','CN-OTHER-WH','Other CN warehouse') returning id`, [otherAgency])).rows[0].id;
  inactiveWarehouse = (await h.pool.query(
    `insert into canada.warehouses(agency_id, country_code, code, name, status) values ($1,'CN','CN-INACTIVE-WH','Inactive CN warehouse','suspended') returning id`, [w.cn])).rows[0].id;
  agentMulti = await h.makeUser("warehouse.agent.multi@ta.test", { roles: [
    { role: "canada_agent", scope_type: "agency", scope_id: w.cn },
    { role: "canada_agent", scope_type: "agency", scope_id: otherAgency },
  ] });
});
afterAll(async () => { await h?.teardown(); });

describe("Parcel warehouse target authorization", () => {
  it("allows measurement at an active warehouse within the actor's explicit scope without moving the parcel", async () => {
    const id = await newReceivedParcel(agentMulti);
    const before = await snapshot(id);
    const response = await h.api.post(`/api/v1/canada/parcels/${id}/measurements`).set(await token(agentMulti)).set(h.idem())
      .send({ actual_weight_kg: "3.5", warehouse_id: otherWarehouse });
    expect(response.status).toBe(201);
    const after = await snapshot(id);
    expect(after.parcel.current_warehouse_id).toBe(before.parcel.current_warehouse_id);
    expect(after.parcel.row_version).toBe(before.parcel.row_version + 1);
    expect(after.measurements).toBe(before.measurements + 1);
    expect(after.events).toBe(before.events + 1);
    const measuredAt = (await h.pool.query(`select warehouse_id from canada.parcel_measurements where parcel_id=$1`, [id])).rows[0].warehouse_id;
    expect(measuredAt).toBe(otherWarehouse);
  });

  it.each([
    ["unknown", "00000000-0000-4000-8000-000000000000", 422, "WAREHOUSE_INVALID"],
    ["inactive", "inactive", 422, "WAREHOUSE_INVALID"],
    ["wrong country", "destination", 422, "WAREHOUSE_INVALID"],
    ["outside actor scope", "other", 403, "FORBIDDEN"],
  ] as const)("rejects %s measurement target without business side effects", async (_label, selector, status, code) => {
    const id = await newReceivedParcel();
    const before = await snapshot(id);
    const warehouseId = selector === "inactive" ? inactiveWarehouse
      : selector === "destination" ? w.whCd : selector === "other" ? otherWarehouse : selector;
    const response = await h.api.post(`/api/v1/canada/parcels/${id}/measurements`).set(await token(agentOrigin)).set(h.idem())
      .send({ actual_weight_kg: "2", warehouse_id: warehouseId });
    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
    expect(await snapshot(id)).toEqual(before);
  });

  it("rejects a transition into another agency's warehouse without changing status, location or history", async () => {
    const id = await newReceivedParcel();
    const before = await snapshot(id);
    const response = await h.api.post(`/api/v1/canada/parcels/${id}/transitions`).set(await token(agentOrigin)).set(h.idem())
      .send({ to_status: "inspected", warehouse_id: otherWarehouse });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(await snapshot(id)).toEqual(before);
  });

  it("allows an authorized destination agent to receive at the declared destination agency", async () => {
    const id = await newReceivedParcel();
    // Fixture the logistics handoff state; this test targets the destination permission and warehouse checks.
    await h.pool.query(`update canada.parcels set status='arrived_destination', row_version=row_version+1 where id=$1`, [id]);
    const before = await snapshot(id);
    const destinationAgent = await h.makeUser("warehouse.agent.cd@ta.test", { roles: [{ role: "canada_agent", scope_type: "agency", scope_id: w.cd }] });
    const response = await h.api.post(`/api/v1/canada/parcels/${id}/transitions`).set(await token(destinationAgent)).set(h.idem())
      .send({ to_status: "received_destination", warehouse_id: w.whCd, source: "scan" });
    expect(response.status).toBe(200);
    const after = await snapshot(id);
    expect(after.parcel.status).toBe("received_destination");
    expect(after.parcel.current_warehouse_id).toBe(w.whCd);
    expect(after.events).toBe(before.events + 1);
  });
});
