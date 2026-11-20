import type { Principal } from "../modules/access/authorization.js";

declare global {
  namespace Express {
    interface Request {
      correlationId: string;
      principal?: Principal;
    }
  }
}

export {};
