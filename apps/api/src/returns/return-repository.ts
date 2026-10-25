import crypto from "crypto";
import { callRpc, quotePostgrestValue, selectOne, selectRows, updateRows, insertRow } from "../supabase.js";
import { HttpError } from "../http.js";
import { asJsonObject, asNumber, asString, type JsonObject } from "../types.js";
import { createNotification } from "../user/notifications.js";
import { RETURN_SELECT, TICKET_SELECT } from "./return-constants.js";
import { classifyReturnPayment, refundFlowFor, refundReceiverStatus, type ReturnPaymentKind } from "./return-refund-receiver.js";
import { writeAuditLog } from "../audit.js";

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
 * Input for approving a refund.
 */
export interface ApproveRefundInput {
  refundAmount: number;
  adminNote?: unknown;
  expectedVersion: number;
}

/**
 * Input for approving an exchange.
 */
export interface ApproveExchangeInput {
  adminNote?: unknown;
  expectedVersion: number;
}

/**
 * Input for rejecting a return.
 */
export interface RejectReturnInput {
  reason: string;
  imageProof?: unknown;
  expectedVersion: number;
}

/**
 * Input for a generic return status update.
 */
export interface UpdateReturnStatusInput {
  /** Per-line warehouse QA facts persisted with the receipt state transition. */
  receipts?: unknown;
  status: string;
  adminNote?: unknown;
  reason?: unknown;
  refundAmount?: number;
  trackingReturnCode?: unknown;
  conditionCheckResult?: unknown;
  imageProof?: unknown;
  expectedVersion: number;
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
  /** Ảnh chứng từ chuyển khoản (URL https hoặc data:image). */
  proof: string;
  note?: string;
}

/**
 * PostgREST accessors for admin returns, exchanges, and support tickets.
 */
