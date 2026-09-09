-- UC-A04 moderators need the referenced product identity even when a product
-- is hidden after the customer submitted the review.
drop policy if exists product_admin_select on public.product;
create policy product_admin_select on public.product
for select to authenticated
using (
  status = 'on_sale'
  or (select public.velura_has_admin_role(array[
    'super_admin',
    'admin_operator_sanpham',
    'admin_operator_gia_km',
    'admin_operator_danhgia_review'
  ]))
);
