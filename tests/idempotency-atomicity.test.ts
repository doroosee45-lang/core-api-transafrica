import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { setupHarness, type Harness } from "./support/harness.js";

let h: Harness;
let client: any;
const body = { origin_country: "CN", destination_country: "CD", message: "Atomicity regression test" };

beforeAll(async () => {
  h = await setupHarness();
  client = await h.makeUser("request.atomicity@ta.test", {
    roles: [{ role: "canada_client", scope_type: "own" }], client: { residence: "CD" },
  });
});
afterAll(async () => { await h?.teardown(); });

const send = async (key: string, payload = body) => h.api.post("/api/v1/me/requests")
  .set(h.auth(await client.token()))
  .set("Idempotency-Key", key)
  .send(payload);

const requestCount = async () => Number((await h.pool.query(
  `select count(*)::int n from canada.requests where requester_user_id = $1`, [client.id])).rows[0].n);
const eventCount = async () => Number((await h.pool.query(
  `select count(*)::int n from shared.outbox_events where event_type = 'canada.request.created'
     and payload->>'origin_country' = 'CN' and payload->>'destination_country' = 'CD'`)).rows[0].n);
const counts = async () => ({ requests: await requestCount(), events: await eventCount() });
const stable = (value: any): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`
  : JSON.stringify(value) ?? "null";
const requestHash = (route: string, payload: unknown) => createHash("sha256")
  .update(`${route}|{}|${stable(payload)}`).digest("hex");
const reserveCompletedKey = async (key: string, method: string, route: string) => h.pool.query(
  `insert into shared.idempotency_keys(principal_id, idempotency_key, method, route, request_hash, status, response_status, response_body, expires_at)
   values ($1,$2,$3,$4,$5,'completed',201,'{}'::jsonb,now() + interval '24 hours')`,
  [client.id, key, method, route, requestHash(route, body)],
);

describe("Atomic creation and idempotency of client requests", () => {
  it("outbox failure rolls back both writes; same key can retry successfully", async () => {
    const key = "request-rollback-0001";
    await h.pool.query(`create function public.fail_request_outbox_probe() returns trigger language plpgsql as $$
      begin raise exception 'injected outbox failure'; end $$`);
    await h.pool.query(`create trigger fail_request_outbox_probe before insert on shared.outbox_events
      for each row when (new.event_type = 'canada.request.created') execute function public.fail_request_outbox_probe()`);

    const failed = await send(key);
    expect(failed.status).toBe(500);
    expect(await requestCount()).toBe(0);
    expect(await eventCount()).toBe(0);
    expect((await h.pool.query(`select count(*)::int n from shared.idempotency_keys where principal_id=$1 and idempotency_key=$2`, [client.id, key])).rows[0].n).toBe(0);

    await h.pool.query(`drop trigger fail_request_outbox_probe on shared.outbox_events`);
    await h.pool.query(`drop function public.fail_request_outbox_probe()`);
    const retry = await send(key);
    expect(retry.status).toBe(201);
    expect(await requestCount()).toBe(1);
    expect(await eventCount()).toBe(1);
  });

  it("successful replay returns the same resource and emits no second event", async () => {
    const before = await counts();
    const key = "request-replay-0001";
    const first = await send(key);
    const replay = await send(key);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await counts()).toEqual({ requests: before.requests + 1, events: before.events + 1 });
  });

  it("same key and same payload concurrently create one request; both calls resolve to the same result", async () => {
    const before = await counts();
    const key = "request-concurrent-0001";
    const [a, b] = await Promise.all([send(key), send(key)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.data.id).toBe(b.body.data.id);
    expect([a.headers["idempotent-replayed"], b.headers["idempotent-replayed"]].filter(Boolean)).toHaveLength(1);
    expect(await counts()).toEqual({ requests: before.requests + 1, events: before.events + 1 });
  });

  it("same key with different content conflicts and leaves the original result unchanged", async () => {
    const before = await counts();
    const key = "request-conflict-0001";
    const first = await send(key);
    const conflicting = await send(key, { ...body, message: "different content" });
    expect(first.status).toBe(201);
    expect(conflicting.status).toBe(422);
    expect(conflicting.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await counts()).toEqual({ requests: before.requests + 1, events: before.events + 1 });
  });

  it("canonicalizes object-key order in the SHA-256 request fingerprint", async () => {
    const before = await counts();
    const key = "request-key-order-0001";
    const first = await send(key, body);
    const reordered = await send(key, {
      message: body.message,
      destination_country: body.destination_country,
      origin_country: body.origin_country,
    });
    expect(first.status).toBe(201);
    expect(reordered.status).toBe(201);
    expect(reordered.headers["idempotent-replayed"]).toBe("true");
    expect(reordered.body.data.id).toBe(first.body.data.id);
    expect(await counts()).toEqual({ requests: before.requests + 1, events: before.events + 1 });
  });

  it("rejects same-principal key collisions across methods and route paths", async () => {
    const before = await counts();
    const seedKey = "request-route-seed-0001";
    expect((await send(seedKey)).status).toBe(201);
    const route = (await h.pool.query(`select route from shared.idempotency_keys where principal_id=$1 and idempotency_key=$2`, [client.id, seedKey])).rows[0].route as string;
    const [, path] = route.split(" ");
    const methodCollision = await reserveCompletedKey("request-method-collision-001", "PUT", `PUT ${path}`);
    const routeCollision = await reserveCompletedKey("request-route-collision-001", "POST", `POST ${path}/other-route`);
    expect(methodCollision.rowCount).toBe(1);
    expect(routeCollision.rowCount).toBe(1);
    const otherMethod = await send("request-method-collision-001");
    const otherRoute = await send("request-route-collision-001");
    expect(otherMethod.status).toBe(422);
    expect(otherMethod.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(otherRoute.status).toBe(422);
    expect(otherRoute.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await counts()).toEqual({ requests: before.requests + 1, events: before.events + 1 });
  });

  it("checks platform authorization before replaying a stored response", async () => {
    const before = await counts();
    const key = "request-auth-before-replay-001";
    const first = await send(key);
    expect(first.status).toBe(201);
    await h.pool.query(`update access.user_platform_access set access_status='suspended' where user_id=$1 and platform_id=1`, [client.id]);
    const deniedReplay = await send(key);
    expect(deniedReplay.status).toBe(403);
    expect(deniedReplay.headers["idempotent-replayed"]).toBeUndefined();
    await h.pool.query(`update access.user_platform_access set access_status='active' where user_id=$1 and platform_id=1`, [client.id]);
    const allowedReplay = await send(key);
    expect(allowedReplay.status).toBe(201);
    expect(allowedReplay.headers["idempotent-replayed"]).toBe("true");
    expect(allowedReplay.body.data.id).toBe(first.body.data.id);
    expect(await counts()).toEqual({ requests: before.requests + 1, events: before.events + 1 });
  });

  it("retains a completed key for 24 hours, then permits reuse after expiry", async () => {
    const before = await counts();
    const key = "request-expiry-0001";
    const first = await send(key);
    const saved = (await h.pool.query(`select status, created_at, expires_at, response_body from shared.idempotency_keys
      where principal_id=$1 and idempotency_key=$2`, [client.id, key])).rows[0];
    expect(saved.status).toBe("completed");
    expect(new Date(saved.expires_at).getTime()).toBeGreaterThan(new Date(saved.created_at).getTime());
    expect(saved.response_body.data.id).toBe(first.body.data.id);
    const withinTtl = await send(key);
    expect(withinTtl.headers["idempotent-replayed"]).toBe("true");
    await h.pool.query(`update shared.idempotency_keys set expires_at=now()-interval '1 second'
      where principal_id=$1 and idempotency_key=$2`, [client.id, key]);
    const afterExpiry = await send(key);
    expect(afterExpiry.status).toBe(201);
    expect(afterExpiry.headers["idempotent-replayed"]).toBeUndefined();
    expect(afterExpiry.body.data.id).not.toBe(first.body.data.id);
    expect(await counts()).toEqual({ requests: before.requests + 2, events: before.events + 2 });
  });

  it("a client disconnect after the server commits is safely replayed without another insert", async () => {
    const before = await counts();
    const key = "request-commit-loss-0001";
    const server = h.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
    const token = await client.token();
    const disconnected = new Promise<void>((resolve, reject) => {
      let responseStarted = false;
      const request = httpRequest({
        host: "127.0.0.1", port: address.port, path: "/api/v1/me/requests", method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": key, "Content-Type": "application/json" },
      }, (response) => {
        responseStarted = true; // the server only responds after the transaction commits
        if (response.statusCode !== 201) {
          response.resume();
          reject(new Error(`Expected committed response 201, got ${response.statusCode}.`));
          return;
        }
        response.destroy(); // drop the response body as if the client connection failed
        resolve();
      });
      request.on("error", (error) => { if (!responseStarted) reject(error); });
      request.end(JSON.stringify(body));
    });
    try { await disconnected; }
    finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }

    const retry = await send(key);
    expect(retry.status).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(await counts()).toEqual({ requests: before.requests + 1, events: before.events + 1 });
  });
});