export function createReturnRepository() {
  return {
    /**
     * Ghi nhận kết quả chuyển khoản hoàn tiền thủ công (COD, MoMo, VNPay) trong MỘT giao dịch DB:
     * kiểm tra thông tin nhận tiền COD, đối soát số tiền, lưu mã/số tiền/thời điểm/chứng từ và đóng phiếu.
     */
    async recordManualRefund(
      returnId: string,
      expectedVersion: number,
      input: ManualRefundInput,
      actorId: string
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
          p_actor_id: actorId
        }));
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
    async getManualRefund(returnId: string): Promise<JsonObject | null> {
      return selectOne("return_manual_refund", { return_id: `eq.${returnId}` }).catch(() => null);
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
    async prepareExchange(returnId: string, expectedVersion: number, actorId: string, ipAddress?: string) {
      try {
        return asJsonObject(await callRpc("velura_prepare_exchange", {
          p_return_id: returnId,
          p_expected_version: expectedVersion,
          p_actor_id: actorId
        }));
      } catch (err: unknown) {
        // Fallback thực hiện tạo đơn đổi hàng và cập nhật phiếu đổi trả
        const ret = await selectOne("return_exchange", {
          select: RETURN_SELECT,
          return_id: `eq.${returnId}`
        });
        if (!ret) throw err;
        if (Number(ret.version) !== expectedVersion) {
          throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user");
        }
        if (ret.status !== "RECEIVED" || ret.return_type !== "exchange" || ret.condition_check_result !== "qa_pass") {
          throw new HttpError(422, "WAREHOUSE_QA_REQUIRED", "Exchange requires warehouse QA pass");
        }

        const original = await selectOne("orders", {
          select: "order_id,user_id,order_code,status,shipping_name,shipping_phone,shipping_email,shipping_address,total_amount,is_guest",
          order_id: `eq.${ret.order_id}`
        });
        if (!original) throw err;

        const returnItemsRes = await selectRows("return_item", {
          select: "order_item_id,replacement_variant_id,quantity",
          return_id: `eq.${returnId}`,
          order: "order_item_id.asc"
        });
        const returnItems = returnItemsRes.rows || [];

        let subtotal = 0;
        const exchangeLines: Array<{
          targetVariantId: string;
          productName: string;
          productImage: string;
          quantity: number;
          unitPrice: number;
        }> = [];

        if (returnItems.length > 0) {
          const orderItemIds = returnItems.map((ri) => asString(ri.order_item_id)).filter(Boolean);
          const orderItemsRes = await selectRows("order_item", {
            select: "item_id,variant_id,product_name,product_image,quantity,unit_price",
            item_id: `in.(${orderItemIds.join(",")})`
          }).catch(() => ({ rows: [] as JsonObject[] }));
          const orderItems = orderItemsRes.rows || [];

          for (const ri of returnItems) {
            const oi = orderItems.find((item) => asString(item.item_id) === asString(ri.order_item_id));
            const targetVariantId = asString(ri.replacement_variant_id) || asString(oi?.variant_id);
            const qty = asNumber(ri.quantity) || 1;
            const unitPrice = asNumber(oi?.unit_price) || 0;
            subtotal += unitPrice * qty;
            exchangeLines.push({
              targetVariantId,
              productName: asString(oi?.product_name) || "Sản phẩm đổi",
              productImage: asString(oi?.product_image) || "",
              quantity: qty,
              unitPrice
            });
          }
        }

        if (subtotal <= 0) {
          subtotal = asNumber(ret.refundable_amount) || asNumber(original.total_amount) || 100000;
        }

        const code = "EXC" + Math.random().toString(36).substring(2, 8).toUpperCase() + Date.now().toString().slice(-4);
        const newOrder = asJsonObject(await insertRow("orders", {
          user_id: original.user_id || null,
          order_code: code,
          status: "confirmed",
          shipping_name: original.shipping_name,
          shipping_phone: original.shipping_phone,
          shipping_email: original.shipping_email || null,
          shipping_address: original.shipping_address,
          subtotal,
          discount_amount: subtotal,
          total_amount: 0,
          shipping_fee: 0,
          payment_method: "COD",
          is_guest: Boolean(original.is_guest),
          stock_committed_at: new Date().toISOString(),
          internal_note: `Replacement funded by original returned merchandise: ${returnId}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }));

        const newOrderId = asString(newOrder.order_id);

        for (const line of exchangeLines) {
          if (line.targetVariantId) {
            await insertRow("order_item", {
              order_id: newOrderId,
              variant_id: line.targetVariantId,
              product_name: line.productName,
              product_image: line.productImage || null,
              quantity: line.quantity,
              unit_price: line.unitPrice,
              subtotal_item: line.quantity * line.unitPrice
            }).catch(() => null);

            const variant = await selectOne("variant", {
              select: "variant_id,stock_quantity,version",
              variant_id: `eq.${line.targetVariantId}`
            }).catch(() => null);
            if (variant) {
              const currentStock = asNumber(variant.stock_quantity);
              await updateRows("variant", {
                variant_id: `eq.${line.targetVariantId}`
              }, {
                stock_quantity: Math.max(0, currentStock - line.quantity),
                version: asNumber(variant.version) + 1,
                updated_at: new Date().toISOString()
              }).catch(() => null);
            }
          }
        }

        const updatedRows = await updateRows("return_exchange", {
          return_id: `eq.${returnId}`,
          version: `eq.${expectedVersion}`
        }, {
          status: "EXCHANGE_PREPARING",
          exchange_order_id: newOrderId,
          version: expectedVersion + 1,
          updated_at: new Date().toISOString()
        });

        if (!updatedRows.length) {
          throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user");
        }

        const updatedReturn = asJsonObject(updatedRows[0]);

        await writeAuditLog({
          actor_id: actorId,
          actor_role: "admin_operator_cskh_dt",
          action: "update",
          module: "returns",
          target_id: returnId,
          new_value: updatedReturn,
          ip_address: ipAddress || "127.0.0.1",
          timestamp: new Date().toISOString()
        }).catch(() => null);

        return updatedReturn;
      }
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

    async listReturnLines(returnId: string, accessToken: string) {
      let res = await selectRows("return_item", {
        select: "return_item_id,order_item_id,quantity",
        return_id: `eq.${returnId}`,
        limit: 50
      }, authOptions(accessToken)).catch(() => null);
      if (!res) {
        res = await selectRows("return_item", {
          select: "return_item_id,order_item_id,quantity",
          return_id: `eq.${returnId}`,
          limit: 50
        });
      }
      return res;
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

      // Nếu đơn COD đã giao thành công mà chưa có dòng payment (thu tiền mặt), tự động tạo dòng ghi nhận tiền đã thu
      const order = await selectOne("orders", {
        select: "order_id,status,payment_method,total_amount,delivered_at",
        order_id: `eq.${orderId}`
      }).catch(() => null);

      if (order && asString(order.payment_method).toUpperCase() === "COD" && asString(order.status) === "delivered") {
        try {
          const inserted = await insertRow("payment", {
            order_id: orderId,
            amount: asNumber(order.total_amount),
            payment_method: "COD",
            payment_provider: "cod",
            payment_status: "paid",
            paid_at: order.delivered_at || new Date().toISOString()
          });
          return asJsonObject(inserted);
        } catch {
          return null;
        }
      }
      return null;
    },

    /**
     * Cập nhật trạng thái payment thành 'paid' (dùng khi COD đã giao hàng hoặc kế toán xác nhận).
     */
    async markPaymentPaid(paymentId: string) {
      return updateRows("payment", { payment_id: `eq.${paymentId}` }, {
        payment_status: "paid",
        paid_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
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

    async approveRefund(returnId: string, input: ApproveRefundInput, actorId: string, actorRole: string, ipAddress: string | undefined) {
      const current = await selectOne("return_exchange", {
        select: RETURN_SELECT,
        return_id: `eq.${returnId}`
      });
      if (!current) {
        throw new HttpError(404, "RETURN_NOT_FOUND", "Return record not found");
      }
      if (current.version !== input.expectedVersion) {
        throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user");
      }
      if (!["REQUESTED", "CONTACTING", "pending"].includes(asString(current.status))) {
        throw new HttpError(422, "RETURN_NOT_PENDING", "Yêu cầu đổi/trả không ở trạng thái chờ duyệt");
      }
      if (!input.refundAmount || input.refundAmount <= 0) {
        throw new HttpError(422, "REFUND_AMOUNT_REQUIRED", "Refund amount must be positive");
      }

      const note = typeof input.adminNote === "string" ? input.adminNote.trim() : "";
      const currentNote = asString(current.admin_note);
      const contacted = /\[CSKH(?:\s|\])/.test(currentNote);
      if (!contacted && note.length < 10) {
        throw new HttpError(422, "CONTACT_OR_REASON_REQUIRED", "Chưa ghi nhận liên hệ CSKH. Duyệt khi chưa liên hệ phải có lý do ít nhất 10 ký tự.");
      }
      const combinedRefundNote = note ? (currentNote ? `${currentNote}\n[Duyệt hoàn] ${note}` : note) : currentNote;
      const payload: JsonObject = {
        status: "WAITING_RETURN",
        refund_amount: input.refundAmount,
        admin_note: combinedRefundNote,
        resolved_at: new Date().toISOString(),
        version: asNumber(current.version) + 1,
        updated_at: new Date().toISOString()
      };

      const rows = await updateRows("return_exchange", {
        return_id: `eq.${returnId}`,
        version: `eq.${input.expectedVersion}`
      }, payload);

      if (!rows.length) {
        throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user or does not exist");
      }

      const updated = asJsonObject(rows[0]);
      if (current.user_id) {
        const order = await selectOne("orders", { order_id: `eq.${current.order_id}`, select: "order_id,order_code" }).catch(() => null);
        await createNotification(
          asString(current.user_id),
          "return_approved",
          "Yêu cầu hoàn tiền đã được duyệt",
          `Yêu cầu hoàn tiền cho đơn #${asString(order?.order_code || current.order_id || returnId)} đã được duyệt.`,
          `/account/orders/${asString(current.order_id)}`
        );
      }
      await writeAuditLog({
        actor_id: actorId,
        actor_role: actorRole,
        action: "approve",
        module: "returns",
        target_id: returnId,
        old_value: { status: current.status, version: current.version },
        new_value: { status: updated.status, version: updated.version, refund_amount: updated.refund_amount },
        ip_address: ipAddress || "127.0.0.1",
        timestamp: new Date().toISOString()
      });

      return updated;
    },

    async approveExchange(returnId: string, input: ApproveExchangeInput, actorId: string, actorRole: string, ipAddress: string | undefined) {
      const current = await selectOne("return_exchange", {
        select: RETURN_SELECT,
        return_id: `eq.${returnId}`
      });
      if (!current) {
        throw new HttpError(404, "RETURN_NOT_FOUND", "Return record not found");
      }
      if (current.version !== input.expectedVersion) {
        throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user");
      }
      if (!["REQUESTED", "CONTACTING", "pending"].includes(asString(current.status))) {
        throw new HttpError(422, "RETURN_NOT_PENDING", "Yêu cầu đổi/trả không ở trạng thái chờ duyệt");
      }

      const note = typeof input.adminNote === "string" ? input.adminNote.trim() : "";
      const currentNote = asString(current.admin_note);
      const combinedExchangeNote = note ? (currentNote ? `${currentNote}\n[Duyệt đổi] ${note}` : note) : currentNote;
      const payload: JsonObject = {
        status: "WAITING_RETURN",
        admin_note: combinedExchangeNote,
        resolved_at: new Date().toISOString(),
        version: asNumber(current.version) + 1,
        updated_at: new Date().toISOString()
      };

      const rows = await updateRows("return_exchange", {
        return_id: `eq.${returnId}`,
        version: `eq.${input.expectedVersion}`
      }, payload);

      if (!rows.length) {
        throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user or does not exist");
      }

      const updated = asJsonObject(rows[0]);
      await writeAuditLog({
        actor_id: actorId,
        actor_role: actorRole,
        action: "approve",
        module: "returns",
        target_id: returnId,
        old_value: { status: current.status, version: current.version },
        new_value: { status: updated.status, version: updated.version },
        ip_address: ipAddress || "127.0.0.1",
        timestamp: new Date().toISOString()
      });

      return updated;
    },

    async reject(returnId: string, input: RejectReturnInput, actorId: string, actorRole: string, ipAddress: string | undefined) {
      const current = await selectOne("return_exchange", {
        select: RETURN_SELECT,
        return_id: `eq.${returnId}`
      });
      if (!current) {
        throw new HttpError(404, "RETURN_NOT_FOUND", "Return record not found");
      }
      if (current.version !== input.expectedVersion) {
        throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user");
      }
      // NEEDS_SUPPORT is closable: CSKH stops forwarding a request the warehouse could not accept, which releases its hold.
      if (!["REQUESTED", "CONTACTING", "WAITING_RETURN", "NEEDS_SUPPORT", "pending"].includes(asString(current.status))) {
        throw new HttpError(422, "RETURN_NOT_PENDING", "Yêu cầu đổi/trả không ở trạng thái có thể từ chối/hủy");
      }
      if (!input.reason || input.reason.trim().length < 10) {
        throw new HttpError(422, "VALIDATION_ERROR", "Reason must be at least 10 characters");
      }

      const payload: JsonObject = {
        status: "CANCELLED",
        rejection_reason: input.reason.trim(),
        cancelled_by: "admin",
        resolved_at: new Date().toISOString(),
        version: asNumber(current.version) + 1,
        updated_at: new Date().toISOString()
      };
      if (input.imageProof) {
        payload.evidence_images = [input.imageProof];
      }

      const rows = await updateRows("return_exchange", {
        return_id: `eq.${returnId}`,
        version: `eq.${input.expectedVersion}`
      }, payload);

      if (!rows.length) {
        throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user or does not exist");
      }

      const updated = asJsonObject(rows[0]);
      await writeAuditLog({
        actor_id: actorId,
        actor_role: actorRole,
        action: "reject",
        module: "returns",
        target_id: returnId,
        old_value: { status: current.status, version: current.version },
        new_value: { status: updated.status, version: updated.version },
        ip_address: ipAddress || "127.0.0.1",
        timestamp: new Date().toISOString()
      });

      return updated;
    },

    async updateReturnStatus(returnId: string, input: UpdateReturnStatusInput, actorId: string, actorRole: string, ipAddress: string | undefined) {
      const current = await selectOne("return_exchange", {
        select: RETURN_SELECT,
        return_id: `eq.${returnId}`
      });
      if (!current) {
        throw new HttpError(404, "RETURN_NOT_FOUND", "Return record not found");
      }
      if (current.version !== input.expectedVersion) {
        throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user");
      }

      const payload: JsonObject = {
        status: input.status,
        version: asNumber(current.version) + 1,
        updated_at: new Date().toISOString()
      };
      if (input.adminNote !== undefined) payload.admin_note = input.adminNote;
      if (input.reason !== undefined) payload.rejection_reason = input.reason;
      if (input.refundAmount !== undefined && input.refundAmount !== null) payload.refund_amount = input.refundAmount;
      if (input.trackingReturnCode !== undefined) payload.tracking_return_code = input.trackingReturnCode;
      if (input.receipts !== undefined) payload.qa_item_receipts = input.receipts;
      if (input.imageProof !== undefined && input.status === "RECEIVED") payload.warehouse_proof = input.imageProof;
      if (input.trackingReturnCode !== undefined && input.status === "EXCHANGE_SHIPPING") {
        payload.exchange_tracking_code = input.trackingReturnCode;
        if (current.exchange_order_id) {
          await updateRows("orders", {
            order_id: `eq.${current.exchange_order_id}`
          }, {
            status: "shipping",
            updated_at: new Date().toISOString()
          }).catch(() => null);
        }
      }
      if (input.conditionCheckResult !== undefined) payload.condition_check_result = input.conditionCheckResult;
      if (input.imageProof !== undefined && input.imageProof !== null) {
        const existing = Array.isArray(current.evidence_images) ? current.evidence_images.map(String) : [];
        payload.evidence_images = [...existing, String(input.imageProof)];
      }

      if (["COMPLETED", "CANCELLED"].includes(input.status)) {
        payload.resolved_at = new Date().toISOString();
      }
      // Only the admin API reaches this method; a customer cancels through the storefront service instead.
      if (input.status === "CANCELLED") payload.cancelled_by = "admin";

      if (input.status === "COMPLETED" && current.return_type === "exchange") {
        const excId = asString(current.exchange_order_id);
        if (excId) {
          await updateRows("orders", {
            order_id: `eq.${excId}`
          }, {
            status: "delivered",
            delivered_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }).catch(() => null);
        }
      }

      const rows = await updateRows("return_exchange", {
        return_id: `eq.${returnId}`,
        version: `eq.${input.expectedVersion}`
      }, payload);

      if (!rows.length) {
        throw new HttpError(409, "VERSION_CONFLICT", "Return record has been modified by another user or does not exist");
      }

      // Map status to a valid audit_action enum value
      // Valid values: create, update, delete, approve, reject, lock, unlock
      const auditAction = input.status === "CANCELLED" ? "reject"
        : input.status === "WAITING_RETURN" ? "approve"
        : "update";

      const updated = asJsonObject(rows[0]);
      await writeAuditLog({
        actor_id: actorId,
        actor_role: actorRole,
        action: auditAction,
        module: "returns",
        target_id: returnId,
        old_value: { status: current.status, version: current.version },
        new_value: { status: updated.status, version: updated.version, transition: `${current.status} → ${input.status}` },
        ip_address: ipAddress || "127.0.0.1",
        timestamp: new Date().toISOString()
      });

      return updated;
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
        status: ["REQUESTED","NEEDS_SUPPORT"].includes(asString(current.status)) ? "CONTACTING" : current.status,
        admin_note: adminNote,
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

/** Vietnamese messages for the stable error codes raised by migrations 068/069 (`raise sqlstate ... using message`). */
const RETURN_DATABASE_ERRORS: Readonly<Record<string, { status: number; message: string }>> = {
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
