import { callRpc, quotePostgrestValue, selectOne, selectRows, updateRows } from "../supabase.js";
import { HttpError } from "../http.js";
import { asJsonObject, asNumber, asString, type JsonObject } from "../types.js";
import { RETURN_SELECT, TICKET_SELECT } from "./return-constants.js";
import { classifyReturnPayment, refundFlowFor, refundReceiverStatus, type ReturnPaymentKind } from "./return-refund-receiver.js";
import { writeAuditLog } from "../audit.js";

/** Forward the resolved client IP so audited RPCs can replace their legacy 127.0.0.1. */
function clientIpOptions(ipAddress?: string) {
  return ipAddress ? { headers: { "x-velura-client-ip": ipAddress } } : {};
}

/**
 * Filters for listing return / exchange records.
 */
export interface ReturnListFilters {
  status?: string;
  search?: string;
  orderId?: string;
  /** `cod` = đơn COD, `online` = đơn thanh toán online (Stripe/MoMo/VNPay). */
  paymentKind?: "cod" | "online";
  limit: number;
  offset: number;
}

/**
 * Filters for listing support tickets.
 */
export interface TicketListFilters {
  status?: string;
  /** Ilike trên tiêu đề, mô tả, SĐT và email khách: đủ để CSKH tìm lại một ca từ số điện thoại đơn. */
  search?: string;
  userId?: string;
  limit: number;
  offset: number;
}

/**
 * Filters for return / support audit logs.
 */
export interface ReturnAuditFilters {
  targetId?: string;
  limit: number;
  offset: number;
}


/**
 * Input for assigning a support ticket.
 */
export interface AssignTicketInput {
  assignedTo: string;
  expectedVersion: number;
}

/**
 * Input for responding to a support ticket.
 */
export interface RespondTicketInput {
  response: string;
  expectedVersion: number;
}

/**
 * Input for closing a support ticket.
 */
export interface CloseTicketInput {
  reason?: unknown;
  expectedVersion: number;
}

/**
 * Kết quả chuyển khoản hoàn tiền thủ công mà CSKH ghi nhận (dữ liệu đối soát).
 */
export interface ManualRefundInput {
  /** Mã giao dịch ngân hàng/ví, duy nhất toàn hệ thống. */
  reference: string;
  /** Số tiền đã chuyển; phải khớp số tiền hoàn tính từ hàng trả. */
  amount: number;
  /** Thời điểm chuyển tiền (ISO 8601). */
  transferredAt: string;
  /** Private storage reference uploaded by this operator for this return. */
  proof: string;
  note?: string;
}

/**
 * PostgREST accessors for admin returns, exchanges, and support tickets.
 */
