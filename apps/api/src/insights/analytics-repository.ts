import { callRpc } from '../supabase.js';
import type { ManagementFactQuery } from './management-repository.js';

/** Reads a persisted snapshot; mutation has a separate audited database transaction. */
export interface AnalyticsRepository {
  /** Read only, including when called by an admin viewer. */
  read(query: ManagementFactQuery): Promise<unknown>;
  /** Persist the actor's cooldown and retain the previous mart on refresh failure. */
  refresh(actorId: string): Promise<unknown>;
}
/** Service-role credentials stay on the server; the refresh RPC checks the actor's current role. */
export const analyticsRepository: AnalyticsRepository = {
  read: query => callRpc('get_admin_analytics_snapshot', {
    p_from: query.from, p_to: query.to, p_category_id: query.categoryId ?? null, p_product_id: query.productId ?? null,
  }, { useAnonKey: false }),
  refresh: actorId => callRpc('admin_refresh_analytics', { p_actor_id: actorId }, { useAnonKey: false }),
};
