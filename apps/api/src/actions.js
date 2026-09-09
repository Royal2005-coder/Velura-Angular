import { HttpError } from "./http.js";
import { selectOne, selectRows, updateRows } from "./supabase.js";
import { writeAuditLog } from "./audit.js";

export async function handleAction(context, resourceName, id, action, body) {
  if (resourceName === "accounts") return handleAccountAction(context, id, action, body);
  if (resourceName === "orders") return handleOrderAction(context, id, action, body);
  if (resourceName === "reviews") return handleReviewAction(context, id, action, body);
  if (resourceName === "returns") return handleReturnAction(context, id, action, body);
  if (resourceName === "support-tickets") return handleTicketAction(context, id, action, body);
  if (resourceName === "products") return handleProductAction(context, id, action, body);
  if (["promotions", "vouchers", "bundles", "budgets"].includes(resourceName)) {
    return handlePromotionAction(context, resourceName, id, action, body);
  }
  throw new HttpError(404, "ACTION_NOT_FOUND", "Unsupported admin action");
}

async function handleAccountAction(context, id, action, body) {
  const before = await selectOne("profiles", {
    select: "*,role:app_roles(code,name,is_admin)",
    id: `eq.${id}`
  });
  if (!before) throw new HttpError(404, "ROW_NOT_FOUND", "Target row was not found");
  let patch;

  if (action === "lock") {
    if (before.role?.code === "super_admin" && before.status === "active") {
      const activeSuperAdmins = await selectRows("profiles", {
        select: "id",
        role_id: `eq.${before.role_id}`,
        status: "eq.active"
      });
      if (activeSuperAdmins.rows.length <= 1) {
        throw new HttpError(409, "LAST_SUPER_ADMIN", "Cannot lock the last active super admin");
      }
    }
    patch = {
      status: body.lockType === "temporary" ? "locked_temp" : "locked_perm",
      locked_reason: requireText(body.reason, "reason", 10),
      locked_by: context.profile?.id || null,
      locked_at: new Date().toISOString()
    };
  } else if (action === "unlock") {
    patch = {
      status: "active",
      unlocked_reason: requireText(body.reason, "reason", 10),
      locked_reason: null,
      locked_by: null,
      locked_at: null
    };
  } else if (action === "assign-role") {
    if (!body.role_id) throw new HttpError(400, "ROLE_REQUIRED", "role_id is required");
    patch = {
      role_id: body.role_id
    };
  } else {
    throw new HttpError(404, "ACTION_NOT_FOUND", "Unsupported account action");
  }

  const after = await optimisticUpdate("profiles", id, body.expectedVersion, patch);
  await writeAuditLog(context, {
    module: "accounts",
    action,
    targetTable: "profiles",
    targetId: id,
    targetCode: before.email,
    beforeData: before,
    afterData: after[0],
    summary: `Account ${before.email} ${action}`
  });
  return after[0];
}

async function handleProductAction(context, id, action, body) {
  const before = await requireRow("products", id);
  let patch;

  if (action === "change-status") {
    if (!["active", "hidden", "discontinued"].includes(body.status)) {
      throw new HttpError(400, "INVALID_PRODUCT_STATUS", "Invalid product status");
    }
    patch = {
      status: body.status,
      status_reason: body.reason || null
    };
  } else if (action === "adjust-stock") {
    const delta = Number(body.delta);
    if (!Number.isFinite(delta)) throw new HttpError(400, "INVALID_STOCK_DELTA", "delta must be a number");
    patch = {
      stock_quantity: Math.max(0, Number(before.stock_quantity || 0) + delta)
    };
  } else {
    throw new HttpError(404, "ACTION_NOT_FOUND", "Unsupported product action");
  }

  const after = await optimisticUpdate("products", id, body.expectedVersion, patch);
  await writeAuditLog(context, {
    module: "products",
    action,
    targetTable: "products",
    targetId: id,
    targetCode: before.sku,
    beforeData: before,
    afterData: after[0],
    summary: `Product ${before.sku} ${action}`
  });
  return after[0];
}

async function handleOrderAction(context, id, action, body) {
  const before = await requireRow("orders", id);
  let patch;

  if (action === "update-status") {
    const next = body.status;
    assertOrderTransition(before.status, next);
    patch = {
      status: next,
      status_reason: requireText(body.reason, "reason", 10)
    };
  } else if (action === "cancel") {
    assertOrderTransition(before.status, "cancelled");
    patch = {
      status: "cancelled",
      cancel_reason: requireText(body.reason, "reason", 10),
      cancelled_by: context.profile?.id || null,
      cancelled_at: new Date().toISOString(),
      refund_status: before.payment_status === "paid" ? "pending_refund" : "no_refund"
    };
  } else if (action === "resolve-payment") {
    if (!["paid", "failed", "refunded"].includes(body.paymentStatus)) {
      throw new HttpError(400, "INVALID_PAYMENT_STATUS", "Invalid paymentStatus");
    }
    patch = {
      payment_status: body.paymentStatus,
      payment_resolution_note: body.reason || null
    };
  } else {
    throw new HttpError(404, "ACTION_NOT_FOUND", "Unsupported order action");
  }

  const after = await optimisticUpdate("orders", id, body.expectedVersion, patch);
  await writeAuditLog(context, {
    module: "orders",
    action,
    targetTable: "orders",
    targetId: id,
    targetCode: before.order_code,
    beforeData: before,
    afterData: after[0],
    summary: `Order ${before.order_code} ${action}`
  });
  return after[0];
}

