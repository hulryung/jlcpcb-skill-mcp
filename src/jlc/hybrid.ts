/**
 * HybridJlcClient — local catalog DB for breadth, live API for freshness.
 *
 * Search/list operations run against the local SQLite catalog (JlcDbClient):
 * the full JLCPCB catalog, no rate limits, no dependency on a third-party
 * mirror being up. The one place snapshot data is not good enough — pinning a
 * final part before ordering — goes to the live API first (fresh stock and the
 * preferred-tier flag the local DB lacks), falling back to the DB if the API is
 * unreachable.
 *
 * Implements the same surface as JlcClient / JlcDbClient so it drops into
 * buildServer() and the engine's PartSearcher seam unchanged.
 */
import type {
  CapacitorSearchOptions,
  Part,
  ResistorSearchOptions,
  SearchOptions,
} from "../types.js";
import type { JlcClient } from "./client.js";
import type { JlcDbClient } from "./db.js";

export class HybridJlcClient {
  constructor(
    private readonly db: JlcDbClient,
    private readonly api: JlcClient,
  ) {}

  searchComponents(opts: SearchOptions): Promise<Part[]> {
    return this.db.searchComponents(opts);
  }

  searchResistors(opts: ResistorSearchOptions): Promise<Part[]> {
    return this.db.searchResistors(opts);
  }

  searchCapacitors(opts: CapacitorSearchOptions): Promise<Part[]> {
    return this.db.searchCapacitors(opts);
  }

  getPassiveDetail(lcsc: string | number, kind: "resistor" | "capacitor"): Promise<Part | null> {
    return this.db.getPassiveDetail(lcsc, kind);
  }

  listCategories(): Promise<{ category: string; subcategory: string }[]> {
    return this.db.listCategories();
  }

  /**
   * Live API first — it has fresher stock and can distinguish preferred-extended
   * parts, both of which matter most at the moment of choosing a part to order.
   * Any API failure (or an unknown part) falls back to the local snapshot, which
   * is marked so callers know the stock figure is not live.
   */
  async getPart(lcsc: string | number): Promise<Part | null> {
    try {
      const live = await this.api.getPart(lcsc);
      if (live) return live;
    } catch {
      // fall through to the local snapshot
    }
    const local = await this.db.getPart(lcsc);
    if (local) {
      return {
        ...local,
        attributes: { ...local.attributes, "Data Source": "local-db (snapshot stock)" },
      };
    }
    return null;
  }
}