export function createReturnRepository() {
  return {
    /**
     * Records one COD line refund atomically, including proof ownership, receiver snapshot and capture validation.
     */
    async recordManualRefund(
      returnId: string,
      expectedVersion: number,
      input: ManualRefundInput,
      actorId: string,
      ipAddress: string | undefined,
      returnItemId: string
    ): Promise<JsonObject> {
      try {
        return asJsonObject(await callRpc("velura_record_manual_return_refund", {
          p_return_id: returnId,
          p_expected_version: expectedVersion,
          p_reference: input.reference,
          p_amount: input.amount,
          p_transferred_at: input.transferredAt,
          p_proof: input.proof,
          p_note: input.note || null,
          p_actor_id: actorId,
          p_return_item_id: returnItemId
        }, clientIpOptions(ipAddress)));
      } catch (error: unknown) {
        throw mapReturnDatabaseError(error);
      }
    },

    /**
     * Thông tin nhận hoàn tiền khách đã gửi cho phiếu (đầy đủ số tài khoản, chỉ dành cho admin).
     */
    async getRefundReceiver(returnId: string): Promise<JsonObject | null> {
      return selectOne("return_refund_receiver", { return_id: `eq.${returnId}` }).catch(() => null);
    },

    /**
     * Dữ liệu đối soát của lần hoàn tiền thủ công đã ghi nhận, hoặc null nếu chưa có.
     */
    async getManualRefund(returnId: string, returnItemId?: string): Promise<JsonObject | null> {
      return selectOne("return_manual_refund", {
        return_id: `eq.${returnId}`,
        ...(returnItemId ? { return_item_id: `eq.${returnItemId}` } : {})
      }).catch(() => null);
    },

    /**
     * COD eligibility for legacy orders that predate a payment row: the order itself still records
     * the purchase method, while `payment` may be absent.
     */
    async getOrderPaymentMethod(orderId: string): Promise<string | null> {
      const row = await selectOne("orders", { order_id: `eq.${orderId}`, select: "payment_method" }).catch(() => null);
      return row ? asString(row.payment_method) || null : null;
    },

    /**
     * Financial operation already bound to one return part; retries read it instead of creating a second refund.
     */
    async getRefundOperation(returnItemId: string): Promise<JsonObject | null> {
      return selectOne("payment_refund", { return_item_id: `eq.${returnItemId}` }).catch(() => null);
    },

    /**
     * CSKH yêu cầu khách bổ sung thông tin nhận hoàn tiền. Phiếu giữ nguyên trạng thái và phiên bản.
     */
    async requestRefundReceiverSupplement(returnId: string, expectedVersion: number, message: string, actorId: string): Promise<JsonObject> {
      try {
        return asJsonObject(await callRpc("velura_request_refund_receiver_supplement", {
          p_return_id: returnId,
          p_expected_version: expectedVersion,
          p_message: message,
          p_actor_id: actorId
        }));
      } catch (error: unknown) {
        throw mapReturnDatabaseError(error);
      }
    },
    /** Applies one action to one versioned return part; the RPC owns splitting, stock and aggregate updates. */
    async actOnItem(returnId: string, returnItemId: string, action: string, payload: JsonObject, expectedVersion: number, actorId: string, ipAddress?: string): Promise<JsonObject> {
      try {
        return asJsonObject(await callRpc("velura_return_item_action", {
          p_return_id: returnId,
          p_return_item_id: returnItemId,
          p_action: action,
          p_payload: payload,
          p_expected_version: expectedVersion,
          p_actor_id: actorId
        }, clientIpOptions(ipAddress)));
      } catch (error: unknown) {
        throw mapReturnDatabaseError(error);
      }
    },

    /** Inbound/outbound shipments attached to one return. */
    async listReturnShipments(returnId: string): Promise<JsonObject[]> {
      const { rows } = await selectRows("return_shipment", {
        return_id: `eq.${returnId}`,
        order: "direction.asc",
        limit: 10
      });
      return rows;
    },

    /** Full return timeline, including shipment/pickup/custody events. */
    async listReturnEvents(returnId: string): Promise<JsonObject[]> {
      const { rows } = await selectRows("return_event", {
        return_id: `eq.${returnId}`,
        order: "created_at.asc",
        limit: 200
      });
      return rows;
    },

    /** Linked replacement order facts shown next to the return. */
    async getExchangeOrder(orderId: string): Promise<JsonObject | null> {
      return selectOne("orders", {
        select: "order_id,order_code,status,payment_method,total_amount,carrier,tracking_code,tracking_url,parent_order_id,source_return_id,order_kind,created_at",
        order_id: `eq.${orderId}`
      }).catch(() => null);
    },
    async listReturns(filters: ReturnListFilters, accessToken: string) {
      const query: Record<string, unknown> = {
        select: filters.paymentKind ? `${RETURN_SELECT},pay_order:orders!return_exchange_order_id_fkey!inner(payment_method)` : RETURN_SELECT,
        order: "created_at.desc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.status) query.status = `eq.${filters.status}`;
      if (filters.orderId) query.order_id = `eq.${filters.orderId}`;
      if (filters.paymentKind) query["pay_order.payment_method"] = filters.paymentKind === "cod" ? "eq.COD" : "eq.ONLINE_PAYMENT";
      if (filters.search) {
        query.or = `(description.ilike.*${filters.search}*,tracking_return_code.ilike.*${filters.search}*)`;
      }
      let found = await selectRows("return_exchange", query, authOptions(accessToken)).catch(() => null);
      if (!found) {
        found = await selectRows("return_exchange", query);
      }
      // The embedded order only exists to filter by payment method; it is not part of the response contract.
      const res = { rows: found.rows.map(({ pay_order: _payOrder, ...row }) => row), count: found.count };
      if (!res.rows?.length) return res;

      const orderIds = Array.from(new Set([
        ...res.rows.map((r: JsonObject) => asString(r.order_id)),
        ...res.rows.map((r: JsonObject) => asString(r.exchange_order_id))
      ].filter(Boolean)));
      if (orderIds.length > 0) {
        const [ordersRes, paymentsRes] = await Promise.all([
          selectRows("orders", {
            select: "order_id,order_code,shipping_name,shipping_phone,shipping_address,payment_method,total_amount,status",
            order_id: `in.(${orderIds.join(",")})`,
            limit: orderIds.length
          }, authOptions(accessToken))
            .catch(() => selectRows("orders", {
              select: "order_id,order_code,shipping_name,shipping_phone,shipping_address,payment_method,total_amount,status",
              order_id: `in.(${orderIds.join(",")})`,
              limit: orderIds.length
            }))
            .catch(() => ({ rows: [] as JsonObject[] })),
          selectRows("payment", {
            select: "payment_id,order_id,payment_method,payment_provider,payment_status,amount",
            order_id: `in.(${orderIds.join(",")})`,
            order: "created_at.desc"
          }).catch(() => ({ rows: [] as JsonObject[] }))
        ]);

        const orderMap = new Map<string, JsonObject>();
        for (const ord of (ordersRes.rows || [])) {
          orderMap.set(asString(ord.order_id), ord);
        }

        const paymentMap = new Map<string, JsonObject>();
        for (const pay of (paymentsRes.rows || [])) {
          const oid = asString(pay.order_id);
          if (oid && !paymentMap.has(oid)) {
            paymentMap.set(oid, pay);
          }
        }

        const kindOf = (row: JsonObject): ReturnPaymentKind => {
          const ord = orderMap.get(asString(row.order_id));
          return classifyReturnPayment(ord?.payment_method ?? row.payment_method, paymentMap.get(asString(row.order_id))?.payment_provider);
        };
        const receiverRequiredIds = res.rows
          .filter((row) => refundFlowFor(row.return_type, kindOf(row)) === "cod_manual")
          .map((row) => asString(row.return_id));
        const receiverRows = receiverRequiredIds.length
          ? await selectRows("return_refund_receiver", {
              select: "return_id,bank_name,account_number,account_holder,supplement_request",
              return_id: `in.(${receiverRequiredIds.join(",")})`,
              limit: receiverRequiredIds.length
            }, { count: "none" }).catch(() => ({ rows: [] as JsonObject[] }))
          : { rows: [] as JsonObject[] };
        const receiverMap = new Map<string, JsonObject>(receiverRows.rows.map((row) => [asString(row.return_id), row]));

        const enriched = res.rows.map((row: JsonObject) => {
          const ord = orderMap.get(asString(row.order_id));
          const excOrd = row.exchange_order_id ? orderMap.get(asString(row.exchange_order_id)) : undefined;
          const pay = paymentMap.get(asString(row.order_id));
          const kind = kindOf(row);
          const flow = refundFlowFor(row.return_type, kind);
          return {
            ...row,
            order_code: ord ? asString(ord.order_code) : undefined,
            customer_name: ord ? asString(ord.shipping_name) : asString(row.customer_name),
            customer_phone: ord ? asString(ord.shipping_phone) : undefined,
            customer_address: ord ? asString(ord.shipping_address) : undefined,
            payment_method: ord ? asString(ord.payment_method) : undefined,
            order_total: ord ? asNumber(ord.total_amount) : undefined,
            exchange_order_code: excOrd ? asString(excOrd.order_code) : undefined,
            exchange_order_status: excOrd ? asString(excOrd.status) : undefined,
            payment: pay || undefined,
            payment_kind: kind,
            refund_flow: flow,
            refund_receiver_status: refundReceiverStatus(flow === "cod_manual", receiverMap.get(asString(row.return_id)))
          };
        });
        return { rows: enriched, count: res.count };
      }
      return res;
    },

    /** Reads every independently versioned part, including decisions, receipt facts and exchange linkage. */
    async listReturnLines(returnId: string, accessToken: string) {
      let res = await selectRows("return_item", {
        select: "*",
        return_id: `eq.${returnId}`,
        limit: 1000
      }, authOptions(accessToken)).catch(() => null);
      if (!res) {
        res = await selectRows("return_item", {
          select: "*",
          return_id: `eq.${returnId}`,
          limit: 1000
        });
      }
      return res;
    },
    async getOrderItemProductMeta(orderItemIds: string[], accessToken?: string): Promise<Record<string, { product_id?: string; variant_id?: string; product_name?: string }>> {
      if (!orderItemIds.length) return {};
      const uniqueIds = Array.from(new Set(orderItemIds.filter(Boolean)));
      const { rows } = await selectRows("order_item", {
        select: "item_id,variant_id,product_name,variant:variant!order_item_variant_id_fkey(product_id)",
        item_id: `in.(${uniqueIds.join(",")})`,
        limit: uniqueIds.length
      }, authOptions(accessToken)).catch(() => ({ rows: [] as JsonObject[] }));
      const map: Record<string, { product_id?: string; variant_id?: string; product_name?: string }> = {};
      for (const row of rows) {
        const v = asJsonObject(row.variant);
        map[asString(row.item_id)] = {
          variant_id: asString(row.variant_id) || undefined,
          product_name: asString(row.product_name) || undefined,
          product_id: asString(v.product_id) || undefined
        };
      }
      return map;
    },


    async getReturn(returnId: string, accessToken: string) {
      let ret = await selectOne("return_exchange", {
        select: RETURN_SELECT,
        return_id: `eq.${returnId}`
      }, authOptions(accessToken)).catch(() => null);
      if (!ret) {
        ret = await selectOne("return_exchange", {
          select: RETURN_SELECT,
          return_id: `eq.${returnId}`
        }).catch(() => null);
      }
      if (!ret) return null;
      if (ret.order_id) {
        let ord = await selectOne("orders", {
          select: "order_id,order_code,shipping_name,shipping_phone,shipping_address,payment_method,total_amount",
          order_id: `eq.${ret.order_id}`
        }, authOptions(accessToken)).catch(() => null);
        if (!ord) {
          ord = await selectOne("orders", {
            select: "order_id,order_code,shipping_name,shipping_phone,shipping_address,payment_method,total_amount",
            order_id: `eq.${ret.order_id}`
          }).catch(() => null);
        }
        if (ord) {
          ret = {
            ...ret,
            order_code: asString(ord.order_code),
            customer_name: asString(ord.shipping_name) || asString(ret.customer_name),
            customer_phone: asString(ord.shipping_phone),
            customer_address: asString(ord.shipping_address),
            payment_method: asString(ord.payment_method),
            order_total: asNumber(ord.total_amount),
          };
        }
      }
      if (ret && ret.exchange_order_id) {
        const exc = await selectOne("orders", {
          select: "order_id,order_code,status,total_amount",
          order_id: `eq.${ret.exchange_order_id}`
        }, authOptions(accessToken)).catch(() => selectOne("orders", {
          select: "order_id,order_code,status,total_amount",
          order_id: `eq.${ret!.exchange_order_id}`
        })).catch(() => null);
        if (exc) {
          ret = {
            ...ret,
            exchange_order_code: asString(exc.order_code),
            exchange_order_status: asString(exc.status)
          };
        }
      }
      return ret;
    },

    /**
     * Thông tin thanh toán mới nhất của đơn hàng gắn với phiếu đổi trả.
     */
    async getPaymentByOrderId(orderId: string, accessToken?: string): Promise<JsonObject | null> {
      let result: { rows: JsonObject[]; count?: number } | null = null;
      if (accessToken) {
        result = await selectRows("payment", {
          select: "payment_id,payment_method,payment_provider,amount,payment_status,gateway_transaction_ref,refund_at,refund_amount,gateway_response_code,created_at,refunded_amount",
          order_id: `eq.${orderId}`,
          order: "created_at.desc",
          limit: 1
        }, authOptions(accessToken)).catch(() => null);
      }
      if (!result) {
        result = await selectRows("payment", {
          select: "payment_id,payment_method,payment_provider,amount,payment_status,gateway_transaction_ref,refund_at,refund_amount,gateway_response_code,created_at,refunded_amount",
          order_id: `eq.${orderId}`,
          order: "created_at.desc",
          limit: 1
        }).catch(() => ({ rows: [] as JsonObject[], count: undefined }));
      }
      if (result?.rows?.[0]) return asJsonObject(result.rows[0]);

      return null;
    },


    /**
     * Giá trị hoàn được của một phiếu: tổng tiền đúng những món khách gửi trả.
     *
     * UAT ADM-RET-01 chốt "tự động điền tiền hoàn đúng số tiền của hàng thay vì bắt tự
     * nhập". Số đó không phải tổng đơn — một đơn bốn món mà khách chỉ trả một món thì
     * hoàn cả đơn là thất thoát; và cũng không thể để CSKH gõ tay, vì gõ tay thì con số
     * phụ thuộc trí nhớ của người trực.
     *
     * Đọc qua `return_item` (phiếu ↔ dòng đơn) nhân với đơn giá đã bán tại thời điểm
     * đặt, chứ không lấy giá hiện hành của sản phẩm.
     */
    async getRefundableAmount(returnId: string, accessToken: string): Promise<number> {
      const res = await callRpc("velura_return_refundable_amount", {p_return_id:returnId}, {accessToken}).catch(() => null);
      if (res != null) return asNumber(res);
      return asNumber(await callRpc("velura_return_refundable_amount", {p_return_id:returnId}));
    },

    /** Computes the allocated paid value of this part, not the request total or current catalog price. */
    async getItemRefundableAmount(returnItemId: string): Promise<number> {
      return asNumber(await callRpc("velura_return_item_refundable_amount", {
        p_return_item_id: returnItemId
      }, { useAnonKey: false }));
    },


    async listTickets(filters: TicketListFilters, accessToken: string) {
      const query: Record<string, unknown> = {
        select: TICKET_SELECT,
        order: "created_at.desc",
        limit: filters.limit,
        offset: filters.offset
      };
      if (filters.status) query.status = `eq.${filters.status}`;
      if (filters.userId) query.user_id = `eq.${filters.userId}`;
      // Chuỗi tìm được bọc nháy kép qua `quotePostgrestValue`, nên một dấu `,` hay `)` do người
      // dùng gõ không thể mở điều kiện lọc mới.
      if (filters.search) {
        const pattern = `ilike.*${quotePostgrestValue(filters.search)}*`;
        query.or = `(title.${pattern},description.${pattern},guest_phone.${pattern},guest_email.${pattern})`;
      }
      return selectRows("support_ticket", query, authOptions(accessToken));
    },

    async getTicket(ticketId: string, accessToken: string) {
      return selectOne("support_ticket", {
        select: TICKET_SELECT,
        ticket_id: `eq.${ticketId}`
      }, authOptions(accessToken));
    },

    async assignTicket(ticketId: string, input: AssignTicketInput, accessToken: string) {
      return callRpc("admin_assign_ticket", {
        p_ticket_id: ticketId,
        p_assigned_to: input.assignedTo,
        p_expected_version: input.expectedVersion
      }, { accessToken });
    },

    async respondTicket(ticketId: string, input: RespondTicketInput, accessToken: string) {
      return callRpc("admin_respond_ticket", {
        p_ticket_id: ticketId,
        p_response: input.response,
        p_expected_version: input.expectedVersion
      }, { accessToken });
    },

    async closeTicket(ticketId: string, input: CloseTicketInput, accessToken: string) {
      return callRpc("admin_close_ticket", {
        p_ticket_id: ticketId,
        p_expected_version: input.expectedVersion,
        p_reason: input.reason || ""
      }, { accessToken });
    },

    async updateTicketStatus(
      ticketId: string,
      input: { status: string; adminNote?: string; expectedVersion: number },
      accessToken: string
    ) {
      if (input.status !== "resolved") {
        throw new HttpError(422, "VALIDATION_ERROR", "Chỉ hỗ trợ đánh dấu phiếu đã giải quyết");
      }
      return callRpc("admin_resolve_ticket", {
        p_ticket_id: ticketId,
        p_expected_version: input.expectedVersion,
        p_admin_note: input.adminNote || ""
      }, { accessToken });
    },

    /** Keeps contact history and attention independent from the business stage of every return part. */
    async recordContact(returnId: string, input: { result: string; note: string; expectedVersion: number }, actorId: string, actorRole: string, ipAddress: string | undefined) {
      const current = await selectOne("return_exchange", { select: RETURN_SELECT, return_id: `eq.${returnId}` });
      if (!current) throw new HttpError(404, "RETURN_NOT_FOUND", "Return record not found");
      if (current.version !== input.expectedVersion) {
        throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user");
      }
      const stamp = new Date().toISOString();
      const line = `[CSKH ${stamp}] ${input.result}: ${input.note}`;
      const adminNote = [asString(current.admin_note), line].filter(Boolean).join("\n");
      const rows = await updateRows("return_exchange", {
        return_id: `eq.${returnId}`,
        version: `eq.${input.expectedVersion}`
      }, {
        attention_status: input.result === "reached" ? "none" : "waiting_customer",
        admin_note: adminNote,
        contact_history: [...(Array.isArray(current.contact_history) ? current.contact_history : []), {
          result: input.result, note: input.note, actor_id: actorId, contacted_at: stamp
        }],
        last_contact_at: stamp,
        version: asNumber(current.version) + 1,
        updated_at: stamp
      });
      if (!rows.length) throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user");
      await writeAuditLog({
        actor_id: actorId,
        actor_role: actorRole,
        action: "update",
        module: "returns",
        target_id: returnId,
        old_value: { version: current.version },
        new_value: { result: input.result, note: input.note },
        ip_address: ipAddress || "127.0.0.1",
        timestamp: stamp
      });
      return asJsonObject(rows[0]);
    },

    async listAuditLogs(filters: ReturnAuditFilters, accessToken: string) {
      const query: Record<string, unknown> = {
        select: "audit_id,actor_id,actor_role,action,module,target_id,old_value,new_value,ip_address,timestamp",
        order: "timestamp.desc",
        limit: filters.limit,
        offset: filters.offset,
        or: "(module.eq.returns,module.eq.support)"
      };
      if (filters.targetId) query.target_id = `eq.${filters.targetId}`;
      return selectRows("audit_log", query, authOptions(accessToken));
    }
  };
}

/**
 * Repository returned by `createReturnRepository`.
 */
export type ReturnRepository = ReturnType<typeof createReturnRepository>;

function authOptions(accessToken: string | null | undefined): { useAnonKey?: boolean; accessToken?: string } {
  if (!accessToken) return {};
  return { useAnonKey: true, accessToken };
}

/** Localized codes raised by the return intake, per-item workflow and financial RPCs. */
const RETURN_DATABASE_ERRORS: Readonly<Record<string, { status: number; message: string }>> = {
  RBAC_DENIED: { status: 403, message: "Không đủ quyền thực hiện thao tác phần hàng." },
  RETURN_ITEM_REQUIRED: { status: 422, message: "Chọn phần hàng cần xử lý." },
  RETURN_ITEM_NOT_FOUND: { status: 404, message: "Phần hàng không thuộc yêu cầu đổi/trả." },
  ITEM_ACTION_REQUIRED: { status: 409, message: "Xử lý từng phần hàng, không chuyển trạng thái cả phiếu." },
  INVALID_RETURN_ACTION: { status: 422, message: "Thao tác phần hàng không hợp lệ." },
  RETURN_REASON_REQUIRED: { status: 422, message: "Ghi rõ lý do xử lý phần hàng." },
  CUSTOMER_CONSENT_REQUIRED: { status: 422, message: "Cần sự đồng ý của khách hàng." },
  INVALID_RETURN_QUANTITY: { status: 422, message: "Số lượng xử lý không khớp phần hàng." },
  WAREHOUSE_PROOF_REQUIRED: { status: 422, message: "Tải lên bằng chứng kiểm hàng riêng tư." },
  COD_PAYMENT_REQUIRED: { status: 422, message: "Chỉ đơn COD được ghi nhận chuyển khoản hoàn tiền." },
  REFUND_RESOLUTION_REQUIRED: { status: 422, message: "Phần hàng phải được duyệt hoàn tiền." },
  RETURN_QUANTITY_EXCEEDED: { status: 422, message: "Số lượng vượt quá phần hàng còn được đổi/trả." },
  RETURN_UNIT_CONFLICT: { status: 409, message: "Phần hàng đang được xử lý bởi thao tác khác." },
  RETURN_ITEM_CLOSED: { status: 422, message: "Phần hàng đã kết thúc xử lý." },
  RETURN_PART_ALREADY_COMMITTED: { status: 422, message: "Phần hàng đã nhận, xuất đổi hoặc đã yêu cầu hoàn tiền; không thể tách hay dừng." },
  RETURN_DECISION_FINAL: { status: 422, message: "Quyết định phần hàng đã được ghi nhận." },
  RETURN_APPROVAL_REQUIRED: { status: 422, message: "Phần hàng cần được duyệt trước khi tiếp tục." },
  TRACKING_REQUIRED: { status: 422, message: "Ghi nhận đơn vị vận chuyển và mã vận đơn." },
  PICKUP_PROOF_REQUIRED: { status: 422, message: "Tải lên bằng chứng bàn giao riêng tư." },
  PICKUP_FACTS_REQUIRED: { status: 422, message: "Ghi nhận người bàn giao và thời điểm lấy hàng hợp lệ." },
  WAREHOUSE_LINE_MISMATCH: { status: 422, message: "Số lượng hàng nhận không khớp phần hàng đăng ký." },
  RECEIPT_FACTS_REQUIRED: { status: 422, message: "Ghi nhận đầy đủ kết quả kiểm hàng." },
  DISPOSITION_REQUIRED: { status: 422, message: "Chọn hướng xử lý phần hàng đã nhận." },
  RESTOCK_QA_REQUIRED: { status: 422, message: "Không nhập lại hàng chưa đạt kiểm tra." },
  REFUND_ALREADY_REQUESTED: { status: 409, message: "Phần hàng đã có yêu cầu hoàn tiền." },
  EXCHANGE_ALREADY_SHIPPED: { status: 422, message: "Hàng đổi đã được bàn giao vận chuyển." },
  EXCHANGE_SAME_PRODUCT_REQUIRED: { status: 422, message: "Chỉ đổi biến thể của cùng sản phẩm." },
  INSUFFICIENT_STOCK: { status: 409, message: "Biến thể đổi không còn đủ tồn kho." },
  EXCHANGE_PREPARING_REQUIRED: { status: 422, message: "Chuẩn bị phần hàng đổi trước khi giao vận chuyển." },
  EXCHANGE_DELIVERY_REQUIRED: { status: 422, message: "Chỉ hoàn tất khi đơn đổi thực sự giao thành công." },
  CAPTURED_PAYMENT_REQUIRED: { status: 422, message: "Chưa có thanh toán đã thu hợp lệ để hoàn tiền." },
  REFUND_RECEIVER_REQUIRED: { status: 422, message: "Chưa có thông tin nhận hoàn tiền hợp lệ của khách. Hãy yêu cầu khách bổ sung trước khi tiếp tục hoàn tiền." },
  REFUND_RECEIVER_NOT_APPLICABLE: { status: 422, message: "Chỉ đơn COD có yêu cầu hoàn tiền mới cần thông tin nhận tiền." },
  REFUND_RECEIVER_INVALID: { status: 422, message: "Thông tin nhận hoàn tiền chưa hợp lệ. Kiểm tra ngân hàng, số tài khoản (6–20 chữ số) và tên chủ tài khoản." },
  SUPPLEMENT_MESSAGE_REQUIRED: { status: 422, message: "Nội dung yêu cầu bổ sung phải có ít nhất 10 ký tự." },
  RETURN_CLOSED: { status: 422, message: "Yêu cầu đổi/trả đã kết thúc, không thể thay đổi thông tin nhận hoàn tiền." },
  REFUND_AMOUNT_MISMATCH: { status: 422, message: "Số tiền ghi nhận không khớp số tiền hoàn của hàng đã nhận. Kiểm tra lại số tiền đã chuyển." },
  TRANSFER_TIME_INVALID: { status: 422, message: "Thời điểm chuyển tiền không hợp lệ: không được ở tương lai và không được trước thời điểm tạo yêu cầu." },
  TRANSFER_REFERENCE_REQUIRED: { status: 422, message: "Mã giao dịch chuyển tiền phải có ít nhất 6 ký tự." },
  TRANSFER_PROOF_REQUIRED: { status: 422, message: "Vui lòng tải lên ảnh chụp chứng từ chuyển khoản thành công." },
  DUPLICATE_TRANSFER_REFERENCE: { status: 409, message: "Mã giao dịch này đã được dùng cho một lần hoàn tiền khác. Vui lòng kiểm tra lại mã giao dịch." },
  CAPTURED_NON_STRIPE_REQUIRED: { status: 422, message: "Chỉ áp dụng ghi nhận chuyển khoản cho đơn thanh toán ngoài Stripe (COD, MoMo, VNPay) đã thanh toán thành công." },
  WAREHOUSE_QA_REQUIRED: { status: 422, message: "Hàng hoàn trả phải được kho tiếp nhận và kiểm tra đạt yêu cầu (QA Pass) trước khi hoàn tiền." },
  VERSION_CONFLICT: { status: 409, message: "Dữ liệu yêu cầu đổi/trả đã bị thay đổi bởi thao tác khác. Vui lòng tải lại trang." },
  RETURN_NOT_FOUND: { status: 404, message: "Không tìm thấy yêu cầu đổi/trả tương ứng." },
  REFUND_BALANCE_EXHAUSTED: { status: 422, message: "Đơn hàng không còn số dư hợp lệ để hoàn tiền." },
  CANCEL_REASON_REQUIRED: { status: 422, message: "Phải ghi rõ lý do khi từ chối hoặc hủy yêu cầu." },
  INVALID_RETURN_TRANSITION: { status: 422, message: "Không thể chuyển yêu cầu sang trạng thái này từ trạng thái hiện tại." }
};

/**
 * Turns a PostgREST error raised by one of the return RPCs into the stable, localized `HttpError` the admin UI shows.
 * Unknown errors pass through untouched.
 */
export function mapReturnDatabaseError(error: unknown): unknown {
  if (!(error instanceof HttpError)) return error;
  const details = asJsonObject(error.details);
  const code = asString(details.message).trim() || error.message.replace(/\s*\[status:\d+\]$/, "").trim();
  const known = RETURN_DATABASE_ERRORS[code];
  return known ? new HttpError(known.status, code, known.message, error.details) : error;
}
