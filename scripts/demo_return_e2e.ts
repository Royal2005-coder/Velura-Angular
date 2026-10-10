import { selectRows, selectOne, insertRow, updateRows } from "../apps/api/src/supabase.js";
import { createReturnRepository } from "../apps/api/src/returns/return-repository.js";
import { createReturnService } from "../apps/api/src/returns/return-service.js";

async function runDemo() {
  console.log("================================================================================");
  console.log("           DEMO LUỒNG ĐỔI TRẢ & HOÀN TIỀN END-TO-END (CHÍNH THỨC)               ");
  console.log("================================================================================\n");

  const repo = createReturnRepository();
  const service = createReturnService({ repository: repo });

  // 1. Tạo đơn hàng mới hoàn toàn cho buổi demo (status: delivered)
  console.log("[BƯỚC 1] Khởi tạo đơn hàng đã giao (status: delivered) kèm thanh toán COD...");
  const variant = (await selectRows("variant", { limit: 1 })).rows[0];
  const product = (await selectRows("product", { product_id: `eq.${variant.product_id}` })).rows[0];
  const user = (await selectRows("users", { limit: 1 })).rows[0];
  const orderCode = "DEMO" + Date.now().toString().slice(-6);

  const order = await insertRow("orders", {
    order_code: orderCode,
    user_id: user.user_id,
    status: "delivered",
    payment_method: "COD",
    subtotal: 500000,
    total_amount: 500000,
    shipping_name: "Nguyễn Văn Khách",
    shipping_phone: "0987654321",
    shipping_address: "123 Lê Lợi, Phường Bến Nghé, Quận 1, TP.HCM"
  });

  const orderItem = await insertRow("order_item", {
    order_id: order.order_id,
    variant_id: variant.variant_id,
    product_name: product.name || "Áo Sơ Mi Lụa Cao Cấp",
    quantity: 1,
    unit_price: 500000,
    subtotal_item: 500000
  });

  const payment = await insertRow("payment", {
    order_id: order.order_id,
    payment_method: "COD",
    payment_provider: "cod",
    amount: 500000,
    payment_status: "paid",
    paid_at: new Date().toISOString()
  });

  console.log(`✓ Đơn hàng: #${order.order_code} (ID: ${order.order_id})`);
  console.log(`✓ Mặt hàng: ${orderItem.product_name} (Item ID: ${orderItem.item_id}, Số lượng: ${orderItem.quantity}, Đơn giá: 500.000đ)`);
  console.log(`✓ Thanh toán COD: ID ${payment.payment_id}, Trạng thái: paid, Số tiền: 500.000đ\n`);

  // 2. Tạo phiếu yêu cầu đổi trả (REQUESTED)
  console.log("[BƯỚC 2] Khách hàng tạo phiếu yêu cầu trả hàng & hoàn tiền (REQUESTED)...");
  const returnRow = await insertRow("return_exchange", {
    order_id: order.order_id,
    user_id: user.user_id,
    return_type: "refund",
    status: "REQUESTED",
    description: "Sản phẩm không vừa form, yêu cầu trả hàng hoàn tiền qua số tài khoản.",
    refund_amount: 500000,
    contact_due_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    evidence_images: ["https://images.unsplash.com/photo-1523381294911-8d3cead13475?w=500"]
  });

  const returnId = returnRow.return_id;
  console.log(`✓ Tạo phiếu thành công! ID: ${returnId}`);
  console.log(`  - Trạng thái: ${returnRow.status}`);
  console.log(`  - Loại yêu cầu: ${returnRow.return_type}`);
  console.log(`  - Số tiền dự kiến hoàn: 500.000đ`);

  await insertRow("return_item", {
    return_id: returnId,
    order_item_id: orderItem.item_id,
    quantity: orderItem.quantity
  });
  console.log(`✓ Đã liên kết dòng hàng return_item (${orderItem.item_id})\n`);

  // Context admin từ user admin trong database
  const adminUsers = await selectRows("users", { role: "eq.admin", limit: 1 });
  const adminUser = adminUsers.rows[0];
  const adminContext: any = {
    authUser: { id: adminUser.user_id, email: adminUser.email },
    profile: { user_id: adminUser.user_id },
    roleCode: adminUser.admin_role || "super_admin",
    accessToken: "",
    ipAddress: "127.0.0.1"
  };
  console.log(`✓ Nhân viên xử lý: ${adminUser.full_name || adminUser.email} (Role: ${adminContext.roleCode})\n`);

  // 3. Admin CSKH tiếp nhận & liên hệ khách (REQUESTED -> CONTACTING)
  console.log("[BƯỚC 3] CSKH gọi điện xác nhận yêu cầu trả hàng (REQUESTED -> CONTACTING)...");
  let current = await repo.getReturn(returnId, "");
  let updated = await repo.updateReturnStatus(returnId, {
    status: "CONTACTING",
    expectedVersion: Number(current?.version),
    adminNote: "[CSKH] Đã gọi điện cho khách hàng lúc " + new Date().toLocaleTimeString("vi-VN") + ", khách xác nhận gửi trả bưu cục."
  }, adminContext.profile.user_id, adminContext.roleCode, adminContext.ipAddress);
  console.log(`✓ Cập nhật trạng thái: ${updated.status} (version ${updated.version})`);
  console.log(`  Ghi chú CSKH: ${updated.admin_note}\n`);

  // 4. Admin duyệt hoàn tiền (CONTACTING -> WAITING_RETURN)
  console.log("[BƯỚC 4] Admin duyệt hoàn tiền (CONTACTING -> WAITING_RETURN)...");
  current = await repo.getReturn(returnId, "");
  updated = await repo.approveRefund(returnId, {
    expectedVersion: Number(current?.version),
    refundAmount: 500000,
    adminNote: "[CSKH] Đồng ý hoàn tiền 100% (500.000đ) sau khi kiểm tra nhận hàng tại kho."
  }, adminContext.profile.user_id, adminContext.roleCode, adminContext.ipAddress);
  console.log(`✓ Cập nhật trạng thái: ${updated.status} (version ${updated.version})`);
  console.log(`  Số tiền hoàn duyệt: 500.000đ\n`);

  // 5. Khách gửi hàng trả về (WAITING_RETURN -> RETURN_IN_TRANSIT)
  console.log("[BƯỚC 5] Khách hàng mang hàng ra bưu điện gửi về kho (WAITING_RETURN -> RETURN_IN_TRANSIT)...");
  current = await repo.getReturn(returnId, "");
  updated = await repo.updateReturnStatus(returnId, {
    status: "RETURN_IN_TRANSIT",
    expectedVersion: Number(current?.version),
    trackingReturnCode: "VNPOST-RET-998877"
  }, adminContext.profile.user_id, adminContext.roleCode, adminContext.ipAddress);
  console.log(`✓ Cập nhật trạng thái: ${updated.status} (version ${updated.version})`);
  console.log(`  Mã vận đơn gửi trả: ${updated.tracking_return_code}\n`);

  // 6. Kho nhận hàng & QA kiểm định chất lượng (RETURN_IN_TRANSIT -> RECEIVED)
  console.log("[BƯỚC 6] Kho tiếp nhận kiện hàng & thực hiện kiểm định QA (RETURN_IN_TRANSIT -> RECEIVED)...");
  current = await repo.getReturn(returnId, "");
  const qaReceipts = [{
    orderItemId: orderItem.item_id,
    expectedQuantity: 1,
    receivedQuantity: 1,
    confirmedItemId: orderItem.item_id,
    matchesProduct: true
  }];
  updated = await repo.updateReturnStatus(returnId, {
    status: "RECEIVED",
    expectedVersion: Number(current?.version),
    conditionCheckResult: "qa_pass",
    imageProof: "https://images.unsplash.com/photo-1558769132-cb1aea458c5e?w=500",
    receipts: qaReceipts
  }, adminContext.profile.user_id, adminContext.roleCode, adminContext.ipAddress);
  console.log(`✓ Cập nhật trạng thái: ${updated.status} (version ${updated.version})`);
  console.log(`  Kết quả QA: ${updated.condition_check_result} (Đúng hàng của shop, nguyên tem mác)`);
  console.log(`  Minh chứng nhận hàng kho: ${updated.warehouse_proof}\n`);

  // 7. Kế toán chuyển khoản & Ghi nhận hoàn tiền (RECEIVED -> REFUNDED)
  console.log("[BƯỚC 7] Kế toán thực hiện chuyển khoản hoàn tiền & ghi nhận chứng từ...");
  console.log("  [Kiểm thử 1: Nhập mã giao dịch ngắn < 6 ký tự như ảnh người dùng chụp ('123')]");
  try {
    await service.recordManualRefund(adminContext, returnId, {
      expectedVersion: Number(updated.version),
      transferReference: "123",
      adminNote: "Chuyển tiền hoàn cho khách",
      imageProof: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    });
    console.error("  LỖI: Mã ngắn mà không bị chặn!");
  } catch (err: any) {
    console.log(`  ✓ ĐÃ BẮT LỖI CLIENT & BACKEND CHÍNH XÁC: "${err.message}" (Mã lỗi: ${err.code})`);
  }

  current = await repo.getReturn(returnId, "");
  const transferRef = "FT" + Date.now().toString().slice(-8);
  console.log(`  [Kiểm thử 2: Chuyển khoản hoàn tiền hợp lệ với mã ${transferRef}]`);
  const refundResult = await service.recordManualRefund(adminContext, returnId, {
    expectedVersion: Number(current?.version),
    transferReference: transferRef,
    adminNote: "Đã chuyển khoản thành công 500.000đ vào số tài khoản VCB 0123456789 của khách hàng.",
    imageProof: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  });
  console.log(`  ✓ Ghi nhận chuyển khoản thành công!`);

  current = await repo.getReturn(returnId, "");
  console.log(`✓ Trạng thái phiếu sau hoàn tiền: ${current?.status}`);
  console.log(`  Số tiền đã hoàn: ${Number(current?.refund_amount).toLocaleString("vi-VN")}đ`);

  const refundRows = await selectRows("payment_refund", { return_id: `eq.${returnId}` });
  console.log(`  Bản ghi payment_refund: ${refundRows.rows?.length} dòng, Trạng thái: ${refundRows.rows?.[0]?.status}, Provider Ref: ${refundRows.rows?.[0]?.provider_ref}\n`);

  // 8. Hoàn tất yêu cầu (REFUNDED -> COMPLETED)
  console.log("[BƯỚC 8] Admin xác nhận hoàn tất yêu cầu (REFUNDED -> COMPLETED)...");
  current = await repo.getReturn(returnId, "");
  updated = await repo.updateReturnStatus(returnId, {
    status: "COMPLETED",
    expectedVersion: Number(current?.version),
    adminNote: "Hoàn tất chu trình đổi trả & hoàn tiền. Khách hàng đã nhận được 500.000đ và xác nhận hài lòng."
  }, adminContext.profile.user_id, adminContext.roleCode, adminContext.ipAddress);
  console.log(`✓ Trạng thái cuối cùng: ${updated.status} (version ${updated.version})`);
  console.log(`  Thời gian giải quyết: ${updated.resolved_at}\n`);

  // 9. Kiểm tra audit log & return event log
  console.log("[BƯỚC 9] Kiểm tra nhật ký kiểm toán (return_event & audit_log)...");
  const events = await selectRows("return_event", { return_id: `eq.${returnId}`, order: "created_at.asc" });
  console.log(`✓ Ghi nhận ${events.rows.length} sự kiện chuyển trạng thái trong return_event:`);
  for (let i = 0; i < events.rows.length; i++) {
    const ev = events.rows[i];
    console.log(`  ${i + 1}. [${new Date(ev.created_at).toLocaleTimeString("vi-VN")}] ${ev.old_status || 'INIT'} ──> ${ev.new_status} | Ghi chú: ${ev.note || '—'}`);
  }

  console.log("\n================================================================================");
  console.log("       KẾT THÚC DEMO: TOÀN BỘ LUỒNG ĐỔI TRẢ & HOÀN TIỀN THÀNH CÔNG 100%!        ");
  console.log("================================================================================");
}

runDemo().catch(console.error);
