export interface ReviewReplyItem {
  user_name: string;
  role: 'admin' | 'customer';
  reply_text: string;
  created_at: string;
}

export interface UserReviewItem {
  review_id: string;
  product_id: string;
  user_id: string;
  order_id: string;
  rating: number;
  comment?: string | null;
  images?: string[] | null;
  review_tags?: string[] | null;
  status: 'pending' | 'approved' | 'rejected';
  submitted_at?: string;
  created_at?: string;
  admin_reply?: string | null;
  product_name?: string;
  product_image?: string;
}

export interface CreateReviewPayload {
  product_id: string;
  order_id: string;
  rating: number;
  comment?: string;
  images?: string[];
  review_tags?: string[];
}