async function handleReviewAction(context, id, action, body) {
  const before = await requireRow("reviews", id);
  const statusByAction = {
    approve: "approved",
    hide: "hidden",
    reply: "replied"
  };
  const status = statusByAction[action];
  if (!status) throw new HttpError(404, "ACTION_NOT_FOUND", "Unsupported review action");

  const patch = {
    status,
    admin_response: action === "reply" ? requireText(body.response, "response", 5) : body.response || before.admin_response || null,
    moderated_by: context.profile?.id || null,
    moderated_at: new Date().toISOString()
  };
  const after = await optimisticUpdate("reviews", id, body.expectedVersion, patch);
  await writeAuditLog(context, {
    module: "reviews",
    action,
    targetTable: "reviews",
    targetId: id,
    targetCode: before.id,
    beforeData: before,
    afterData: after[0],
    summary: `Review ${before.id} ${action}`
  });
  return after[0];
}

async function handleReturnAction(context, id, action, body) {
  const before = await requireRow("return_requests", id);
  const statusByAction = {
    approve: "approved",
    reject: "rejected",
    refund: "refunded",
    exchange: "exchanged"
  };
  const status = statusByAction[action];
  if (!status) throw new HttpError(404, "ACTION_NOT_FOUND", "Unsupported return action");

  const patch = {
    status,
    resolution_note: requireText(body.reason || body.note, "reason", 10),
    resolved_by: context.profile?.id || null,
    resolved_at: new Date().toISOString()
  };
  const after = await optimisticUpdate("return_requests", id, body.expectedVersion, patch);
  await writeAuditLog(context, {
    module: "returns",
    action,
    targetTable: "return_requests",
    targetId: id,
    targetCode: before.request_code,
    beforeData: before,
    afterData: after[0],
    summary: `Return request ${before.request_code} ${action}`
  });
  return after[0];
}

async function handleTicketAction(context, id, action, body) {
  const before = await requireRow("support_tickets", id);
  const statusByAction = {
    reply: "replied",
    forward: "forwarded",
    resolve: "resolved",
    close: "closed"
  };
  const status = statusByAction[action];
  if (!status) throw new HttpError(404, "ACTION_NOT_FOUND", "Unsupported support ticket action");

  const patch = {
    status,
    response_note: requireText(body.message || body.reason, "message", 10),
    assigned_department: action === "forward" ? body.department || "operations" : before.assigned_department,
    handled_by: context.profile?.id || null,
    handled_at: new Date().toISOString()
  };
  const after = await optimisticUpdate("support_tickets", id, body.expectedVersion, patch);
  await writeAuditLog(context, {
    module: "support_tickets",
    action,
    targetTable: "support_tickets",
    targetId: id,
    targetCode: before.ticket_code,
    beforeData: before,
    afterData: after[0],
    summary: `Support ticket ${before.ticket_code} ${action}`
  });
  return after[0];
}

async function handlePromotionAction(context, resourceName, id, action, body) {
  const tableByResource = {
    promotions: "promotions",
    vouchers: "vouchers",
    bundles: "bundles",
    budgets: "promotion_budgets"
  };
  const table = tableByResource[resourceName];
  const before = await requireRow(table, id);

  const statusActions = {
    activate: "active",
    pause: "paused",
    stop: "stopped",
    expire: "expired"
  };
  const status = statusActions[action];
  if (!status) throw new HttpError(404, "ACTION_NOT_FOUND", "Unsupported promotion action");

  const patch = {
    status,
    status_reason: body.reason || null
  };
  const after = await optimisticUpdate(table, id, body.expectedVersion, patch);
  await writeAuditLog(context, {
    module: resourceName,
    action,
    targetTable: table,
    targetId: id,
    targetCode: before.code || before.name || before.id,
    beforeData: before,
    afterData: after[0],
    summary: `${resourceName} ${before.code || before.id} ${action}`
  });
  return after[0];
}

async function requireRow(table, id) {
  const row = await selectOne(table, {
    select: "*",
    id: `eq.${id}`
  });
  if (!row) throw new HttpError(404, "ROW_NOT_FOUND", "Target row was not found");
  return row;
}

async function optimisticUpdate(table, id, expectedVersion, patch) {
  if (expectedVersion === undefined || expectedVersion === null) {
    throw new HttpError(400, "EXPECTED_VERSION_REQUIRED", "expectedVersion is required for updates");
  }

  const query = { id: `eq.${id}` };
  query.version = `eq.${expectedVersion}`;

  const payload = {
    ...patch,
    version: Number(expectedVersion || 0) + 1,
    updated_at: new Date().toISOString()
  };
  const rows = await updateRows(table, query, payload);
  if (!rows.length) {
    throw new HttpError(409, "VERSION_CONFLICT", "Data changed before this update was saved");
  }
  return rows;
}

function requireText(value, field, minLength) {
  const text = String(value || "").trim();
  if (text.length < minLength) {
    throw new HttpError(400, "VALIDATION_FAILED", `${field} must be at least ${minLength} characters`);
  }
  return text;
}

function assertOrderTransition(current, next) {
  const transitions = {
    pending: ["confirmed", "held", "cancelled"],
    confirmed: ["preparing", "held", "cancelled"],
    preparing: ["shipping", "held"],
    shipping: ["completed", "held"],
    held: ["confirmed", "preparing", "cancelled"],
    completed: [],
    cancelled: []
  };
  if (!transitions[current]?.includes(next)) {
    throw new HttpError(400, "INVALID_ORDER_TRANSITION", `Cannot move order from ${current} to ${next}`);
  }
}
