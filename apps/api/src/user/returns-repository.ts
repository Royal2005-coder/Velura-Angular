import { callRpc, selectOne, selectRows, insertRow } from "../supabase.js";
import { mapReturnDatabaseError } from "../returns/return-repository.js";
import type { RefundReceiverInput } from "../returns/return-refund-receiver.js";
import { asJsonObject, type JsonObject } from "../types.js";

/**
 * Customer return reads and atomic database operations. The service performs friendly preflight
 * checks; the intake RPC independently enforces ownership, delivery window, evidence and unit quotas.
 */
export interface UserReturnsRepository {
  /** Atomically creates a request while locking item quotas on the original order. */
  createReturnBundle(payload: JsonObject, items: JsonObject[]): Promise<JsonObject>;
  /** Authoritative original-unit quota; active parts reserve only their own quantity. */
  listReturnUnits(orderItemId: unknown): Promise<JsonObject[]>;
  findOrderByCode(code: string): Promise<JsonObject | null>;
  findOrderById(orderId: string): Promise<JsonObject | null>;
  findOrderItem(itemId: unknown): Promise<JsonObject | null>;
  findVariant(variantId: unknown): Promise<JsonObject | null>;
  findProduct(productId: unknown): Promise<JsonObject | null>;
  findCategory(categoryId: unknown): Promise<JsonObject | null>;
  listReturnsForOrder(orderId: unknown): Promise<JsonObject[]>;
  listReturnItemsForReturn(returnId: unknown): Promise<JsonObject[]>;
  findReturnById(returnId: unknown): Promise<JsonObject | null>;
  /** Finds the return request that produced a replacement order, if any. */
  findReturnByExchangeOrderId?(orderId: unknown): Promise<JsonObject | null>;
  /** Cancels before any part ships, releasing mapped units under the same request lock. */
  cancelReturn(returnId: unknown, expectedVersion: number, ownerUserId: string | null): Promise<JsonObject>;
  listReturnsForUser(userId: string, orderId?: string): Promise<JsonObject[]>;
  /** Inbound/outbound shipments for the return tracking screen. */
  listReturnShipments?(returnId: unknown): Promise<JsonObject[]>;
  /** Full return timeline including shipment and custody events. */
  listReturnEvents?(returnId: unknown): Promise<JsonObject[]>;
  /** Customer-safe summary of the linked replacement order. */
  getExchangeOrder?(orderId: unknown): Promise<JsonObject | null>;
  /** Appends a customer-visible custody event (evidence uploaded, packed confirmation). */
  insertReturnEvent?(payload: JsonObject): Promise<JsonObject>;
  /** Stored COD receiving account of a return (full number; callers mask it), or null when never submitted. */
  getRefundReceiver(returnId: unknown): Promise<JsonObject | null>;
  /** Saves the receiving account in one transaction and returns its masked customer view. `ownerUserId` null = verified guest. */
  setRefundReceiver(returnId: string, ownerUserId: string | null, input: RefundReceiverInput): Promise<JsonObject>;
}

export function createUserReturnsRepository(): UserReturnsRepository {
  return {
    async createReturnBundle(payload, items) {
      try {
        return asJsonObject(await callRpc("velura_create_return_request", { p_payload: payload, p_items: items }));
      } catch (error: unknown) {
        throw mapReturnDatabaseError(error);
      }
    },
    async listReturnUnits(orderItemId) {
      const rows = await callRpc("velura_return_unit_availability", { p_order_item_id: orderItemId });
      if (!Array.isArray(rows)) throw new Error("Invalid return-unit availability response");
      return rows.map(asJsonObject);
    },
    findOrderByCode: (code) => selectOne("orders", { order_code: `eq.${code}` }),
    findOrderById: (orderId) => selectOne("orders", { order_id: `eq.${orderId}` }),
    findOrderItem: (itemId) => selectOne("order_item", { item_id: `eq.${itemId}` }),
    findVariant: (variantId) => selectOne("variant", { variant_id: `eq.${variantId}` }),
    findProduct: (productId) => selectOne("product", { product_id: `eq.${productId}` }),
    findCategory: (categoryId) => selectOne("category", { category_id: `eq.${categoryId}` }),

    async listReturnsForOrder(orderId) {
      const { rows } = await selectRows("return_exchange", { order_id: `eq.${orderId}` });
      return rows;
    },

    async listReturnItemsForReturn(returnId) {
      const { rows } = await selectRows("return_item", { return_id: `eq.${returnId}` });
      return rows;
    },

    findReturnById: (returnId) => selectOne("return_exchange", { return_id: `eq.${returnId}` }),
    findReturnByExchangeOrderId: (orderId) => selectOne("return_exchange", { exchange_order_id: `eq.${orderId}` }),

    async cancelReturn(returnId, expectedVersion, ownerUserId) {
      try {
        return asJsonObject(await callRpc("velura_cancel_customer_return", {
          p_return_id: returnId, p_expected_version: expectedVersion, p_owner_user_id: ownerUserId
        }));
      } catch (error: unknown) {
        throw mapReturnDatabaseError(error);
      }
    },

    getRefundReceiver: (returnId) => selectOne("return_refund_receiver", { return_id: `eq.${returnId}` }).catch(() => null),

    async setRefundReceiver(returnId, ownerUserId, input) {
      try {
        return asJsonObject(await callRpc("velura_set_return_refund_receiver", {
          p_return_id: returnId,
          p_owner_user_id: ownerUserId,
          p_bank_name: input.bankName,
          p_account_number: input.accountNumber,
          p_account_holder: input.accountHolder
        }));
      } catch (error: unknown) {
        throw mapReturnDatabaseError(error);
      }
    },

    async listReturnsForUser(userId, orderId) {
      const queryParams: Record<string, string> = { user_id: `eq.${userId}` };
      if (orderId) queryParams.order_id = `eq.${orderId}`;
      const { rows } = await selectRows("return_exchange", queryParams);
      return rows;
    },

    async listReturnShipments(returnId) {
      const { rows } = await selectRows("return_shipment", {
        return_id: `eq.${returnId}`,
        order: "direction.asc",
        limit: 10
      });
      return rows;
    },

    async listReturnEvents(returnId) {
      const { rows } = await selectRows("return_event", {
        return_id: `eq.${returnId}`,
        order: "created_at.asc",
        limit: 200
      });
      return rows;
    },

    getExchangeOrder: (orderId) => selectOne("orders", {
      select: "order_id,order_code,status,payment_method,total_amount,carrier,tracking_code,tracking_url,parent_order_id,source_return_id,order_kind,created_at",
      order_id: `eq.${orderId}`
    }).catch(() => null),

    async insertReturnEvent(payload) {
      return asJsonObject(await insertRow("return_event", payload));
    }
  };
}
