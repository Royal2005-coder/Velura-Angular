-- Guest and member voucher audiences, and the 30-day return window in published policy text.

alter type public.applicable_user_group add value if not exists 'guest';
alter type public.applicable_user_group add value if not exists 'member';

update public.policy
set summary = replace(replace(summary, '2 ngày (48 giờ)', '30 ngày'), '48 giờ', '30 ngày'),
    content = replace(replace(content::text, '2 ngày (48 giờ)', '30 ngày'), '48 giờ', '30 ngày')::jsonb,
    updated_at = now()
where summary like '%48 giờ%'
   or content::text like '%48 giờ%';
