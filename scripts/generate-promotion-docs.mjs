import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, HeadingLevel, AlignmentType, ImageRun, ShadingType
} from 'docx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BA_DIR = join(ROOT, 'docs', 'ba');
mkdirSync(BA_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════════════════════
// 1. CHUẨN HÓA BPMN 2.0 XML (bpmn.io standard schema)
// ═══════════════════════════════════════════════════════════════════════════
const bpmn2Xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
                  id="Definitions_Velura_Promo_3113"
                  targetNamespace="http://bpmn.io/schema/bpmn"
                  exporter="Velura Business Process Model"
                  exporterVersion="3.1.13">

  <bpmn:collaboration id="Collaboration_Velura_Promotion">
    <bpmn:participant id="Participant_Admin" name="Velura Admin Dashboard" processRef="Process_Admin_Promotion" />
    <bpmn:participant id="Participant_User" name="Velura Storefront (Khách hàng)" processRef="Process_User_Promotion" />
    <bpmn:participant id="Participant_API" name="Velura API Server (Định giá &amp; Giao dịch)" processRef="Process_API_Promotion" />
    
    <bpmn:messageFlow id="MsgFlow_VoucherSync" name="Mã xuất hiện trong ví voucher khách hàng" sourceRef="Admin_T5_RPC" targetRef="User_T1_BrowseOffers" />
    <bpmn:messageFlow id="MsgFlow_SubmitOrder" name="Gửi yêu cầu tạo đơn (kèm voucher_id)" sourceRef="User_T7_SubmitOrder" targetRef="API_Start_ReceiveOrder" />
    <bpmn:messageFlow id="MsgFlow_OrderFeedback" name="Xác nhận kết quả đơn hàng &amp; số tiền thực thu" sourceRef="API_T5_PersistOrder" targetRef="User_End_OrderCreated" />
  </bpmn:collaboration>

  <!-- ======================== PROCESS: ADMIN ======================== -->
  <bpmn:process id="Process_Admin_Promotion" isExecutable="false">
    <bpmn:laneSet id="LaneSet_Admin">
      <bpmn:lane id="Lane_AdminOperator" name="Quản trị viên Quản lý Giá &amp; Khuyến mãi">
        <bpmn:flowNodeRef>Admin_Start</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Admin_T1_OpenWorkspace</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Admin_G1_SelectAction</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Admin_T2_CreateCampaign</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Admin_T3_IssueVoucher</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Admin_T4_UpdateVoucher</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Admin_T6_ToggleStatus</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Admin_T8_ViewAnalytics</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Admin_G3_MergeActions</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Admin_End</bpmn:flowNodeRef>
      </bpmn:lane>
      <bpmn:lane id="Lane_AdminSystem" name="Hệ thống Quản trị (Admin Engine &amp; RPC)">
        <bpmn:flowNodeRef>Admin_G2_ValidatePayload</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Admin_T5_RPC</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Admin_T7_CeilingBudget</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>

    <bpmn:startEvent id="Admin_Start" name="Mở phân hệ Khuyến mãi">
      <bpmn:outgoing>Seq_A1</bpmn:outgoing>
    </bpmn:startEvent>

    <bpmn:userTask id="Admin_T1_OpenWorkspace" name="Xem danh sách chiến dịch, mã voucher, combo &amp; thống kê">
      <bpmn:incoming>Seq_A1</bpmn:incoming>
      <bpmn:outgoing>Seq_A2</bpmn:outgoing>
    </bpmn:userTask>

    <bpmn:exclusiveGateway id="Admin_G1_SelectAction" name="Lựa chọn nghiệp vụ?">
      <bpmn:incoming>Seq_A2</bpmn:incoming>
      <bpmn:outgoing>Seq_A3_Campaign</bpmn:outgoing>
      <bpmn:outgoing>Seq_A3_IssueVoucher</bpmn:outgoing>
      <bpmn:outgoing>Seq_A3_UpdateVoucher</bpmn:outgoing>
      <bpmn:outgoing>Seq_A3_Toggle</bpmn:outgoing>
      <bpmn:outgoing>Seq_A3_Analytics</bpmn:outgoing>
    </bpmn:exclusiveGateway>

    <bpmn:userTask id="Admin_T2_CreateCampaign" name="Thiết lập chiến dịch: tên, thời gian hiệu lực, trần ngân sách">
      <bpmn:incoming>Seq_A3_Campaign</bpmn:incoming>
      <bpmn:outgoing>Seq_A4_ToVal1</bpmn:outgoing>
    </bpmn:userTask>

    <bpmn:userTask id="Admin_T3_IssueVoucher" name="Phát hành mã: code, loại giảm, đơn tối thiểu, nhóm đối tượng, hạn dùng">
      <bpmn:incoming>Seq_A3_IssueVoucher</bpmn:incoming>
      <bpmn:outgoing>Seq_A4_ToVal2</bpmn:outgoing>
    </bpmn:userTask>

    <bpmn:userTask id="Admin_T4_UpdateVoucher" name="Chỉnh sửa mã: điều chỉnh giá trị, trần giảm, lượt dùng, nhóm áp dụng">
      <bpmn:incoming>Seq_A3_UpdateVoucher</bpmn:incoming>
      <bpmn:outgoing>Seq_A4_ToVal3</bpmn:outgoing>
    </bpmn:userTask>

    <bpmn:exclusiveGateway id="Admin_G2_ValidatePayload" name="Dữ liệu hợp lệ?">
      <bpmn:incoming>Seq_A4_ToVal1</bpmn:incoming>
      <bpmn:incoming>Seq_A4_ToVal2</bpmn:incoming>
      <bpmn:incoming>Seq_A4_ToVal3</bpmn:incoming>
      <bpmn:outgoing>Seq_A5_Valid</bpmn:outgoing>
      <bpmn:outgoing>Seq_A5_Invalid</bpmn:outgoing>
    </bpmn:exclusiveGateway>

    <bpmn:serviceTask id="Admin_T5_RPC" name="Gọi RPC bảo mật (security definer), thẩm định quyền &amp; ghi audit_log">
      <bpmn:incoming>Seq_A5_Valid</bpmn:incoming>
      <bpmn:outgoing>Seq_A6_ToCeiling</bpmn:outgoing>
    </bpmn:serviceTask>

    <bpmn:serviceTask id="Admin_T7_CeilingBudget" name="Tính trần mã phát hành = Ngân sách / Trần giảm tối đa">
      <bpmn:incoming>Seq_A6_ToCeiling</bpmn:incoming>
      <bpmn:outgoing>Seq_A7_CeilingDone</bpmn:outgoing>
    </bpmn:serviceTask>

    <bpmn:userTask id="Admin_T6_ToggleStatus" name="Bật / Tạm dừng chiến dịch hoặc mã (kèm expectedVersion)">
      <bpmn:incoming>Seq_A3_Toggle</bpmn:incoming>
      <bpmn:outgoing>Seq_A7_ToggleDone</bpmn:outgoing>
    </bpmn:userTask>

    <bpmn:userTask id="Admin_T8_ViewAnalytics" name="Xem báo cáo thống kê: tỷ lệ dùng, doanh thu đơn có mã, đối soát thực chi">
      <bpmn:incoming>Seq_A3_Analytics</bpmn:incoming>
      <bpmn:outgoing>Seq_A7_AnalyticsDone</bpmn:outgoing>
    </bpmn:userTask>

    <bpmn:exclusiveGateway id="Admin_G3_MergeActions">
      <bpmn:incoming>Seq_A7_CeilingDone</bpmn:incoming>
      <bpmn:incoming>Seq_A7_ToggleDone</bpmn:incoming>
      <bpmn:incoming>Seq_A7_AnalyticsDone</bpmn:incoming>
      <bpmn:incoming>Seq_A5_Invalid</bpmn:incoming>
      <bpmn:outgoing>Seq_A8_End</bpmn:outgoing>
    </bpmn:exclusiveGateway>

    <bpmn:endEvent id="Admin_End" name="Hoàn tất tác vụ">
      <bpmn:incoming>Seq_A8_End</bpmn:incoming>
    </bpmn:endEvent>

    <bpmn:sequenceFlow id="Seq_A1" sourceRef="Admin_Start" targetRef="Admin_T1_OpenWorkspace" />
    <bpmn:sequenceFlow id="Seq_A2" sourceRef="Admin_T1_OpenWorkspace" targetRef="Admin_G1_SelectAction" />
    <bpmn:sequenceFlow id="Seq_A3_Campaign" name="Tạo chiến dịch" sourceRef="Admin_G1_SelectAction" targetRef="Admin_T2_CreateCampaign" />
    <bpmn:sequenceFlow id="Seq_A3_IssueVoucher" name="Phát hành mã" sourceRef="Admin_G1_SelectAction" targetRef="Admin_T3_IssueVoucher" />
    <bpmn:sequenceFlow id="Seq_A3_UpdateVoucher" name="Sửa mã" sourceRef="Admin_G1_SelectAction" targetRef="Admin_T4_UpdateVoucher" />
    <bpmn:sequenceFlow id="Seq_A3_Toggle" name="Bật/Tắt" sourceRef="Admin_G1_SelectAction" targetRef="Admin_T6_ToggleStatus" />
    <bpmn:sequenceFlow id="Seq_A3_Analytics" name="Thống kê" sourceRef="Admin_G1_SelectAction" targetRef="Admin_T8_ViewAnalytics" />
    <bpmn:sequenceFlow id="Seq_A4_ToVal1" sourceRef="Admin_T2_CreateCampaign" targetRef="Admin_G2_ValidatePayload" />
    <bpmn:sequenceFlow id="Seq_A4_ToVal2" sourceRef="Admin_T3_IssueVoucher" targetRef="Admin_G2_ValidatePayload" />
    <bpmn:sequenceFlow id="Seq_A4_ToVal3" sourceRef="Admin_T4_UpdateVoucher" targetRef="Admin_G2_ValidatePayload" />
    <bpmn:sequenceFlow id="Seq_A5_Valid" name="Hợp lệ" sourceRef="Admin_G2_ValidatePayload" targetRef="Admin_T5_RPC" />
    <bpmn:sequenceFlow id="Seq_A5_Invalid" name="Không hợp lệ (Báo lỗi)" sourceRef="Admin_G2_ValidatePayload" targetRef="Admin_G3_MergeActions" />
    <bpmn:sequenceFlow id="Seq_A6_ToCeiling" sourceRef="Admin_T5_RPC" targetRef="Admin_T7_CeilingBudget" />
    <bpmn:sequenceFlow id="Seq_A7_CeilingDone" sourceRef="Admin_T7_CeilingBudget" targetRef="Admin_G3_MergeActions" />
    <bpmn:sequenceFlow id="Seq_A7_ToggleDone" sourceRef="Admin_T6_ToggleStatus" targetRef="Admin_G3_MergeActions" />
    <bpmn:sequenceFlow id="Seq_A7_AnalyticsDone" sourceRef="Admin_T8_ViewAnalytics" targetRef="Admin_G3_MergeActions" />
    <bpmn:sequenceFlow id="Seq_A8_End" sourceRef="Admin_G3_MergeActions" targetRef="Admin_End" />
  </bpmn:process>

  <!-- ======================== PROCESS: USER ======================== -->
  <bpmn:process id="Process_User_Promotion" isExecutable="false">
    <bpmn:laneSet id="LaneSet_User">
      <bpmn:lane id="Lane_UserCustomer" name="Khách hàng">
        <bpmn:flowNodeRef>User_Start</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>User_T1_BrowseOffers</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>User_T3_ManageSelection</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>User_T7_SubmitOrder</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>User_End_OrderCreated</bpmn:flowNodeRef>
      </bpmn:lane>
      <bpmn:lane id="Lane_UserStorefrontEngine" name="Hệ thống Storefront (Voucher Engine &amp; Checkout)">
        <bpmn:flowNodeRef>User_T2_EvaluateWallet</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>User_T4_QuoteBestVoucher</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>User_G1_HasEligibleVoucher</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>User_T5_RenderDiscount</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>User_T6_ComputeShipping</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>

    <bpmn:startEvent id="User_Start" name="Truy cập Giỏ hàng hoặc Trang Ưu đãi">
      <bpmn:outgoing>Seq_U1</bpmn:outgoing>
    </bpmn:startEvent>

    <bpmn:userTask id="User_T1_BrowseOffers" name="Mở ví voucher: Dành riêng cho bạn, Đang diễn ra, Sắp hết hạn">
      <bpmn:incoming>Seq_U1</bpmn:incoming>
      <bpmn:outgoing>Seq_U2</bpmn:outgoing>
    </bpmn:userTask>

    <bpmn:serviceTask id="User_T2_EvaluateWallet" name="Chấm 8 bước điều kiện, lọc theo nhóm khách (guest/member), hiển thị lý do &amp; tiền thiếu">
      <bpmn:incoming>Seq_U2</bpmn:incoming>
      <bpmn:outgoing>Seq_U3</bpmn:outgoing>
    </bpmn:serviceTask>

    <bpmn:serviceTask id="User_T4_QuoteBestVoucher" name="Tự động áp mã tối ưu: Giảm nhiều nhất, ưu tiên hạn gần, cấm cộng dồn">
      <bpmn:incoming>Seq_U3</bpmn:incoming>
      <bpmn:outgoing>Seq_U4</bpmn:outgoing>
    </bpmn:serviceTask>

    <bpmn:userTask id="User_T3_ManageSelection" name="Giữ mã tự chọn, đổi sang mã khác, hoặc chủ động hủy bỏ mã">
      <bpmn:incoming>Seq_U4</bpmn:incoming>
      <bpmn:outgoing>Seq_U5</bpmn:outgoing>
    </bpmn:userTask>

    <bpmn:exclusiveGateway id="User_G1_HasEligibleVoucher" name="Khách dùng mã?">
      <bpmn:incoming>Seq_U5</bpmn:incoming>
      <bpmn:outgoing>Seq_U6_Yes</bpmn:outgoing>
      <bpmn:outgoing>Seq_U6_No</bpmn:outgoing>
    </bpmn:exclusiveGateway>

    <bpmn:serviceTask id="User_T5_RenderDiscount" name="Hiển thị mức giảm giá tạm tính">
      <bpmn:incoming>Seq_U6_Yes</bpmn:incoming>
      <bpmn:outgoing>Seq_U7_ToShip</bpmn:outgoing>
    </bpmn:serviceTask>

    <bpmn:serviceTask id="User_T6_ComputeShipping" name="Tính phí ship theo ngưỡng cấu hình từ server (đơn từ 500k miễn phí)">
      <bpmn:incoming>Seq_U6_No</bpmn:incoming>
      <bpmn:incoming>Seq_U7_ToShip</bpmn:incoming>
      <bpmn:outgoing>Seq_U8_ToOrder</bpmn:outgoing>
    </bpmn:serviceTask>

    <bpmn:userTask id="User_T7_SubmitOrder" name="Xác nhận thanh toán (Guest: OTP xác thực qua email; Member: địa chỉ lưu sẵn)">
      <bpmn:incoming>Seq_U8_ToOrder</bpmn:incoming>
      <bpmn:outgoing>Seq_U9_OrderPlaced</bpmn:outgoing>
    </bpmn:userTask>

    <bpmn:endEvent id="User_End_OrderCreated" name="Đơn hàng được khởi tạo">
      <bpmn:incoming>Seq_U9_OrderPlaced</bpmn:incoming>
    </bpmn:endEvent>

    <bpmn:sequenceFlow id="Seq_U1" sourceRef="User_Start" targetRef="User_T1_BrowseOffers" />
    <bpmn:sequenceFlow id="Seq_U2" sourceRef="User_T1_BrowseOffers" targetRef="User_T2_EvaluateWallet" />
    <bpmn:sequenceFlow id="Seq_U3" sourceRef="User_T2_EvaluateWallet" targetRef="User_T4_QuoteBestVoucher" />
    <bpmn:sequenceFlow id="Seq_U4" sourceRef="User_T4_QuoteBestVoucher" targetRef="User_T3_ManageSelection" />
    <bpmn:sequenceFlow id="Seq_U5" sourceRef="User_T3_ManageSelection" targetRef="User_G1_HasEligibleVoucher" />
    <bpmn:sequenceFlow id="Seq_U6_Yes" name="Áp dụng mã" sourceRef="User_G1_HasEligibleVoucher" targetRef="User_T5_RenderDiscount" />
    <bpmn:sequenceFlow id="Seq_U6_No" name="Không dùng / Bỏ mã" sourceRef="User_G1_HasEligibleVoucher" targetRef="User_T6_ComputeShipping" />
    <bpmn:sequenceFlow id="Seq_U7_ToShip" sourceRef="User_T5_RenderDiscount" targetRef="User_T6_ComputeShipping" />
    <bpmn:sequenceFlow id="Seq_U8_ToOrder" sourceRef="User_T6_ComputeShipping" targetRef="User_T7_SubmitOrder" />
    <bpmn:sequenceFlow id="Seq_U9_OrderPlaced" sourceRef="User_T7_SubmitOrder" targetRef="User_End_OrderCreated" />
  </bpmn:process>

  <!-- ======================== PROCESS: API SERVER ======================== -->
  <bpmn:process id="Process_API_Promotion" isExecutable="false">
    <bpmn:startEvent id="API_Start_ReceiveOrder" name="Nhận yêu cầu tạo đơn">
      <bpmn:outgoing>Seq_API1</bpmn:outgoing>
    </bpmn:startEvent>

    <bpmn:serviceTask id="API_T1_CatalogCheck" name="Tra cứu giá catalog theo variant_id &amp; đối chiếu unit_price">
      <bpmn:incoming>Seq_API1</bpmn:incoming>
      <bpmn:outgoing>Seq_API2</bpmn:outgoing>
    </bpmn:serviceTask>

    <bpmn:exclusiveGateway id="API_G1_PriceMatch" name="Giá catalog khớp?">
      <bpmn:incoming>Seq_API2</bpmn:incoming>
      <bpmn:outgoing>Seq_API3_Matched</bpmn:outgoing>
      <bpmn:outgoing>Seq_API3_Mismatch</bpmn:outgoing>
    </bpmn:exclusiveGateway>

    <bpmn:serviceTask id="API_T2_IndependentSubtotal" name="Máy chủ độc lập tính subtotal = tổng(giá_catalog x số_lượng)">
      <bpmn:incoming>Seq_API3_Matched</bpmn:incoming>
      <bpmn:outgoing>Seq_API4</bpmn:outgoing>
    </bpmn:serviceTask>

    <bpmn:serviceTask id="API_T3_EvaluateVoucherOnServer" name="Thẩm định lại mã tại server (evaluateVoucher) &amp; tính discount_amount chuẩn">
      <bpmn:incoming>Seq_API4</bpmn:incoming>
      <bpmn:outgoing>Seq_API5</bpmn:outgoing>
    </bpmn:serviceTask>

    <bpmn:serviceTask id="API_T4_FinalizeTotals" name="Xác định phí vận chuyển &amp; tổng thanh toán = subtotal + ship - discount">
      <bpmn:incoming>Seq_API5</bpmn:incoming>
      <bpmn:outgoing>Seq_API6</bpmn:outgoing>
    </bpmn:serviceTask>

    <bpmn:serviceTask id="API_T5_PersistOrder" name="Lưu đơn pending, tăng used_count &amp; trừ ngân sách kịch trần">
      <bpmn:incoming>Seq_API6</bpmn:incoming>
      <bpmn:outgoing>Seq_API7</bpmn:outgoing>
    </bpmn:serviceTask>

    <bpmn:endEvent id="API_End_Success" name="Tạo đơn thành công">
      <bpmn:incoming>Seq_API7</bpmn:incoming>
    </bpmn:endEvent>

    <bpmn:endEvent id="API_End_Reject" name="Từ chối đơn (PRICE_MISMATCH)">
      <bpmn:incoming>Seq_API3_Mismatch</bpmn:incoming>
      <bpmn:terminateEventDefinition />
    </bpmn:endEvent>

    <bpmn:sequenceFlow id="Seq_API1" sourceRef="API_Start_ReceiveOrder" targetRef="API_T1_CatalogCheck" />
    <bpmn:sequenceFlow id="Seq_API2" sourceRef="API_T1_CatalogCheck" targetRef="API_G1_PriceMatch" />
    <bpmn:sequenceFlow id="Seq_API3_Matched" name="Khớp" sourceRef="API_G1_PriceMatch" targetRef="API_T2_IndependentSubtotal" />
    <bpmn:sequenceFlow id="Seq_API3_Mismatch" name="Lệch giá" sourceRef="API_G1_PriceMatch" targetRef="API_End_Reject" />
    <bpmn:sequenceFlow id="Seq_API4" sourceRef="API_T2_IndependentSubtotal" targetRef="API_T3_EvaluateVoucherOnServer" />
    <bpmn:sequenceFlow id="Seq_API5" sourceRef="API_T3_EvaluateVoucherOnServer" targetRef="API_T4_FinalizeTotals" />
    <bpmn:sequenceFlow id="Seq_API6" sourceRef="API_T4_FinalizeTotals" targetRef="API_T5_PersistOrder" />
    <bpmn:sequenceFlow id="Seq_API7" sourceRef="API_T5_PersistOrder" targetRef="API_End_Success" />
  </bpmn:process>

  <!-- ======================== BPMN DI DIAGRAM ======================== -->
  <bpmndi:BPMNDiagram id="BPMNDiagram_Velura_1">
    <bpmndi:BPMNPlane id="BPMNPlane_Velura_1" bpmnElement="Collaboration_Velura_Promotion">
      
      <!-- Pool: Admin -->
      <bpmndi:BPMNShape id="Participant_Admin_di" bpmnElement="Participant_Admin" isHorizontal="true">
        <dc:Bounds x="160" y="60" width="1560" height="420" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Lane_AdminOperator_di" bpmnElement="Lane_AdminOperator" isHorizontal="true">
        <dc:Bounds x="190" y="60" width="1530" height="250" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Lane_AdminSystem_di" bpmnElement="Lane_AdminSystem" isHorizontal="true">
        <dc:Bounds x="190" y="310" width="1530" height="170" />
      </bpmndi:BPMNShape>

      <!-- Admin Nodes -->
      <bpmndi:BPMNShape id="Admin_Start_di" bpmnElement="Admin_Start">
        <dc:Bounds x="232" y="162" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Admin_T1_di" bpmnElement="Admin_T1_OpenWorkspace">
        <dc:Bounds x="300" y="145" width="150" height="70" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Admin_G1_di" bpmnElement="Admin_G1_SelectAction" isMarkerVisible="true">
        <dc:Bounds x="485" y="155" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Admin_T2_di" bpmnElement="Admin_T2_CreateCampaign">
        <dc:Bounds x="570" y="75" width="170" height="60" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Admin_T3_di" bpmnElement="Admin_T3_IssueVoucher">
        <dc:Bounds x="570" y="150" width="170" height="60" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Admin_T4_di" bpmnElement="Admin_T4_UpdateVoucher">
        <dc:Bounds x="570" y="225" width="170" height="60" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Admin_G2_di" bpmnElement="Admin_G2_ValidatePayload" isMarkerVisible="true">
        <dc:Bounds x="785" y="365" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Admin_T5_di" bpmnElement="Admin_T5_RPC">
        <dc:Bounds x="870" y="355" width="180" height="70" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Admin_T7_di" bpmnElement="Admin_T7_CeilingBudget">
        <dc:Bounds x="1090" y="355" width="180" height="70" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Admin_T6_di" bpmnElement="Admin_T6_ToggleStatus">
        <dc:Bounds x="1090" y="75" width="180" height="60" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Admin_T8_di" bpmnElement="Admin_T8_ViewAnalytics">
        <dc:Bounds x="1090" y="150" width="180" height="60" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Admin_G3_di" bpmnElement="Admin_G3_MergeActions" isMarkerVisible="true">
        <dc:Bounds x="1335" y="155" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Admin_End_di" bpmnElement="Admin_End">
        <dc:Bounds x="1442" y="162" width="36" height="36" />
      </bpmndi:BPMNShape>

      <!-- Pool: User -->
      <bpmndi:BPMNShape id="Participant_User_di" bpmnElement="Participant_User" isHorizontal="true">
        <dc:Bounds x="160" y="520" width="1560" height="380" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Lane_UserCustomer_di" bpmnElement="Lane_UserCustomer" isHorizontal="true">
        <dc:Bounds x="190" y="520" width="1530" height="190" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Lane_UserStorefrontEngine_di" bpmnElement="Lane_UserStorefrontEngine" isHorizontal="true">
        <dc:Bounds x="190" y="710" width="1530" height="190" />
      </bpmndi:BPMNShape>

      <!-- User Nodes -->
      <bpmndi:BPMNShape id="User_Start_di" bpmnElement="User_Start">
        <dc:Bounds x="232" y="592" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="User_T1_di" bpmnElement="User_T1_BrowseOffers">
        <dc:Bounds x="300" y="575" width="150" height="70" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="User_T2_di" bpmnElement="User_T2_EvaluateWallet">
        <dc:Bounds x="480" y="765" width="170" height="75" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="User_T4_di" bpmnElement="User_T4_QuoteBestVoucher">
        <dc:Bounds x="690" y="765" width="170" height="75" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="User_T3_di" bpmnElement="User_T3_ManageSelection">
        <dc:Bounds x="890" y="575" width="170" height="70" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="User_G1_di" bpmnElement="User_G1_HasEligibleVoucher" isMarkerVisible="true">
        <dc:Bounds x="1095" y="775" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="User_T5_di" bpmnElement="User_T5_RenderDiscount">
        <dc:Bounds x="1180" y="735" width="160" height="55" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="User_T6_di" bpmnElement="User_T6_ComputeShipping">
        <dc:Bounds x="1180" y="805" width="160" height="55" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="User_T7_di" bpmnElement="User_T7_SubmitOrder">
        <dc:Bounds x="1380" y="575" width="170" height="70" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="User_End_di" bpmnElement="User_End_OrderCreated">
        <dc:Bounds x="1602" y="592" width="36" height="36" />
      </bpmndi:BPMNShape>

      <!-- Pool: API Server -->
      <bpmndi:BPMNShape id="Participant_API_di" bpmnElement="Participant_API" isHorizontal="true">
        <dc:Bounds x="160" y="940" width="1560" height="260" />
      </bpmndi:BPMNShape>

      <!-- API Nodes -->
      <bpmndi:BPMNShape id="API_Start_ReceiveOrder_di" bpmnElement="API_Start_ReceiveOrder">
        <dc:Bounds x="232" y="1042" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="API_T1_di" bpmnElement="API_T1_CatalogCheck">
        <dc:Bounds x="300" y="1025" width="160" height="70" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="API_G1_di" bpmnElement="API_G1_PriceMatch" isMarkerVisible="true">
        <dc:Bounds x="495" y="1035" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="API_T2_di" bpmnElement="API_T2_IndependentSubtotal">
        <dc:Bounds x="580" y="1025" width="170" height="70" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="API_T3_di" bpmnElement="API_T3_EvaluateVoucherOnServer">
        <dc:Bounds x="780" y="1025" width="180" height="70" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="API_T4_di" bpmnElement="API_T4_FinalizeTotals">
        <dc:Bounds x="990" y="1025" width="170" height="70" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="API_T5_di" bpmnElement="API_T5_PersistOrder">
        <dc:Bounds x="1190" y="1025" width="190" height="70" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="API_End_Success_di" bpmnElement="API_End_Success">
        <dc:Bounds x="1432" y="1042" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="API_End_Reject_di" bpmnElement="API_End_Reject">
        <dc:Bounds x="502" y="1132" width="36" height="36" />
      </bpmndi:BPMNShape>

      <!-- Message Flows -->
      <bpmndi:BPMNEdge id="MsgFlow_VoucherSync_di" bpmnElement="MsgFlow_VoucherSync">
        <di:waypoint x="960" y="425" />
        <di:waypoint x="960" y="500" />
        <di:waypoint x="375" y="500" />
        <di:waypoint x="375" y="575" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="MsgFlow_SubmitOrder_di" bpmnElement="MsgFlow_SubmitOrder">
        <di:waypoint x="1465" y="645" />
        <di:waypoint x="1465" y="920" />
        <di:waypoint x="250" y="920" />
        <di:waypoint x="250" y="1042" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="MsgFlow_OrderFeedback_di" bpmnElement="MsgFlow_OrderFeedback">
        <di:waypoint x="1285" y="1025" />
        <di:waypoint x="1285" y="920" />
        <di:waypoint x="1620" y="920" />
        <di:waypoint x="1620" y="628" />
      </bpmndi:BPMNEdge>

    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

writeFileSync(join(BA_DIR, 'khuyenmai-3.1.13.bpmn'), bpmn2Xml, 'utf-8');
console.log('1. BPMN 2.0 XML written successfully to docs/ba/khuyenmai-3.1.13.bpmn');

// ═══════════════════════════════════════════════════════════════════════════
// 2. CHUẨN HÓA DRAW.IO XML (BPMN Shapes, Compact Layout, Connected Edges)
// ═══════════════════════════════════════════════════════════════════════════
const drawioXml = `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="app.diagrams.net">
  <diagram name="Quy trình 3.1.13 Khuyến mãi &amp; Voucher" id="promo_3113_master">
    <mxGraphModel dx="1600" dy="1200" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1800" pageHeight="1400" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />

        <!-- ==================== POOL 1: ADMIN ==================== -->
        <mxCell id="p_admin" value="" style="shape=mxgraph.bpmn.pool;horizontal=1;swimlaneHead=0;collapsible=0;" vertex="1" parent="1">
          <mxGeometry x="40" y="40" width="1680" height="420" as="geometry" />
        </mxCell>
        <mxCell id="p_admin_hdr" value="Velura Admin Dashboard" style="text;html=1;fontSize=14;fontStyle=1;align=left;verticalAlign=middle;" vertex="1" parent="p_admin">
          <mxGeometry x="45" y="5" width="300" height="20" as="geometry" />
        </mxCell>
        <mxCell id="l_admin_op" value="Quản trị viên" style="swimlane;horizontal=0;swimlaneFillColor=none;startSize=30;fontSize=12;fontStyle=1;collapsible=0;" vertex="1" parent="p_admin">
          <mxGeometry y="30" width="1680" height="240" as="geometry" />
        </mxCell>
        <mxCell id="l_admin_sys" value="Hệ thống Quản trị" style="swimlane;horizontal=0;swimlaneFillColor=none;startSize=30;fontSize=12;fontStyle=1;collapsible=0;" vertex="1" parent="p_admin">
          <mxGeometry y="270" width="1680" height="150" as="geometry" />
        </mxCell>

        <!-- Admin Op Elements -->
        <mxCell id="a_start" value="" style="shape=mxgraph.bpmn.event;verticalLabelPosition=bottom;verticalAlign=top;perimeter=ellipsePerimeter;outline=standard;symbol=general;" vertex="1" parent="l_admin_op">
          <mxGeometry x="50" y="105" width="30" height="30" as="geometry" />
        </mxCell>
        <mxCell id="a_t1" value="Xem danh sách&#xa;chiến dịch, voucher,&#xa;combo &amp; thống kê" style="shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=8;html=1;taskMarker=user;fontSize=12;" vertex="1" parent="l_admin_op">
          <mxGeometry x="120" y="90" width="140" height="60" as="geometry" />
        </mxCell>
        <mxCell id="a_g1" value="" style="shape=mxgraph.bpmn.gateway2;html=1;perimeter=rhombusPerimeter;outline=none;symbol=exclusiveGw;gwType=exclusive;" vertex="1" parent="l_admin_op">
          <mxGeometry x="300" y="100" width="40" height="40" as="geometry" />
        </mxCell>
        <mxCell id="a_g1_lbl" value="Lựa chọn&#xa;nghiệp vụ?" style="text;html=1;fontSize=11;fontStyle=2;align=center;" vertex="1" parent="l_admin_op">
          <mxGeometry x="280" y="65" width="80" height="30" as="geometry" />
        </mxCell>

        <mxCell id="a_t2" value="Tạo chiến dịch: tên,&#xa;loại, mô tả, khung giờ,&#xa;trần ngân sách" style="shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=8;html=1;taskMarker=user;fontSize=11;" vertex="1" parent="l_admin_op">
          <mxGeometry x="380" y="20" width="150" height="55" as="geometry" />
        </mxCell>
        <mxCell id="a_t3" value="Phát hành mã: code, loại,&#xa;đơn tối thiểu, trần giảm,&#xa;nhóm khách, hạn dùng" style="shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=8;html=1;taskMarker=user;fontSize=11;" vertex="1" parent="l_admin_op">
          <mxGeometry x="380" y="92" width="150" height="55" as="geometry" />
        </mxCell>
        <mxCell id="a_t4" value="Cập nhật mã: sửa giá trị,&#xa;trần, đơn tối thiểu, nhóm,&#xa;lượt dùng, chiến dịch" style="shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=8;html=1;taskMarker=user;fontSize=11;" vertex="1" parent="l_admin_op">
          <mxGeometry x="380" y="165" width="150" height="55" as="geometry" />
        </mxCell>

        <mxCell id="a_t6" value="Bật / Tạm dừng mã&#xa;hoặc chiến dịch&#xa;(kèm expectedVersion)" style="shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=8;html=1;taskMarker=user;fontSize=11;" vertex="1" parent="l_admin_op">
          <mxGeometry x="980" y="25" width="160" height="55" as="geometry" />
        </mxCell>
        <mxCell id="a_t8" value="Xem báo cáo thống kê:&#xa;tỷ lệ dùng mã, doanh thu&#xa;đơn có mã, đối soát thực tế" style="shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=8;html=1;taskMarker=user;fontSize=11;" vertex="1" parent="l_admin_op">
          <mxGeometry x="980" y="150" width="160" height="55" as="geometry" />
        </mxCell>

        <mxCell id="a_g3" value="" style="shape=mxgraph.bpmn.gateway2;html=1;perimeter=rhombusPerimeter;outline=none;symbol=exclusiveGw;gwType=exclusive;" vertex="1" parent="l_admin_op">
          <mxGeometry x="1200" y="100" width="40" height="40" as="geometry" />
        </mxCell>
        <mxCell id="a_end" value="Hoàn tất" style="shape=mxgraph.bpmn.event;verticalLabelPosition=bottom;verticalAlign=top;perimeter=ellipsePerimeter;outline=end;symbol=general;fontSize=11;" vertex="1" parent="l_admin_op">
          <mxGeometry x="1290" y="105" width="30" height="30" as="geometry" />
        </mxCell>

        <!-- Admin Sys Elements -->
        <mxCell id="a_g2" value="" style="shape=mxgraph.bpmn.gateway2;html=1;perimeter=rhombusPerimeter;outline=none;symbol=exclusiveGw;gwType=exclusive;" vertex="1" parent="l_admin_sys">
          <mxGeometry x="580" y="45" width="40" height="40" as="geometry" />
        </mxCell>
        <mxCell id="a_g2_lbl" value="Dữ liệu&#xa;hợp lệ?" style="text;html=1;fontSize=11;fontStyle=2;align=center;" vertex="1" parent="l_admin_sys">
          <mxGeometry x="565" y="15" width="70" height="30" as="geometry" />
        </mxCell>
        <mxCell id="a_t5" value="Thực thi RPC bảo mật&#xa;(security definer), kiểm vai trò&#xa;&amp; ghi audit_log kèm actor_id" style="shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=8;html=1;taskMarker=service;fontSize=11;" vertex="1" parent="l_admin_sys">
          <mxGeometry x="670" y="35" width="170" height="60" as="geometry" />
        </mxCell>
        <mxCell id="a_ds_audit" value="audit_log" style="shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=8;fontSize=11;" vertex="1" parent="l_admin_sys">
          <mxGeometry x="720" y="102" width="70" height="35" as="geometry" />
        </mxCell>
        <mxCell id="a_t7" value="Tính trần mã phát hành =&#xa;Ngân sách / Trần giảm tối đa;&#xa;Kích hoạt tự động dừng khi cạn" style="shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=8;html=1;taskMarker=service;fontSize=11;" vertex="1" parent="l_admin_sys">
          <mxGeometry x="880" y="35" width="180" height="60" as="geometry" />
        </mxCell>

        <!-- ==================== POOL 2: STOREFRONT ==================== -->
        <mxCell id="p_user" value="" style="shape=mxgraph.bpmn.pool;horizontal=1;swimlaneHead=0;collapsible=0;" vertex="1" parent="1">
          <mxGeometry x="40" y="500" width="1680" height="380" as="geometry" />
        </mxCell>
        <mxCell id="p_user_hdr" value="Velura Storefront (Khách hàng)" style="text;html=1;fontSize=14;fontStyle=1;align=left;verticalAlign=middle;" vertex="1" parent="p_user">
          <mxGeometry x="45" y="5" width="300" height="20" as="geometry" />
        </mxCell>
        <mxCell id="l_user_cust" value="Khách hàng" style="swimlane;horizontal=0;swimlaneFillColor=none;startSize=30;fontSize=12;fontStyle=1;collapsible=0;" vertex="1" parent="p_user">
          <mxGeometry y="30" width="1680" height="190" as="geometry" />
        </mxCell>
        <mxCell id="l_user_sys" value="Hệ thống Storefront" style="swimlane;horizontal=0;swimlaneFillColor=none;startSize=30;fontSize=12;fontStyle=1;collapsible=0;" vertex="1" parent="p_user">
          <mxGeometry y="220" width="1680" height="160" as="geometry" />
        </mxCell>

        <!-- User Cust Elements -->
        <mxCell id="u_start" value="" style="shape=mxgraph.bpmn.event;verticalLabelPosition=bottom;verticalAlign=top;perimeter=ellipsePerimeter;outline=standard;symbol=general;" vertex="1" parent="l_user_cust">
          <mxGeometry x="50" y="80" width="30" height="30" as="geometry" />
        </mxCell>
        <mxCell id="u_t1" value="Xem ví voucher:&#xa;Dành riêng cho bạn,&#xa;Đang diễn ra, Sắp hết hạn" style="shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=8;html=1;taskMarker=user;fontSize=11;" vertex="1" parent="l_user_cust">
          <mxGeometry x="120" y="65" width="150" height="60" as="geometry" />
        </mxCell>
        <mxCell id="u_t3" value="Xem mức giảm, chủ động&#xa;đổi mã khác hoặc bấm&#xa;bỏ mã (decline_voucher)" style="shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=8;html=1;taskMarker=user;fontSize=11;" vertex="1" parent="l_user_cust">
          <mxGeometry x="640" y="65" width="160" height="60" as="geometry" />
        </mxCell>
        <mxCell id="u_t7" value="Xác nhận đặt hàng&#xa;(Guest: OTP email xác thực;&#xa;Member: chọn địa chỉ có sẵn)" style="shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=8;html=1;taskMarker=user;fontSize=11;" vertex="1" parent="l_user_cust">
          <mxGeometry x="1170" y="65" width="170" height="60" as="geometry" />
        </mxCell>
        <mxCell id="u_end" value="Đơn pending" style="shape=mxgraph.bpmn.event;verticalLabelPosition=bottom;verticalAlign=top;perimeter=ellipsePerimeter;outline=end;symbol=general;fontSize=11;" vertex="1" parent="l_user_cust">
          <mxGeometry x="1400" y="80" width="30" height="30" as="geometry" />
        </mxCell>

        <!-- User Sys Elements -->
        <mxCell id="u_t2" value="Chấm 8 bước điều kiện ví:&#xa;Lọc theo nhóm (guest/member),&#xa;hiển thị lý do &amp; tiền thiếu" style="shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=8;html=1;taskMarker=service;fontSize=11;" vertex="1" parent="l_user_sys">
          <mxGeometry x="270" y="45" width="160" height="65" as="geometry" />
        </mxCell>
        <mxCell id="u_t4" value="quoteBestVoucher:&#xa;Tự động chọn 01 mã giảm tối đa,&#xa;ưu tiên hạn gần, cấm cộng dồn" style="shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=8;html=1;taskMarker=service;fontSize=11;" vertex="1" parent="l_user_sys">
          <mxGeometry x="470" y="45" width="160" height="65" as="geometry" />
        </mxCell>
        <mxCell id="u_g1" value="" style="shape=mxgraph.bpmn.gateway2;html=1;perimeter=rhombusPerimeter;outline=none;symbol=exclusiveGw;gwType=exclusive;" vertex="1" parent="l_user_sys">
          <mxGeometry x="840" y="55" width="40" height="40" as="geometry" />
        </mxCell>
        <mxCell id="u_g1_lbl" value="Khách dùng&#xa;mã?" style="text;html=1;fontSize=11;fontStyle=2;align=center;" vertex="1" parent="l_user_sys">
          <mxGeometry x="820" y="25" width="80" height="30" as="geometry" />
        </mxCell>
        <mxCell id="u_t5" value="Cập nhật mức giảm giá&#xa;tạm tính của voucher" style="shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=8;html=1;taskMarker=service;fontSize=11;" vertex="1" parent="l_user_sys">
          <mxGeometry x="930" y="20" width="150" height="50" as="geometry" />
        </mxCell>
        <mxCell id="u_t6" value="Tính phí ship theo ngưỡng&#xa;từ server (>= 500k miễn phí;&#xa;thường 30k, nhanh 50k)" style="shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=8;html=1;taskMarker=service;fontSize=11;" vertex="1" parent="l_user_sys">
          <mxGeometry x="930" y="85" width="150" height="55" as="geometry" />
        </mxCell>

        <!-- ==================== POOL 3: API SERVER ==================== -->
        <mxCell id="p_api" value="" style="shape=mxgraph.bpmn.pool;horizontal=1;swimlaneHead=0;collapsible=0;" vertex="1" parent="1">
          <mxGeometry x="40" y="920" width="1680" height="240" as="geometry" />
        </mxCell>
        <mxCell id="p_api_hdr" value="Velura API Server (Định giá &amp; Giao dịch)" style="text;html=1;fontSize=14;fontStyle=1;align=left;verticalAlign=middle;" vertex="1" parent="p_api">
          <mxGeometry x="45" y="5" width="350" height="20" as="geometry" />
        </mxCell>
        <mxCell id="l_api" value="Định giá &amp; Ngân sách" style="swimlane;horizontal=0;swimlaneFillColor=none;startSize=30;fontSize=12;fontStyle=1;collapsible=0;" vertex="1" parent="p_api">
          <mxGeometry y="30" width="1680" height="210" as="geometry" />
        </mxCell>

        <!-- API Elements -->
        <mxCell id="api_start" value="" style="shape=mxgraph.bpmn.event;verticalLabelPosition=bottom;verticalAlign=top;perimeter=ellipsePerimeter;outline=standard;symbol=general;" vertex="1" parent="l_api">
          <mxGeometry x="50" y="80" width="30" height="30" as="geometry" />
        </mxCell>
        <mxCell id="api_t1" value="Tra cứu catalog theo&#xa;variant_id &amp; đối chiếu&#xa;unit_price client gửi" style="shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=8;html=1;taskMarker=service;fontSize=11;" vertex="1" parent="l_api">
          <mxGeometry x="120" y="65" width="150" height="60" as="geometry" />
        </mxCell>
        <mxCell id="api_g1" value="" style="shape=mxgraph.bpmn.gateway2;html=1;perimeter=rhombusPerimeter;outline=none;symbol=exclusiveGw;gwType=exclusive;" vertex="1" parent="l_api">
          <mxGeometry x="310" y="75" width="40" height="40" as="geometry" />
        </mxCell>
        <mxCell id="api_g1_lbl" value="Giá catalog&#xa;khớp?" style="text;html=1;fontSize=11;fontStyle=2;align=center;" vertex="1" parent="l_api">
          <mxGeometry x="295" y="45" width="70" height="30" as="geometry" />
        </mxCell>
        <mxCell id="api_err" value="PRICE_MISMATCH" style="shape=mxgraph.bpmn.event;verticalLabelPosition=bottom;verticalAlign=top;perimeter=ellipsePerimeter;outline=end;symbol=terminate;fontSize=10;" vertex="1" parent="l_api">
          <mxGeometry x="315" y="150" width="30" height="30" as="geometry" />
        </mxCell>
        <mxCell id="api_t2" value="Server tự tính subtotal =&#xa;tổng(catalog_price x qty);&#xa;Bỏ qua subtotal client" style="shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=8;html=1;taskMarker=service;fontSize=11;" vertex="1" parent="l_api">
          <mxGeometry x="410" y="65" width="160" height="60" as="geometry" />
        </mxCell>
        <mxCell id="api_t3" value="Thẩm định lại mã tại server&#xa;(evaluateVoucher) &amp; tính&#xa;discount_amount chuẩn" style="shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=8;html=1;taskMarker=service;fontSize=11;" vertex="1" parent="l_api">
          <mxGeometry x="610" y="65" width="170" height="60" as="geometry" />
        </mxCell>
        <mxCell id="api_t4" value="Tính phí ship theo cấu hình;&#xa;total = subtotal + ship - discount&#xa;(Không tin total client gửi)" style="shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=8;html=1;taskMarker=service;fontSize=11;" vertex="1" parent="l_api">
          <mxGeometry x="820" y="65" width="170" height="60" as="geometry" />
        </mxCell>
        <mxCell id="api_t5" value="Ghi đơn pending, tăng used_count&#xa;&amp; trừ ngân sách kịch trần qua RPC&#xa;(velura_record_voucher_redemption)" style="shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=8;html=1;taskMarker=service;fontSize=11;" vertex="1" parent="l_api">
          <mxGeometry x="1030" y="65" width="190" height="60" as="geometry" />
        </mxCell>
        <mxCell id="api_end" value="Đơn pending" style="shape=mxgraph.bpmn.event;verticalLabelPosition=bottom;verticalAlign=top;perimeter=ellipsePerimeter;outline=end;symbol=general;fontSize=11;" vertex="1" parent="l_api">
          <mxGeometry x="1270" y="80" width="30" height="30" as="geometry" />
        </mxCell>

        <!-- ==================== FLOWS: ADMIN ==================== -->
        <mxCell id="f_a1" edge="1" source="a_start" target="a_t1" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />
        <mxCell id="f_a2" edge="1" source="a_t1" target="a_g1" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />
        <mxCell id="f_a3_t2" edge="1" source="a_g1" target="a_t2" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />
        <mxCell id="f_a3_t3" edge="1" source="a_g1" target="a_t3" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />
        <mxCell id="f_a3_t4" edge="1" source="a_g1" target="a_t4" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />
        <mxCell id="f_a3_t6" edge="1" source="a_g1" target="a_t6" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;">
          <mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="360" y="55" /><mxPoint x="960" y="55" /></Array></mxGeometry>
        </mxCell>
        <mxCell id="f_a3_t8" edge="1" source="a_g1" target="a_t8" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;">
          <mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="360" y="240" /><mxPoint x="960" y="240" /></Array></mxGeometry>
        </mxCell>

        <mxCell id="f_a4_t2" edge="1" source="a_t2" target="a_g2" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />
        <mxCell id="f_a4_t3" edge="1" source="a_t3" target="a_g2" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />
        <mxCell id="f_a4_t4" edge="1" source="a_t4" target="a_g2" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />

        <mxCell id="f_a5_val" value="Hợp lệ" edge="1" source="a_g2" target="a_t5" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;fontSize=10;">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>

        <mxCell id="f_a5_inval" value="Lỗi (Báo lỗi)" edge="1" source="a_g2" target="a_g3" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;fontSize=10;">
          <mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="600" y="440" /><mxPoint x="1220" y="440" /></Array></mxGeometry>
        </mxCell>

        <mxCell id="f_t5_audit" edge="1" source="a_t5" target="a_ds_audit" parent="1" style="edgeStyle=orthogonalEdgeStyle;dashed=1;endArrow=classic;endFill=1;" />
        <mxCell id="f_t5_t7" edge="1" source="a_t5" target="a_t7" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />
        <mxCell id="f_t7_g3" edge="1" source="a_t7" target="a_g3" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />
        <mxCell id="f_t6_g3" edge="1" source="a_t6" target="a_g3" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />
        <mxCell id="f_t8_g3" edge="1" source="a_t8" target="a_g3" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />
        <mxCell id="f_g3_end" edge="1" source="a_g3" target="a_end" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />

        <!-- ==================== FLOWS: USER ==================== -->
        <mxCell id="f_u1" edge="1" source="u_start" target="u_t1" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />
        <mxCell id="f_u2" edge="1" source="u_t1" target="u_t2" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />
        <mxCell id="f_u3" edge="1" source="u_t2" target="u_t4" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />
        <mxCell id="f_u4" edge="1" source="u_t4" target="u_t3" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />
        <mxCell id="f_u5" edge="1" source="u_t3" target="u_g1" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />

        <mxCell id="f_u6_yes" value="Dùng mã" edge="1" source="u_g1" target="u_t5" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;fontSize=10;">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
        <mxCell id="f_u6_no" value="Bỏ mã" edge="1" source="u_g1" target="u_t6" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;fontSize=10;">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>

        <mxCell id="f_u_t5_t6" edge="1" source="u_t5" target="u_t6" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />
        <mxCell id="f_u_t6_t7" edge="1" source="u_t6" target="u_t7" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />
        <mxCell id="f_u_t7_end" edge="1" source="u_t7" target="u_end" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />

        <!-- ==================== FLOWS: API ==================== -->
        <mxCell id="f_api1" edge="1" source="api_start" target="api_t1" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />
        <mxCell id="f_api2" edge="1" source="api_t1" target="api_g1" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />

        <mxCell id="f_api3_match" value="Khớp" edge="1" source="api_g1" target="api_t2" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;fontSize=10;">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
        <mxCell id="f_api3_mismatch" value="Lệch giá" edge="1" source="api_g1" target="api_err" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;fontSize=10;">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>

        <mxCell id="f_api4" edge="1" source="api_t2" target="api_t3" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />
        <mxCell id="f_api5" edge="1" source="api_t3" target="api_t4" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />
        <mxCell id="f_api6" edge="1" source="api_t4" target="api_t5" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />
        <mxCell id="f_api7" edge="1" source="api_t5" target="api_end" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;endFill=1;" />

        <!-- ==================== MESSAGE FLOWS (INTER-POOL) ==================== -->
        <mxCell id="mf_voucher_sync" value="Mã hiển thị trong ví voucher khách" style="edgeStyle=orthogonalEdgeStyle;dashed=1;endArrow=open;endFill=0;fontSize=11;strokeColor=#4B5563;" edge="1" parent="1" source="a_t7" target="u_t1">
          <mxGeometry relative="1" as="geometry">
            <Array as="points">
              <mxPoint x="1010" y="480" />
              <mxPoint x="235" y="480" />
            </Array>
          </mxGeometry>
        </mxCell>

        <mxCell id="mf_order_submit" value="Gửi payload đặt đơn kèm voucher_id" style="edgeStyle=orthogonalEdgeStyle;dashed=1;endArrow=open;endFill=0;fontSize=11;strokeColor=#4B5563;" edge="1" parent="1" source="u_t7" target="api_start">
          <mxGeometry relative="1" as="geometry">
            <Array as="points">
              <mxPoint x="1295" y="900" />
              <mxPoint x="105" y="900" />
            </Array>
          </mxGeometry>
        </mxCell>

        <mxCell id="mf_order_feedback" value="Phản hồi kết quả đơn &amp; tiền thực thu" style="edgeStyle=orthogonalEdgeStyle;dashed=1;endArrow=open;endFill=0;fontSize=11;strokeColor=#4B5563;" edge="1" parent="1" source="api_t5" target="u_end">
          <mxGeometry relative="1" as="geometry">
            <Array as="points">
              <mxPoint x="1165" y="905" />
              <mxPoint x="1455" y="905" />
            </Array>
          </mxGeometry>
        </mxCell>

      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

writeFileSync(join(BA_DIR, 'khuyenmai-3.1.13.drawio.xml'), drawioXml, 'utf-8');
writeFileSync(join(BA_DIR, 'khuyenmai.drawio.xml'), drawioXml, 'utf-8');
console.log('2. draw.io XML written to docs/ba/khuyenmai-3.1.13.drawio.xml & docs/ba/khuyenmai.drawio.xml');

// ═══════════════════════════════════════════════════════════════════════════
// 3. XUẤT ẢNH PNG TỪ DRAW.IO CLI
// ═══════════════════════════════════════════════════════════════════════════
const pngPath = join(BA_DIR, 'khuyenmai-3.1.13.png');
try {
  console.log('Exporting PNG using drawio CLI...');
  execSync(`drawio "${join(BA_DIR, 'khuyenmai-3.1.13.drawio.xml')}" -o "${pngPath}"`, { stdio: 'inherit' });
  console.log('3. PNG exported successfully to docs/ba/khuyenmai-3.1.13.png');
} catch (e) {
  console.warn('Could not export PNG automatically via drawio CLI:', e.message);
}

let pngBuffer = null;
try {
  pngBuffer = readFileSync(pngPath);
  console.log(`Loaded PNG image buffer (${pngBuffer.length} bytes) for docx embedding.`);
} catch (e) {
  console.warn('PNG file not found on disk, skipping image embed in docx.');
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. BIÊN SOẠN TÀI LIỆU DOCX 3.1.13 CHUẨN SENIOR BA TOÀN DIỆN
// ═══════════════════════════════════════════════════════════════════════════
const b = (text) => new TextRun({ text, bold: true });
const t = (text) => new TextRun({ text });
const it = (text) => new TextRun({ text, italics: true });
const p = (text, opts = {}) => new Paragraph({ children: [t(text)], spacing: { after: 120, line: 276 }, ...opts });
const pb = (text, opts = {}) => new Paragraph({ children: [b(text)], spacing: { after: 120, line: 276 }, ...opts });

const tc = (text, widthPercent) => new TableCell({
  children: [new Paragraph({ children: [t(text)], spacing: { before: 60, after: 60, line: 240 } })],
  width: widthPercent ? { size: `${widthPercent}%`, type: WidthType.PERCENTAGE } : undefined,
});

const tcb = (text, widthPercent) => new TableCell({
  children: [new Paragraph({ children: [b(text)], spacing: { before: 80, after: 80, line: 240 } })],
  width: widthPercent ? { size: `${widthPercent}%`, type: WidthType.PERCENTAGE } : undefined,
  shading: { fill: 'F3F4F6', type: ShadingType.CLEAR },
});

// Full 18 Business Rules covering Price, Promo, Voucher, Combo, Server Calculation, Audit and Stats
const businessRules = [
  ['AD_PRICE_01', 'Kiểm soát giá bán không thấp hơn giá vốn', 'Giá bán niêm yết sau khi cập nhật không được thấp hơn giá vốn nhập hàng, trừ trường hợp chương trình xả hàng tồn kho hoặc khuyến mãi đặc biệt đã được cấp có thẩm quyền phê duyệt.', 'Kiểm tra giá bán và giá vốn; nếu giá bán nhỏ hơn giá vốn mà không có cờ phê duyệt hợp lệ thì từ chối lưu và hiển thị cảnh báo chặn.'],
  ['AD_PRICE_02', 'Ghi nhận lịch sử điều chỉnh giá', 'Mọi thay đổi về giá gốc, giá niêm yết của sản phẩm hoặc từng biến thể (variant) phải được ghi nhận đầy đủ vào bảng lịch sử giá.', 'Tự động tạo bản ghi price_history gồm: người thực hiện, thời gian, giá trị cũ, giá trị mới và lý do điều chỉnh.'],
  ['AD_PROMO_01', 'Chiến dịch là nhóm voucher và quản trị ngân sách', 'Chiến dịch khuyến mãi đóng vai trò vỏ chứa nhóm các mã giảm giá, kiểm soát ngân sách tổng và thông tin hiển thị trên trang Ưu đãi, không tự động đổi giá trực tiếp trên sản phẩm.', 'Gắn promo_id vào mã voucher; theo dõi tổng ngân sách phát hành dựa trên trần ngân sách chiến dịch.'],
  ['AD_PROMO_02', 'Nguyên tắc đơn mã không cộng dồn', 'Mỗi đơn hàng chỉ được áp dụng đúng một mã voucher giảm giá duy nhất. Hệ thống không cho phép cộng dồn nhiều mã trên cùng một đơn hàng.', 'Khi khách chọn mã mới, hệ thống tự động gỡ bỏ mã cũ và áp dụng mã mới vào đơn.'],
  ['AD_PROMO_03', 'Kiểm soát ngân sách theo mức trần kịch khung', 'Hệ thống tự động tính số lượng mã tối đa được phép phát hành = Ngân sách tổng chia cho Trần giảm tối đa mỗi mã. Ngân sách được theo dõi nghiêm ngặt theo mức giảm kịch trần cấu hình.', 'Khi tổng mã phát hành đạt trần hoặc hết ngân sách quy đổi, hệ thống tự động vô hiệu hóa chiến dịch và gửi cảnh báo.'],
  ['AD_PROMO_04', 'Lưu trữ và toàn vẹn dữ liệu chiến dịch', 'Các chương trình khuyến mãi và mã voucher đã kết thúc được lưu trữ tối thiểu 12 tháng phục vụ đối soát và báo cáo thống kê.', 'Đánh dấu trạng thái kết thúc, cấm xóa cứng dữ liệu khỏi cơ sở dữ liệu.'],
  ['AD_VOUCHER_01', 'Tính duy nhất của mã voucher', 'Mỗi mã giảm giá phải có mã code duy nhất toàn hệ thống, viết hoa không dấu, không trùng lặp kể cả với mã đã tắt.', 'Kiểm tra trùng code trước khi tạo; từ chối lưu và báo lỗi nếu mã đã tồn tại.'],
  ['AD_VOUCHER_02', 'Kiểm tra tính hợp lệ qua quy trình 8 bước', 'Hệ thống thẩm định mã qua 8 bước: kích hoạt, nhóm khách, chiến dịch cha, khung thời gian, lượt dùng toàn sàn, lượt dùng cá nhân, đơn tối thiểu, trần ngân sách.', 'Từ chối mã không hợp lệ, trả về mã lỗi và lý do giải thích cụ thể bằng tiếng Việt.'],
  ['AD_VOUCHER_03', 'Phân định nhóm đối tượng khách hàng', 'Mã phân loại theo nhóm: guest (chỉ khách vãng lai), all_users (mọi khách hàng), member (chỉ thành viên đăng nhập). Khách vãng lai không nhìn thấy mã dành riêng cho thành viên.', 'Hàm buyerCanUseGroup phân luồng hiển thị tại ví voucher và kiểm tra chặt chẽ khi đặt đơn.'],
  ['AD_VOUCHER_04', 'Giới hạn số lần sử dụng', 'Mã voucher được thiết lập giới hạn số lần sử dụng toàn hệ thống và giới hạn sử dụng tối đa trên mỗi tài khoản khách hàng.', 'Lưu buyer_id khi áp dụng mã; từ chối khi tài khoản đã vượt quá lượt sử dụng cho phép.'],
  ['AD_VOUCHER_05', 'Quyền quyết định bỏ mã của khách hàng', 'Khi khách hàng chủ động bấm xóa mã tại giỏ hàng hoặc trang thanh toán, hệ thống ghi nhận cờ decline_voucher = true và không tự ý áp lại mã khác.', 'Trả về mức giảm bằng 0 cho tới khi khách hàng chủ động chọn mã mới.'],
  ['AD_COMBO_01', 'Giá combo thấp hơn tổng giá lẻ sản phẩm thành phần', 'Giá bán thiết lập cho combo/bundle sản phẩm phải thấp hơn tổng giá bán lẻ hiện hành của các sản phẩm đơn lẻ thành phần ít nhất 5%.', 'Tự động tính tổng giá catalog lẻ của các thành phần; cảnh báo chặn nếu giá combo không đạt mức ưu đãi tối thiểu quy định.'],
  ['AD_COMBO_02', 'Phân rã dòng đơn và kiểm soát tồn kho theo biến thể', 'Khi combo được thêm vào giỏ hàng và đặt đơn, hệ thống tự động phân rã combo thành các dòng đơn hàng độc lập mang đúng variant_id của từng sản phẩm thành phần với unit_price catalog tương ứng.', 'Trừ tồn kho chính xác theo từng variant_id thành phần trong kho dữ liệu, bảo đảm giá trị catalog không bị sai lệch.'],
  ['SYS_PRICE_01', 'Máy chủ tự tính toán tiền độc lập', 'Toàn bộ luồng tiền (subtotal, shipping_fee, discount_amount, total_amount) do máy chủ tính toán độc lập từ giá catalog và quy tắc hệ thống, bỏ qua toàn bộ số tiền do client gửi lên.', 'Tra cứu giá catalog theo variant_id; nếu unit_price client gửi sai lệch thì từ chối đơn với lỗi PRICE_MISMATCH.'],
  ['SYS_PRICE_02', 'Chính sách ngưỡng miễn phí vận chuyển tự động', 'Phí vận chuyển chuẩn là 30.000đ (thường) và 50.000đ (nhanh). Đơn hàng có giá trị hàng hóa từ 500.000đ trở lên được tự động miễn phí vận chuyển. Đây là ngưỡng tự động của hệ thống, không phải mã voucher.', 'Máy chủ trả về ngưỡng cấu hình cho Storefront hiển thị thanh tiến độ mua thêm và tự động tính phí 0đ khi đủ điều kiện.'],
  ['SYS_AUDIT_01', 'Ghi nhật ký kiểm toán cho toàn bộ thao tác ghi', 'Mọi thao tác tạo chiến dịch, tạo mã, cập nhật voucher phải đi qua RPC có kiểm tra vai trò người dùng (RBAC) và ghi bản ghi vào audit_log kèm actor_id và thông tin thay đổi.', 'Cấm tuyệt đối việc sử dụng service-role key để ghi trực tiếp vào bảng mà không qua kiểm soát RPC.'],
  ['AD_STATS_01', 'Thống kê minh bạch từ dữ liệu đơn hàng thực tế', 'Dữ liệu thống kê khuyến mãi được tổng hợp trực tiếp từ bảng orders và voucher, phản ánh đúng tỷ lệ dùng, doanh thu đơn có mã và chi phí giảm giá thực tế.', 'Truy vấn tổng hợp theo thời gian thực; phân định rõ doanh thu đơn có mã và đơn nguyên giá.'],
  ['AD_STATS_02', 'Bảo mật dữ liệu thống kê theo vai trò quản trị', 'Chỉ tài khoản quản trị cấp cao (super_admin) và cấp quản lý kinh doanh có thẩm quyền tra cứu báo cáo doanh thu, chi phí ngân sách và hiệu quả chiến dịch.', 'Áp dụng phân quyền RBAC; kiểm tra vai trò tại API Gateway trước khi trả dữ liệu báo cáo thống kê.']
];

// Full 10 Exception Cases
const exceptionCases = [
  ['1', 'Giá dòng hàng client gửi sai lệch so với giá catalog sản phẩm',
   'Client gửi đơn hàng với unit_price khác với giá niêm yết hiện hành trong cơ sở dữ liệu do cache trình duyệt cũ hoặc bị can thiệp trái phép.',
   'Máy chủ từ chối tiếp nhận đơn hàng, trả về mã lỗi PRICE_MISMATCH kèm thông tin so sánh giữa giá client gửi và giá catalog thực tế. Storefront hiển thị thông báo yêu cầu làm mới giỏ hàng.'],
  ['2', 'Hai khách hàng cùng áp dụng lượt sử dụng cuối cùng của mã giảm giá',
   'Mã voucher chỉ còn đúng 1 lượt sử dụng toàn hệ thống. Hai khách hàng cùng lúc bấm Xác nhận đặt hàng.',
   'Hệ thống áp dụng cơ chế khóa giao dịch hoặc khóa lạc quan (optimistic locking) tại hàm velura_record_voucher_redemption. Giao dịch đầu tiên hoàn tất hợp lệ; giao dịch thứ hai bị từ chối áp mã với thông báo "Mã giảm giá đã hết lượt sử dụng". Đơn hàng thứ hai vẫn có thể được tạo ở nguyên giá nếu khách hàng đồng ý.'],
  ['3', 'Chiến dịch đạt trần ngân sách trước thời hạn kết thúc dự kiến',
   'Chiến dịch thiết lập ngân sách 50.000.000đ với trần giảm 10.000đ/mã (tương đương 5.000 mã). Do lượng khách lớn, sau 3 ngày toàn bộ số mã đã phát hành hết.',
   'Hệ thống tự động kích hoạt cơ chế ngắt khẩn cấp (Real-time Auto-stop), chuyển trạng thái chiến dịch sang "Đã đạt giới hạn ngân sách". Toàn bộ mã thuộc chiến dịch bị ẩn khỏi ví voucher và không thể áp dụng tại checkout. Đồng thời gửi cảnh báo lên dashboard quản trị.'],
  ['4', 'Khách hàng hoặc quản trị viên hủy đơn hàng trước thời điểm giao hàng',
   'Khách hàng hoặc quản trị viên hủy đơn hàng đang ở trạng thái pending, confirmed hoặc preparing mà đơn hàng đó có áp dụng mã voucher.',
   'Trong cùng giao dịch hủy đơn, hệ thống tự động hoàn trả 1 lượt sử dụng cho mã voucher (giảm used_count) và hoàn lại số tiền ngân sách đã trừ (giảm total_discount_issued) của chiến dịch mẹ.'],
  ['5', 'Quản trị viên cập nhật thông tin mã voucher trong lúc khách hàng đang thanh toán',
   'Quản trị viên tắt mã hoặc sửa điều kiện đơn tối thiểu của mã đúng lúc khách hàng đang ở bước thanh toán.',
   'Khi khách hàng gửi lệnh đặt đơn, máy chủ chạy lại hàm thẩm định evaluateVoucher độc lập tại thời điểm tạo đơn. Nếu mã đã bị tắt hoặc đơn không còn thỏa mãn, hệ thống từ chối áp mã kèm lý do cập nhật mới nhất.'],
  ['6', 'Xung đột phiên bản khi nhiều quản trị viên cùng thao tác trên một chiến dịch',
   'Hai quản trị viên cùng mở màn hình chi tiết và đồng thời nhấn cập nhật trạng thái hoặc thông số chiến dịch.',
   'Hệ thống áp dụng cơ chế kiểm soát phiên bản lạc quan (Optimistic Locking via expectedVersion). Yêu cầu gửi sau bị từ chối với lỗi VERSION_CONFLICT, thông báo cho quản trị viên tải lại trang để nhận dữ liệu mới nhất.'],
  ['7', 'Giá bán được cập nhật thấp hơn giá vốn khi không có cờ phê duyệt',
   'Quản trị viên vô tình nhập giá bán mới thấp hơn giá vốn nhập kho của sản phẩm mà không khai báo chương trình xả hàng.',
   'Hệ thống hiển thị cảnh báo: "Giá bán không được thấp hơn giá vốn trừ khi thuộc chương trình khuyến mãi được phê duyệt". Không cho phép lưu thay đổi và yêu cầu người dùng xác nhận điều chỉnh.'],
  ['8', 'Mã giảm giá được tạo mới bị trùng lặp mã code trong hệ thống',
   'Quản trị viên nhập mã code trùng với mã đã tồn tại trong lịch sử cơ sở dữ liệu (kể cả mã đã hết hạn hoặc tạm dừng).',
   'Hệ thống kích hoạt ràng buộc duy nhất (Unique Constraint), chặn lưu và thông báo lỗi: "Mã code đã tồn tại trên hệ thống, vui lòng nhập mã code khác".'],
  ['9', 'Sản phẩm thành phần trong Combo bị hết tồn kho hoặc ngừng kinh doanh',
   'Set Combo Outfit đang hoạt động gồm Áo, Quần, Giày. Biến thể Quần bị khách mua lẻ dẫn tới tồn kho bằng 0 hoặc bị chuyển sang trạng thái Ngừng kinh doanh.',
   'Hệ thống tự động phát hiện qua kiểm tra tồn kho thời gian thực, chuyển trạng thái Combo thành "Tạm hết hàng", ẩn nút Thêm vào giỏ hàng tại trang chi tiết và gửi cảnh báo thiếu hụt thành phần lên trang quản trị.'],
  ['10', 'Sai lệch số liệu thống kê khuyến mãi do lỗi đồng bộ giao dịch',
   'Do sự cố ngắt kết nối mạng tạm thời, một số đơn hàng có áp mã chưa kịp cập nhật số liệu tổng hợp trong bảng thống kê.',
   'Hệ thống tích hợp quy trình đối soát tự động định kỳ quét lại các đơn hàng thành công trong ngày và đối chiếu với bảng voucher. Quản trị viên cấp cao có nút "Làm mới thống kê" để kích hoạt tính toán lại dữ liệu tức thì.']
];

const docSections = [];

// Header Title
docSections.push(
  new Paragraph({
    text: 'VELURA E-COMMERCE SYSTEM',
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    spacing: { after: 120 }
  }),
  new Paragraph({
    text: 'TÀI LIỆU ĐẶC TẢ QUY TRÌNH NGHIỆP VỤ (BUSINESS PROCESS SPECIFICATION)',
    heading: HeadingLevel.HEADING_2,
    alignment: AlignmentType.CENTER,
    spacing: { after: 240 }
  }),
  new Paragraph({
    children: [
      b('Phân hệ: '), t('Khuyến mãi, Mã giảm giá, Quản lý Giá và Thống kê (Promotion & Pricing Subsystem)\n'),
      b('Mã quy trình: '), t('3.1.13 (Kế thừa và chuẩn hóa toàn diện từ mã cũ 3.1.12 / Jira KAN-53, KAN-54, KAN-55, KAN-56, KAN-69)\n'),
      b('Phiên bản: '), t('2.0 - Đồng bộ toàn diện giữa Khách hàng (Storefront) và Quản trị (Admin Dashboard)\n'),
      b('Ngày phê duyệt: '), t('24/09/2026')
    ],
    spacing: { after: 360 }
  })
);

// 3.1.13 Main Section
docSections.push(
  new Paragraph({
    text: '3.1.13. Quy trình Quản lý giá, khuyến mãi, combo và thống kê (Admin & Storefront)',
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 240, after: 180 }
  }),
  new Paragraph({
    text: '3.1.13.1. Mô tả quy trình',
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 180, after: 120 }
  }),
  p('Quy trình Quản lý giá, khuyến mãi, combo và thống kê ngân sách của hệ thống Velura thiết lập một chu trình vận hành khép kín, an toàn và minh bạch, đảm bảo tính đồng bộ tuyệt đối giữa trải nghiệm mua sắm của khách hàng (Storefront) và trung tâm điều phối của quản trị viên (Admin Dashboard). Dựa trên kết quả nghiên cứu thực tế từ các thương hiệu thời trang số hàng đầu (điển hình như mô hình Coolmate) và yêu cầu kỹ thuật chuẩn hóa tại Jira KAN-53/54/55/56 cùng xử lý dứt điểm lỗ hổng an toàn tài chính KAN-69, quy trình này loại bỏ hoàn toàn các rủi ro can thiệp giá từ trình duyệt, áp dụng cơ chế định giá tập trung tại máy chủ và giám sát ngân sách nghiêm ngặt.'),
  
  pb('a. Quản lý giá sản phẩm và ghi nhận lịch sử điều chỉnh giá'),
  p('Tại màn hình quản trị, quản trị viên có thẩm quyền quy định và cập nhật giá gốc (niêm yết) và giá bán thực tế cho từng sản phẩm và từng biến thể (variant). Để bảo vệ lợi nhuận biên của doanh nghiệp, hệ thống kiểm soát chặt chẽ quy tắc giá bán không được thấp hơn giá vốn nhập hàng, trừ khi có cờ phê duyệt chương trình xả kho đặc biệt. Mọi biến động giá đều được tự động lưu vết vào bảng lịch sử giá (price_history) bao gồm: định danh người thực hiện (actor_id), thời gian, giá trị cũ, giá trị mới và lý do điều chỉnh, phục vụ công tác thanh tra nội bộ và đối soát kế toán.'),

  pb('b. Quản lý chiến dịch khuyến mãi và chuẩn hóa trần ngân sách'),
  p('Về bản chất phân định kiến trúc, hệ thống quy định rõ: Chiến dịch khuyến mãi (Promotion Campaign) đóng vai trò là "vỏ chứa" quản trị, chịu trách nhiệm giới hạn tổng ngân sách, xác lập khung thời gian hiệu lực và cung cấp thẻ nhận diện (badge, banner) trên giao diện Storefront. Chiến dịch không trực tiếp thực hiện chiết khấu tự động trên từng sản phẩm đơn lẻ. Thay vào đó, mọi ưu đãi tài chính đến tay khách hàng đều được chuẩn hóa thông qua Mã giảm giá (Voucher) thuộc chiến dịch đó.'),
  p('Để kiểm soát chặt chẽ ngân sách tiếp thị, hệ thống tích hợp công thức chuẩn hóa trần ngân sách: Số lượng mã tối đa được phép phát hành = Ngân sách tổng chia cho Trần giảm tối đa mỗi mã. Quá trình theo dõi ngân sách được tính toán theo mức giảm kịch trần cấu hình, đảm bảo chi phí phát hành không bao giờ vượt quá ngân sách cam kết. Khi lượng mã phát hành đạt trần hoặc hết ngân sách quy đổi, hệ thống tự động kích hoạt cơ chế ngắt khẩn cấp (Real-time Auto-stop) để bảo vệ dòng tiền.'),

  pb('c. Phát hành và thẩm định mã giảm giá (Voucher Lifecycle & 8-step evaluation)'),
  p('Mỗi mã giảm giá được cấu hình đầy đủ các tham số định lượng: mã code duy nhất (viết hoa không dấu), loại chiết khấu (giảm số tiền cố định, giảm theo phần trăm kèm trần giảm tối đa, hoặc miễn phí vận chuyển), giá trị đơn hàng tối thiểu, giới hạn lượt dùng toàn sàn, giới hạn lượt dùng trên mỗi tài khoản khách hàng, khung thời gian hiệu lực và phân nhóm đối tượng áp dụng (khách vãng lai guest, thành viên member, hoặc toàn bộ khách hàng all_users).'),
  p('Để phòng chống gian lận và thất thoát tài chính, toàn bộ thao tác ghi (tạo, cập nhật, bật, tắt) bắt buộc phải thực thi thông qua các hàm RPC bảo mật (security definer) trên cơ sở dữ liệu Postgres, có kiểm soát quyền truy cập RBAC và tự động ghi nhật ký kiểm toán (audit_log) kèm định danh người thực hiện (actor_id), thời gian và thông tin sai khác dữ liệu.'),

  pb('d. Quản lý Combo sản phẩm và cơ chế xử lý tồn kho biến thể'),
  p('Hệ thống cung cấp tính năng tạo combo/bundle sản phẩm, cho phép gom nhiều mặt hàng thành set outfit thời trang (áo, quần, phụ kiện) với mức giá ưu đãi (rẻ hơn ít nhất 5% so với tổng giá bán lẻ từng sản phẩm). Về mặt kỹ thuật, khi khách hàng thêm combo vào giỏ hàng hoặc đặt đơn, hệ thống không tạo ra một sản phẩm ảo mà phân rã combo thành các dòng đơn hàng độc lập, mỗi dòng mang đúng variant_id của sản phẩm thành phần với đơn giá catalog tương ứng. Điều này đảm bảo tính nhất quán tuyệt đối: giá mỗi dòng đơn luôn khớp với catalog, và việc trừ tồn kho được thực hiện chuẩn xác đến từng biến thể size/màu trong kho.'),

  pb('e. Trải nghiệm ví voucher và phân khúc khách hàng tại Storefront'),
  p('Phía khách hàng (Storefront), hệ thống vận hành mô hình ví voucher chấm điều kiện động theo thời gian thực (Direct Evaluation Model) mà không sử dụng bảng trung gian lưu trữ trạng thái lưu mã của từng khách hàng. Khi khách hàng truy cập giỏ hàng hoặc trang Ưu đãi, hệ thống tự động tải các mã đang kích hoạt và chạy thuật toán thẩm định 8 bước: (1) trạng thái kích hoạt, (2) phân nhóm đối tượng, (3) trạng thái chiến dịch cha, (4) khung giờ hiệu lực, (5) số lượt dùng toàn hệ thống, (6) số lượt dùng của khách hàng hiện tại, (7) giá trị đơn hàng tối thiểu và (8) trần ngân sách chiến dịch. Các mã chưa đủ điều kiện sẽ hiển thị kèm lý do từ chối cụ thể bằng tiếng Việt và số tiền hàng cần mua thêm.'),
  p('Hệ thống áp dụng nguyên tắc "Mỗi đơn hàng chỉ áp dụng một mã duy nhất" (Single Voucher Policy, No Stacking). Khi khách hàng chưa chọn mã, thuật toán quoteBestVoucher sẽ tự động đề xuất một mã đem lại mức giảm tiền thật lớn nhất sau khi đã áp trần; trường hợp mức giảm bằng nhau sẽ ưu tiên mã có thời hạn kết thúc gần nhất. Khách hàng có toàn quyền đổi sang mã khác hoặc chủ động bấm bỏ mã (khi đó hệ thống ghi nhận cờ decline_voucher và không tự ý áp lại).'),
  p('Chính sách miễn phí vận chuyển (Freeship) được xác định là một quy tắc ngưỡng giá trị đơn hàng tự động do máy chủ quy định (mặc định miễn phí toàn quốc cho đơn hàng từ 500.000đ trở lên; đơn dưới ngưỡng áp dụng 30.000đ cho giao tiêu chuẩn và 50.000đ cho giao hỏa tốc). Freeship không phải là một mã voucher, do đó khách hàng vẫn được hưởng miễn phí vận chuyển đồng thời với một mã voucher giảm giá hợp lệ.'),

  pb('f. Cơ chế định giá độc lập và chống giả mạo luồng tiền tại máy chủ (Server-side Pricing)'),
  p('Khi khách hàng nhấn xác nhận đặt hàng, máy chủ API độc lập tra cứu lại giá catalog của từng biến thể sản phẩm, tự tính toán giá trị tạm tính (subtotal), kiểm tra lại tính hợp lệ của mã voucher, áp dụng phí vận chuyển và xuất ra tổng thanh toán (total_amount). Mọi dữ liệu tài chính do trình duyệt gửi lên đều bị vô hiệu hóa; nếu phát hiện đơn giá lệch so với catalog, đơn hàng bị từ chối ngay lập tức với lỗi PRICE_MISMATCH.'),

  pb('g. Phân hệ thống kê hiệu quả kinh doanh và bảo mật phân quyền (RBAC)'),
  p('Phân hệ thống kê được truy vấn trực tiếp từ bảng orders và voucher thực tế, cung cấp các chỉ số chuẩn xác: tỷ lệ sử dụng mã, doanh thu phát sinh từ đơn có mã, giá trị đơn hàng trung bình (AOV) có mã so với không mã, và bảng so sánh hiệu quả giữa các chiến dịch. Quản trị viên cấp quản lý chiến lược được phân quyền tra cứu thông tin phục vụ ra quyết định kinh doanh theo nguyên tắc đặc quyền tối thiểu (Least Privilege), đảm bảo an toàn dữ liệu cấu hình của hệ thống.')
);

// BPMN Image embed
docSections.push(
  new Paragraph({
    text: 'Hình 3.17: Sơ đồ BPMN 2.0 chuẩn hóa quy trình Quản lý khuyến mãi, voucher và thống kê',
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120 }
  }),
  p('Sơ đồ dưới đây mô tả sự phối hợp tương tác giữa 3 thực thể tham gia (Pools): Phân hệ Quản trị (Admin Dashboard), Cổng trải nghiệm khách hàng (Storefront) và Máy chủ giao dịch độc lập (API Server).')
);

if (pngBuffer) {
  docSections.push(
    new Paragraph({
      children: [
        new ImageRun({
          data: pngBuffer,
          transformation: { width: 620, height: 350 },
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { before: 120, after: 180 }
    })
  );
}

// 3.1.13.2 Business Rules
docSections.push(
  new Paragraph({
    text: '3.1.13.2. Quy tắc nghiệp vụ',
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120 }
  }),
  p('Bảng 3.15: Bảng quy tắc nghiệp vụ chi tiết - Quy trình Quản lý giá, khuyến mãi, combo và thống kê')
);

const ruleHeaders = new TableRow({
  children: [
    tcb('Mã quy tắc', 14),
    tcb('Tên quy tắc', 22),
    tcb('Mô tả chi tiết', 38),
    tcb('Hành động hệ thống', 26),
  ],
  tableHeader: true,
});

const ruleTableRows = businessRules.map(([code, name, desc, action]) =>
  new TableRow({
    children: [tc(code, 14), tc(name, 22), tc(desc, 38), tc(action, 26)],
  })
);

docSections.push(
  new Table({
    rows: [ruleHeaders, ...ruleTableRows],
    width: { size: '100%', type: WidthType.PERCENTAGE },
  })
);

// 3.1.13.3 Exception Situations
docSections.push(
  new Paragraph({
    text: '3.1.13.3. Tình huống ngoại lệ và phương án xử lý',
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120 }
  })
);

for (const [id, title, desc, solution] of exceptionCases) {
  docSections.push(
    pb(`Tình huống ngoại lệ ${id}: ${title}`),
    new Paragraph({
      children: [b('Mô tả tình huống: '), t(desc)],
      spacing: { after: 60 }
    }),
    new Paragraph({
      children: [b('Cách thức xử lý của hệ thống: '), t(solution)],
      spacing: { after: 180 }
    })
  );
}

// 3.1.13.4 Technical Implementation Plan
docSections.push(
  new Paragraph({
    text: '3.1.13.4. Kế hoạch chuyển đổi kỹ thuật và lộ trình thực thi (Kế hoạch A4)',
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120 }
  }),
  p('Để hiện thực hóa quy trình nghiệp vụ chuẩn hóa trên hệ thống mã nguồn hiện tại, kế hoạch triển khai kỹ thuật được phân rã thành 5 giai đoạn độc lập, kiểm thử liên tục trước khi phát hành lên môi trường sản xuất:'),
  
  pb('Bước 1: Máy chủ tự tính tiền và chặn đứng lỗ hổng giá (Đã hoàn thành - PR #30 / KAN-69)'),
  p('Xây dựng module thuần order-pricing.ts độc lập, nhận danh sách dòng hàng, tra cứu giá catalog từ bảng product qua variant_id, tự tính toán subtotal, shipping_fee, discount_amount và total_amount. Đóng hoàn toàn lỗ hổng nhận giá từ client trong cả hai luồng đặt đơn (guest OTP và member). Bắt buộc unit_price gửi lên phải khớp catalog; nếu lệch, từ chối giao dịch với mã lỗi PRICE_MISMATCH.'),

  pb('Bước 2: Chuẩn hóa toàn bộ thao tác ghi qua RPC có kiểm toán bảo mật'),
  p('Loại bỏ hoàn toàn việc sử dụng service-role key để ghi trực tiếp vào cơ sở dữ liệu tại pricing-repository.ts. Viết migration chuẩn hóa các hàm RPC: admin_create_promotion nhận đủ tham số mô tả; admin_create_voucher kiểm tra phân quyền RBAC (super_admin hoặc admin_operator_gia_km), kiểm tra start_date < end_date, và chốt trần số mã tối đa; admin_update_voucher hỗ trợ cập nhật toàn diện các trường nghiệp vụ; và tự động ghi bản ghi vào audit_log kèm actor_id.'),

  pb('Bước 3: Xây dựng màn hình quản lý Voucher cho Admin Dashboard'),
  p('Xây dựng giao diện voucher-form.ts và voucher-form.html theo đúng design system của Velura, áp dụng cơ chế khóa lạc quan (expectedVersion). Biểu mẫu hỗ trợ đầy đủ các nhóm trường: Định danh, Giá trị, Điều kiện, Kho lượt, Thời gian. Tích hợp tính năng xem trước (Ceiling Preview): khi nhập ngân sách chiến dịch, hệ thống tự động hiển thị số mã tối đa phát hành được dựa trên công thức trần giảm.'),

  pb('Bước 4: Tái thiết lập phân hệ thống kê từ dữ liệu đơn hàng thực tế'),
  p('Viết lại hàm getStatistics trong pricing-repository.ts: chuyển từ việc đếm dòng thô sang truy vấn tổng hợp từ bảng orders và voucher. Tính toán chính xác tỷ lệ sử dụng mã, doanh thu từ đơn có mã, so sánh giá trị đơn hàng trung bình (AOV), và so sánh hiệu quả giữa các chiến dịch. Ứng dụng promotionLifecycle để phản ánh đúng 5 trạng thái vòng đời của chiến dịch, thay thế việc gộp chung vào trạng thái paused.'),

  pb('Bước 5: Đồng bộ hóa trải nghiệm người dùng phía Storefront'),
  p('Đưa ngưỡng freeship 500.000đ về quản lý tập trung tại cấu hình máy chủ (config.ts), cung cấp API cho Storefront hiển thị thanh tiến độ "Mua thêm X để được miễn phí vận chuyển". Đưa component voucher-wallet vào giỏ hàng. Loại bỏ hoàn toàn hằng số HOT_BANNERS viết cứng, thay bằng API /api/user/offers. Chuẩn hóa trang Ưu đãi thành 3 tab phân khúc: "Dành riêng cho bạn", "Đang diễn ra", và "Sắp hết hạn".')
);

// 3.1.13.5 Voucher Form Specification
docSections.push(
  new Paragraph({
    text: '3.1.13.5. Đặc tả kỹ thuật biểu mẫu phát hành mã giảm giá (Admin Voucher Form)',
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120 }
  }),
  p('Bảng 3.16: Bảng đặc tả trường dữ liệu biểu mẫu tạo/sửa Voucher trên Admin Dashboard')
);

const voucherFormFields = [
  ['Mã voucher (code)', 'Định danh', 'Chuỗi ký tự viết hoa không dấu (ví dụ: VELURA50)', 'Bắt buộc, duy nhất toàn sàn, không dấu'],
  ['Tên voucher (name)', 'Định danh', 'Tên gợi nhớ hiển thị cho khách (ví dụ: Giảm 50k đơn đầu)', 'Bắt buộc, tối đa 100 ký tự'],
  ['Chiến dịch cha (promo_id)', 'Liên kết', 'Chọn từ danh sách chiến dịch đang kích hoạt', 'Bắt buộc, thuộc 1 chiến dịch hợp lệ'],
  ['Loại giảm (discount_type)', 'Giá trị', 'fixed_amount (tiền cố định) hoặc percentage (phần trăm)', 'Bắt buộc, chọn từ danh mục enum'],
  ['Giá trị giảm (discount_value)', 'Giá trị', 'Số tiền (VNĐ) hoặc Tỷ lệ phần trăm (1 - 100%)', 'Bắt buộc, số dương'],
  ['Trần giảm (max_discount_amount)', 'Giá trị', 'Số tiền giảm tối đa (bắt buộc khi chọn giảm %)', 'Bắt buộc nếu type = percentage'],
  ['Đơn tối thiểu (min_order_value)', 'Điều kiện', 'Giá trị hàng tối thiểu để áp dụng mã', 'Bắt buộc, mặc định 0đ'],
  ['Nhóm khách (applicable_user_group)', 'Điều kiện', 'guest (vãng lai), member (thành viên), all_users (tất cả)', 'Bắt buộc, phân luồng ví voucher'],
  ['Lượt toàn sàn (usage_limit_total)', 'Kho lượt', 'Tổng số lần mã được phép sử dụng toàn hệ thống', 'Tùy chọn, để trống = không giới hạn'],
  ['Lượt mỗi khách (usage_limit_per_user)', 'Kho lượt', 'Số lần tối đa 1 tài khoản khách được dùng mã', 'Bắt buộc, mặc định 1 lần/khách'],
  ['Thời gian (start_date - end_date)', 'Hiệu lực', 'Khung giờ bắt đầu và kết thúc áp dụng mã', 'Bắt buộc, start_date < end_date']
];

const formHeaderRow = new TableRow({
  children: [tcb('Tên trường', 25), tcb('Nhóm', 15), tcb('Mô tả & Định dạng', 35), tcb('Quy tắc kiểm tra (Validation)', 25)],
  tableHeader: true,
});
const formTableRows = voucherFormFields.map(r => new TableRow({ children: [tc(r[0], 25), tc(r[1], 15), tc(r[2], 35), tc(r[3], 25)] }));
docSections.push(new Table({ rows: [formHeaderRow, ...formTableRows], width: { size: '100%', type: WidthType.PERCENTAGE } }));

// Appendix: BPMN Specification Matrix
docSections.push(
  new Paragraph({
    text: 'Phụ lục A: Ma trận đặc tả thành phần BPMN 2.0 chi tiết',
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120 }
  }),
  pb('1. Đặc tả thành phần Pool Quản trị (Velura Admin Dashboard)')
);

const adminNodes = [
  ['Admin_Start', 'Start Event', 'QTV Giá KM', 'Mở phân hệ Quản lý Khuyến mãi', 'Admin_T1_OpenWorkspace'],
  ['Admin_T1', 'User Task', 'QTV Giá KM', 'Xem danh sách chiến dịch, mã giảm giá, combo và bảng thống kê', 'Admin_G1_SelectAction'],
  ['Admin_G1', 'Exclusive Gateway', 'QTV Giá KM', 'Phân nhánh lựa chọn nghiệp vụ cần thực hiện', 'T2 / T3 / T4 / T6 / T8'],
  ['Admin_T2', 'User Task', 'QTV Giá KM', 'Thiết lập chiến dịch: tên, phân loại, khung giờ, trần ngân sách', 'Admin_G2_ValidatePayload'],
  ['Admin_T3', 'User Task', 'QTV Giá KM', 'Phát hành mã: code, loại giảm, đơn tối thiểu, nhóm đối tượng, hạn', 'Admin_G2_ValidatePayload'],
  ['Admin_T4', 'User Task', 'QTV Giá KM', 'Sửa mã: điều chỉnh giá trị giảm, trần giảm, lượt dùng, nhóm áp dụng', 'Admin_G2_ValidatePayload'],
  ['Admin_G2', 'Exclusive Gateway', 'Hệ thống Quản trị', 'Kiểm tra tính hợp lệ của dữ liệu đầu vào phía máy chủ', 'Admin_T5 (hợp lệ) / Báo lỗi (không hợp lệ)'],
  ['Admin_T5', 'Service Task', 'Hệ thống Quản trị', 'Gọi RPC bảo mật (security definer), kiểm tra vai trò & ghi audit_log', 'Admin_T7_CeilingBudget'],
  ['Admin_T7', 'Service Task', 'Hệ thống Quản trị', 'Chuẩn hóa ngân sách: Tính trần mã tối đa = Ngân sách / Trần giảm', 'Admin_G3_MergeActions'],
  ['Admin_T6', 'User Task', 'QTV Giá KM', 'Bật / Tạm dừng chiến dịch hoặc mã giảm giá (kèm expectedVersion)', 'Admin_G3_MergeActions'],
  ['Admin_T8', 'User Task', 'QTV Giá KM', 'Xem thống kê hiệu quả: tỷ lệ dùng, doanh thu đơn có mã, đối soát chi phí', 'Admin_G3_MergeActions'],
  ['Admin_G3', 'Exclusive Gateway', 'QTV Giá KM', 'Điểm gom các luồng thao tác hoàn tất', 'Admin_End'],
  ['Admin_End', 'End Event', 'QTV Giá KM', 'Hoàn tất tác vụ quản trị khuyến mãi', 'Kết thúc']
];

const adminHeaderRow = new TableRow({
  children: [tcb('Mã Node', 15), tcb('Loại BPMN', 18), tcb('Làn thực thi (Lane)', 20), tcb('Mô tả hành động nghiệp vụ', 32), tcb('Đích tiếp theo', 15)],
  tableHeader: true,
});
const adminTableRows = adminNodes.map(r => new TableRow({ children: [tc(r[0], 15), tc(r[1], 18), tc(r[2], 20), tc(r[3], 32), tc(r[4], 15)] }));
docSections.push(new Table({ rows: [adminHeaderRow, ...adminTableRows], width: { size: '100%', type: WidthType.PERCENTAGE } }));

docSections.push(
  p(''),
  pb('2. Đặc tả thành phần Pool Cổng khách hàng (Velura Storefront)')
);

const userNodes = [
  ['User_Start', 'Start Event', 'Khách hàng', 'Truy cập Giỏ hàng hoặc Trang Ưu đãi', 'User_T1_BrowseOffers'],
  ['User_T1', 'User Task', 'Khách hàng', 'Mở ví voucher: Dành riêng cho bạn, Đang diễn ra, Sắp hết hạn', 'User_T2_EvaluateWallet'],
  ['User_T2', 'Service Task', 'Hệ thống Storefront', 'Chấm 8 bước điều kiện ví, lọc theo nhóm khách (guest/member), hiện tiền thiếu', 'User_T4_QuoteBestVoucher'],
  ['User_T4', 'Service Task', 'Hệ thống Storefront', 'Thuật toán quoteBestVoucher tự động áp mã tối ưu (giảm nhiều nhất, hạn gần)', 'User_T3_ManageSelection'],
  ['User_T3', 'User Task', 'Khách hàng', 'Xem mức giảm, chủ động chọn mã khác hoặc bấm bỏ áp dụng mã', 'User_G1_HasEligibleVoucher'],
  ['User_G1', 'Exclusive Gateway', 'Hệ thống Storefront', 'Kiểm tra trạng thái khách hàng có đồng ý dùng mã hay không', 'T5 (dùng mã) / T6 (bỏ mã)'],
  ['User_T5', 'Service Task', 'Hệ thống Storefront', 'Hiển thị số tiền giảm tạm tính của voucher lên giỏ hàng / checkout', 'User_T6_ComputeShipping'],
  ['User_T6', 'Service Task', 'Hệ thống Storefront', 'Tính phí ship theo ngưỡng cấu hình server (đơn hàng từ 500k miễn phí)', 'User_T7_SubmitOrder'],
  ['User_T7', 'User Task', 'Khách hàng', 'Xác nhận đặt đơn (Guest: xác thực OTP email; Member: địa chỉ mặc định)', 'User_End_OrderCreated'],
  ['User_End', 'End Event', 'Khách hàng', 'Gửi lệnh tạo đơn hàng kèm voucher_id về API Server', 'Chuyển giao diện']
];

const userHeaderRow = new TableRow({
  children: [tcb('Mã Node', 15), tcb('Loại BPMN', 18), tcb('Làn thực thi (Lane)', 20), tcb('Mô tả hành động nghiệp vụ', 32), tcb('Đích tiếp theo', 15)],
  tableHeader: true,
});
const userTableRows = userNodes.map(r => new TableRow({ children: [tc(r[0], 15), tc(r[1], 18), tc(r[2], 20), tc(r[3], 32), tc(r[4], 15)] }));
docSections.push(new Table({ rows: [userHeaderRow, ...userTableRows], width: { size: '100%', type: WidthType.PERCENTAGE } }));

docSections.push(
  p(''),
  pb('3. Đặc tả thành phần Pool Máy chủ định giá (Velura API Server)')
);

const apiNodes = [
  ['API_Start', 'Start Event', 'Máy chủ API', 'Nhận payload yêu cầu đặt đơn hàng từ Storefront', 'API_T1_CatalogCheck'],
  ['API_T1', 'Service Task', 'Máy chủ API', 'Tra cứu giá catalog theo variant_id và so khớp với unit_price client gửi', 'API_G1_PriceMatch'],
  ['API_G1', 'Exclusive Gateway', 'Máy chủ API', 'Kiểm tra tính toàn vẹn của giá dòng hàng', 'API_T2 (khớp) / API_End_Reject (lệch)'],
  ['API_T2', 'Service Task', 'Máy chủ API', 'Tự tính độc lập subtotal = tổng(giá_catalog x số_lượng)', 'API_T3_EvaluateVoucher'],
  ['API_T3', 'Service Task', 'Máy chủ API', 'Thẩm định lại mã tại server (evaluateVoucher) & tính discount_amount chuẩn', 'API_T4_FinalizeTotals'],
  ['API_T4', 'Service Task', 'Máy chủ API', 'Tính phí vận chuyển theo cấu hình & tổng thanh toán = subtotal + ship - discount', 'API_T5_PersistOrder'],
  ['API_T5', 'Service Task', 'Máy chủ API', 'Ghi đơn pending, tăng used_count và trừ ngân sách kịch trần qua RPC', 'API_End_Success'],
  ['API_End_Ok', 'End Event', 'Máy chủ API', 'Khởi tạo đơn hàng thành công, phản hồi mã đơn và thông tin cho khách', 'Kết thúc luồng'],
  ['API_End_Err', 'Terminate End Event', 'Máy chủ API', 'Từ chối đơn hàng: Lỗi PRICE_MISMATCH, ngắt toàn bộ giao dịch', 'Báo lỗi client']
];

const apiHeaderRow = new TableRow({
  children: [tcb('Mã Node', 15), tcb('Loại BPMN', 18), tcb('Làn thực thi (Lane)', 20), tcb('Mô tả hành động nghiệp vụ', 32), tcb('Đích tiếp theo', 15)],
  tableHeader: true,
});
const apiTableRows = apiNodes.map(r => new TableRow({ children: [tc(r[0], 15), tc(r[1], 18), tc(r[2], 20), tc(r[3], 32), tc(r[4], 15)] }));
docSections.push(new Table({ rows: [apiHeaderRow, ...apiTableRows], width: { size: '100%', type: WidthType.PERCENTAGE } }));

docSections.push(
  p(''),
  pb('4. Ma trận tích hợp dữ liệu và sự kiện liên Pool (Inter-Pool Integration Matrix)')
);

const integrationNodes = [
  ['Phát hành mã mới', 'Admin ghi nhận mã, nhóm khách, hạn dùng, trần ngân sách', 'Ví voucher Storefront tự động cập nhật danh sách khả dụng', 'Bảng voucher, RPC admin_create_voucher, audit_log'],
  ['Báo giá tạm tính', 'Không can thiệp, quản trị viên chỉ xem thống kê', 'Client gọi POST /api/user/vouchers/best hoặc /apply để lấy mức giảm', 'Module voucher-quote độc lập, hàm quoteBestVoucher'],
  ['Xác nhận đặt đơn', 'Nhận số liệu tăng used_count và total_discount_issued', 'Client gửi yêu cầu kèm voucher_id hoặc cờ decline_voucher', 'Hàm resolveCheckoutPricing, recordVoucherRedemption'],
  ['Hủy đơn hàng', 'Admin thực hiện hủy đơn theo quy trình quản trị đơn hàng', 'Khách hàng hủy đơn khi ở trạng thái chờ xử lý (pending/confirmed)', 'Tự động hoàn 1 lượt used_count và giảm total_discount_issued'],
  ['Cạn ngân sách', 'Dashboard hiển thị trạng thái "Đã hết ngân sách"', 'Mã tự động ẩn khỏi ví hoặc chuyển trạng thái không khả dụng', 'Kích hoạt lệnh ngắt tự động (Real-time auto-stop)']
];

const integHeaderRow = new TableRow({
  children: [tcb('Sự kiện nghiệp vụ', 20), tcb('Hành động Admin', 25), tcb('Phản ứng Storefront Khách hàng', 30), tcb('Điểm chốt kỹ thuật & Cơ sở dữ liệu', 25)],
  tableHeader: true,
});
const integTableRows = integrationNodes.map(r => new TableRow({ children: [tc(r[0], 20), tc(r[1], 25), tc(r[2], 30), tc(r[3], 25)] }));
docSections.push(new Table({ rows: [integHeaderRow, ...integTableRows], width: { size: '100%', type: WidthType.PERCENTAGE } }));

// Final packaging
const document = new Document({
  sections: [{
    properties: {
      page: {
        margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 }
      }
    },
    children: docSections
  }]
});

const docxBuffer = await Packer.toBuffer(document);

// Write to both docx targets
writeFileSync(join(BA_DIR, 'Velura-3.1.13-Khuyen-mai.docx'), docxBuffer);
writeFileSync(join(BA_DIR, 'Velura-Chuong-3-Khuyen-mai-BPMN.docx'), docxBuffer);
console.log('4. Docx generated and written to docs/ba/Velura-3.1.13-Khuyen-mai.docx and docs/ba/Velura-Chuong-3-Khuyen-mai-BPMN.docx');

console.log('--- ALL DELIVERABLES COMPLETED SUCCESSFULLY ---');
