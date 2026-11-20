import type { Db } from "./db.js";

export interface DomainEvent {
  type: string;            // ex. "canada.flight.published"
  version?: number;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  correlationId?: string | null;
}

/**
 * Enregistre un événement métier dans l'outbox, dans la transaction de
 * l'opération (Dossier 04 §8.2). Le traitement est asynchrone (worker).
 */
export async function emit(tx: Db, e: DomainEvent): Promise<string> {
  const r = await tx.query(
    `insert into shared.outbox_events(event_type, event_version, aggregate_type, aggregate_id, payload, correlation_id)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [e.type, e.version ?? 1, e.aggregateType, e.aggregateId, JSON.stringify(e.payload), e.correlationId ?? null],
  );
  return r.rows[0].id;
}
