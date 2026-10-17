-- KAN-58: add the canonical Jira KAN-31/KAN-32 states; use them only after this transaction commits.
alter type public.return_status add value if not exists 'REQUESTED';
alter type public.return_status add value if not exists 'CONTACTING';
alter type public.return_status add value if not exists 'WAITING_RETURN';
alter type public.return_status add value if not exists 'RETURN_IN_TRANSIT';
alter type public.return_status add value if not exists 'RECEIVED';
alter type public.return_status add value if not exists 'REFUND_PROCESSING';
alter type public.return_status add value if not exists 'REFUNDED';
alter type public.return_status add value if not exists 'EXCHANGE_PREPARING';
alter type public.return_status add value if not exists 'EXCHANGE_SHIPPING';
alter type public.return_status add value if not exists 'COMPLETED';
alter type public.return_status add value if not exists 'CANCELLED';
alter type public.return_status add value if not exists 'NEEDS_SUPPORT';
alter type public.condition_check add value if not exists 'qa_pass';
alter type public.condition_check add value if not exists 'qa_fail';
