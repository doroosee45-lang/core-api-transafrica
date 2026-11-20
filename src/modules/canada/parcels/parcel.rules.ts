/**
 * Règles métier des colis (Spéc. backend §10, Dossier 05 §20, Cahier §17).
 * Les transitions sont explicites ; tout le reste est refusé.
 * `phase` désigne le pays dont l'équipe est responsable de l'étape :
 *   origin      → périmètre du pays / de l'agence d'origine
 *   destination → périmètre du pays / de l'agence de destination
 *   any         → l'un ou l'autre (exceptions)
 * `system` : transition réservée aux opérations d'expédition (jamais saisie directe).
 */
export type ParcelStatus =
  | "expected" | "received" | "inspected" | "ready_for_shipment" | "in_shipment" | "dispatched" | "in_transit"
  | "in_customs" | "arrived_destination" | "received_destination" | "available" | "out_for_delivery"
  | "delivered" | "on_hold" | "damaged" | "lost" | "returned" | "cancelled";

interface Rule { permission: string; phase: "origin" | "destination" | "any"; system?: boolean; requiresProof?: boolean; requiresMeasurement?: boolean; requiresComment?: boolean }

const T: Record<string, Rule> = {
  "expected>received": { permission: "canada.parcels.receive", phase: "origin" },
  "received>inspected": { permission: "canada.parcels.update_status", phase: "origin" },
  "inspected>ready_for_shipment": { permission: "canada.parcels.update_status", phase: "origin", requiresMeasurement: true },
  "ready_for_shipment>inspected": { permission: "canada.parcels.update_status", phase: "origin", requiresComment: true },
  "ready_for_shipment>in_shipment": { permission: "canada.shipments.consolidate", phase: "origin", system: true },
  "in_shipment>ready_for_shipment": { permission: "canada.shipments.split", phase: "origin", system: true },
  "in_shipment>dispatched": { permission: "canada.shipments.dispatch", phase: "origin", system: true },
  "dispatched>in_transit": { permission: "canada.parcels.update_status", phase: "any" },
  "dispatched>arrived_destination": { permission: "canada.shipments.receive", phase: "destination", system: true },
  "in_transit>arrived_destination": { permission: "canada.shipments.receive", phase: "destination", system: true },
  "in_transit>in_customs": { permission: "canada.parcels.update_status", phase: "destination" },
  "arrived_destination>in_customs": { permission: "canada.parcels.update_status", phase: "destination" },
  "in_customs>arrived_destination": { permission: "canada.parcels.update_status", phase: "destination" },
  // La réception physique à destination est une opération distincte de l'arrivée du vol (Cahier §8.3).
  "arrived_destination>received_destination": { permission: "canada.parcels.receive", phase: "destination" },
  "received_destination>available": { permission: "canada.parcels.update_status", phase: "destination" },
  "available>out_for_delivery": { permission: "canada.parcels.release", phase: "destination" },
  "available>delivered": { permission: "canada.parcels.release", phase: "destination", requiresProof: true },
  "out_for_delivery>delivered": { permission: "canada.parcels.release", phase: "destination", requiresProof: true },
  "out_for_delivery>available": { permission: "canada.parcels.release", phase: "destination", requiresComment: true },
};

const ACTIVE: ParcelStatus[] = [
  "expected", "received", "inspected", "ready_for_shipment", "in_shipment", "dispatched", "in_transit", "in_customs",
  "arrived_destination", "received_destination", "available", "out_for_delivery",
];
// Exceptions (Dossier 05 §19) : traçables, motivées.
for (const s of ACTIVE) {
  T[`${s}>on_hold`] = { permission: "canada.parcels.manage_exception", phase: "any", requiresComment: true };
  T[`${s}>damaged`] = { permission: "canada.parcels.report_damage", phase: "any", requiresComment: true };
  T[`${s}>lost`] = { permission: "canada.parcels.manage_exception", phase: "any", requiresComment: true };
}
for (const s of ["expected", "received", "inspected", "ready_for_shipment"] as ParcelStatus[]) {
  T[`${s}>cancelled`] = { permission: "canada.parcels.manage_exception", phase: "origin", requiresComment: true };
}
for (const from of ["on_hold", "damaged", "lost"]) {
  for (const to of ["received", "inspected", "ready_for_shipment", "received_destination", "available"]) {
    T[`${from}>${to}`] = { permission: "canada.parcels.manage_exception", phase: "any", requiresComment: true };
  }
  T[`${from}>returned`] = { permission: "canada.parcels.manage_exception", phase: "any", requiresComment: true };
}
T["damaged>on_hold"] = { permission: "canada.parcels.manage_exception", phase: "any", requiresComment: true };

export const TERMINAL: ParcelStatus[] = ["delivered", "returned", "cancelled"];

export function transitionRule(from: string, to: string): Rule | null {
  return T[`${from}>${to}`] ?? null;
}


/**
 * Poids volumétrique = L × l × h (cm) / diviseur (barème) ; poids facturable = max(réel, volumétrique).
 * Calcul en millièmes de kg entiers pour éviter les erreurs de flottant.
 */
export function computeWeights(actualKg: string, dims: { length?: string | null; width?: string | null; height?: string | null }, divisor: number) {
  const toMilli = (v: string) => Math.round(Number(v) * 1000);
  const actual = toMilli(actualKg);
  let volumetric = 0;
  if (dims.length && dims.width && dims.height) {
    // cm³ / diviseur = kg ; ×1000 pour des millièmes de kg, arrondi au millième supérieur.
    const cm3 = Number(dims.length) * Number(dims.width) * Number(dims.height);
    volumetric = Math.ceil((cm3 * 1000) / divisor);
  }
  const billable = Math.max(actual, volumetric);
  const fmt = (m: number) => (m / 1000).toFixed(3);
  return { actual: fmt(actual), volumetric: fmt(volumetric), billable: fmt(billable) };
}
