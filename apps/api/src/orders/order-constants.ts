/**
 * Projection và hằng số truy vấn của module đơn hàng phía admin.
 *
 * Trạng thái, nhãn, action và vai trò nằm ở `order-state-machine.ts`, không khai lại ở đây.
 */
export {
  ORDER_OPERATOR_ROLES,
  ORDER_READER_ROLES,
  ORDER_STATUSES
} from "./order-state-machine.js";

/** Quyết định đối soát thanh toán bằng tay. */
export const PAYMENT_DECISIONS = ["mark_paid", "mark_failed"];

/** Safe column projection for order rows. */
export const ORDER_SELECT = [
  "order_id",
  "order_code",
  "user_id",
  "order_date",
  "status",
  "shipping_name",
  "shipping_phone",
  "shipping_address",
  "shipping_fee",
  "voucher_id",
  "discount_amount",
  "subtotal",
  "total_amount",
  "payment_method",
  "internal_note",
  "ai_source",
  "cancelled_reason",
  "tracking_code",
  "carrier",
  "tracking_url",
  "shipment_created_at",
  "shipment_voided_at",
  "handed_over_at",
  "returned_to_stock_at",
  "stock_committed_at",
  "stock_returned_at",
  "created_at",
  "delivered_at",
  "updated_at",
  "version"
].join(",");

const PAYMENT_SELECT = "payment_id,order_id,payment_method,payment_provider,amount,payment_status,gateway_transaction_ref,gateway_response_code,payment_channel,paid_at,refund_amount,refund_reason,refund_at,created_at,has_discrepancy,version,updated_at";

/** Order detail projection including items, payments, history and the action log. */
export const ORDER_DETAIL_SELECT = [
  ORDER_SELECT,
  "items:order_item(item_id,order_id,variant_id,product_name,applied_promo_id,quantity,unit_price)",
  `payments:payment(${PAYMENT_SELECT})`,
  "history:order_status_history(history_id,order_id,old_status,new_status,trigger_type,changed_by,changed_at,note)",
  "events:order_event(event_id,action,actor_type,actor_id,actor_role,from_status,to_status,result,note,payload,created_at)"
].join(",");

/** Order list projection including payment summary. */
export const ORDER_LIST_SELECT = [
  ORDER_SELECT,
  "payments:payment(payment_id,payment_status,payment_provider,gateway_response_code,has_discrepancy,version,created_at)"
].join(",");

/** Valid sort options for order listing. */
export const ORDER_SORTS = [
  "order_date.desc",
  "order_date.asc",
  "total_amount.desc",
  "total_amount.asc",
  "updated_at.desc"
];
