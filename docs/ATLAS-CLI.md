# Atlas CLI và truy cập cluster Velura

`atlas` trên workspace này là CLI discovery/OIDC cho cluster và dịch vụ,
không phải Atlassian/Jira CLI, GitHub CLI hay công cụ deploy thay Flux.
Jira `KAN` dùng Atlassian MCP trong [MCP-SETUP](MCP-SETUP.md).

## 1. Lệnh đã kiểm tra trên bản CLI hiện có

```bash
atlas version
atlas status
atlas list-clusters
atlas list-services
atlas describe-cluster <name> --output text
atlas login
atlas login --cluster <name>
atlas update-kubeconfig <name> -k <protected-kubeconfig-path>
```

Thay `<name>` bằng tên thật do `list-clusters` quảng bá. `login` mở PKCE browser
flow và CLI quản lý session theo realm. Không truyền mật khẩu trên command line,
không in `get-kubeconfig` vào chat/log, không commit cache session/kubeconfig.
Tài liệu này không cấp quyền trong identity provider; người quản trị Atlas phải
cấp group/service/cluster đúng realm theo vai trò.

## 2. Trạng thái tích hợp và giới hạn

Inventory kiểm tra ngày 2026-10-19 chỉ quảng bá `ailab` và `commodities`, chưa có
cluster tên Velura. Vì vậy không giả định hai context đó là cluster production
của dự án này và không chạy lệnh mutate vào chúng để deploy Velura.

Cluster Velura hiện được owner vận hành qua SSH alias `ai1-k3s` và kube-system
UID `a9517754-4868-46b9-8e8f-8c2370e53cff`. Việc đăng ký nó vào Atlas là thao tác riêng
của quản trị discovery/OIDC/RBAC; CLI không có lệnh `grant`, `deploy` hay `reconcile`
để agent tự sáng tác. Chỉ ghi nhận Atlas access là hoàn tất khi discovery thật
và group/RBAC đúng đã được xác minh.

## 3. Quyền làm việc của team

- Frontend/fullstack dev dùng GitHub Write + PR/CI; không cần kubeconfig/admin SSH.
- Royal/Quỳnh kiểm tra runtime bằng owner Ops CLI và explicit context/cluster UID.
- Cấp quyền GitHub không tự cấp quyền Atlas, Kubernetes hoặc Keycloak.
- Namespace credentials, Cloudflare token, GitHub App PEM và SOPS private key không
  đi theo bản clone của đồng đội. Dùng API public/local sandbox được cấp cho dev.

Một lần publish bình thường đi qua [TEAM-WORKFLOW](TEAM-WORKFLOW.md): GitHub App
chuẩn bị PR, main giữ pins, Flux root/platform/production tự reconcile. Atlas chỉ
hỗ trợ discovery/auth khi đã tích hợp; không là một pipeline deploy thứ hai.
