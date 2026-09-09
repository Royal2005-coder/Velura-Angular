export const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "preparing",
  "shipping",
  "delivered",
  "failed_delivery",
  "cancelled",
  "completed"
];

export const ORDER_TRANSITIONS = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["preparing", "cancelled"],
  preparing: ["shipping", "cancelled"],
  shipping: ["delivered", "failed_delivery"],
  failed_delivery: ["shipping", "cancelled"],
  delivered: ["completed"],
  cancelled: [],
  completed: []
};

export const ORDER_READER_ROLES = [
  "super_admin",
  "admin_operator_donhang",
  "admin_operator_cskh_dt"
];

export const ORDER_OPERATOR_ROLES = ["super_admin", "admin_operator_donhang"];

export const PAYMENT_DECISIONS = ["mark_paid", "mark_failed"];

export const ORDER_SELECT = [
  "order_id",
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
  "created_at",
  "delivered_at",
  "updated_at",
  "version"
].join(",");

export const ORDER_DETAIL_SELECT = [
  ORDER_SELECT,
  "items:order_item(item_id,order_id,variant_id,product_name,applied_promo_id,quantity,unit_price)",
  "payments:payment(payment_id,order_id,payment_method,payment_provider,amount,payment_status,gateway_transaction_ref,gateway_response_code,payment_channel,paid_at,refund_amount,refund_reason,refund_at,created_at,has_discrepancy,version,updated_at)",
  "history:order_status_history(history_id,order_id,old_status,new_status,trigger_type,changed_by,changed_at,note)"
].join(",");

export const ORDER_LIST_SELECT = [
  ORDER_SELECT,
  "payments:payment(payment_id,payment_status,has_discrepancy,version,created_at)"
].join(",");

export const ORDER_SORTS = [
  "order_date.desc",
  "order_date.asc",
  "total_amount.desc",
  "total_amount.asc",
  "updated_at.desc"
];
