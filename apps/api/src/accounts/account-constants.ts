/**
 * PostgREST column projection for account rows. Omits secrets and addresses.
 */
export const ACCOUNT_SELECT = [
  "user_id",
  "email",
  "phone",
  "full_name",
  "date_of_birth",
  "gender",
  "avatar",
  "role",
  "admin_role",
  "is_active",
  "is_verified",
  "failed_login_count",
  "locked_until",
  "lock_type",
  "lock_reason",
  "unlock_reason",
  "locked_by",
  "locked_at",
  "created_at",
  "last_login_at",
  "version",
  "updated_at"
].join(",");

/**
 * Canonical admin_role values accepted by account mutations and filters.
 */
export const ADMIN_ROLES = [
  "admin_viewer",
  "admin_operator_sanpham",
  "admin_operator_donhang",
  "admin_operator_cskh_dt",
  "admin_operator_gia_km",
  "admin_operator_danhgia_review",
  "super_admin"
];

/**
 * Canonical `users.role` values: member or admin.
 */
export const ACCOUNT_ROLES = ["member", "admin"];

/**
 * One selectable role row shown to super admins.
 */
export interface AccountRoleOption {
  role: string;
  adminRole: string | null;
  label: string;
}

/**
 * Role picker options for the admin accounts UI.
 */
export const ROLE_OPTIONS: AccountRoleOption[] = [
  { role: "member", adminRole: null, label: "Member" },
  { role: "admin", adminRole: "admin_viewer", label: "Admin chi xem" },
  { role: "admin", adminRole: "admin_operator_sanpham", label: "Admin quan ly san pham" },
  { role: "admin", adminRole: "admin_operator_donhang", label: "Admin quan ly don hang" },
  { role: "admin", adminRole: "admin_operator_cskh_dt", label: "Admin doi tra va CSKH" },
  { role: "admin", adminRole: "admin_operator_gia_km", label: "Admin quan ly gia va khuyen mai" },
  { role: "admin", adminRole: "admin_operator_danhgia_review", label: "Admin quan ly danh gia" },
  { role: "admin", adminRole: "super_admin", label: "Admin quan tri" }
];
