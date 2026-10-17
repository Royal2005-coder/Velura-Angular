import { callRpc } from '../supabase.js';

/** Exclusive UTC bounds select original orders; category/SKU filters retain that order cohort. */
export interface ManagementFactQuery {
  from: string;
  to: string;
  categoryId?: string | null;
  productId?: string | null;
}

/** Repository seam allows service tests without PostgREST or a production database. */
export interface ManagementFactRepository {
  /** Read private, service-only fact joins after the caller has authorized dashboard access. */
  read(query: ManagementFactQuery): Promise<unknown>;
}

/** Persisted ETL snapshots are queried once; no PII, source-table pagination or client credentials. */
export const managementFactRepository: ManagementFactRepository = {
  async read(query) {
    return callRpc('get_admin_management_facts', {
      p_from: query.from, p_to: query.to,
      p_category_id: query.categoryId ?? null, p_product_id: query.productId ?? null,
    }, { useAnonKey: false, silentError: true });
  },
};
