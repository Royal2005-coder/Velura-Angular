/** A moderated conversation attached to a product review. */
export interface ReviewReplyItem {
  user_name: string;
  role: 'admin' | 'customer';
  reply_text: string;
  created_at: string;
}

/** Review ownership and purchased-product facts are determined by the API, not a browser badge. */
export interface UserReviewItem {
  review_id: string;
  product_id: string;
  user_id: string | null;
  order_id: string | null;
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
  verified_purchase?: boolean;
  variant_id?: string | null;
  variant_size?: string | null;
  variant_color?: string | null;
}

/** Product feedback does not require a purchase; optional order/variant context is verified server-side. */
export interface CreateReviewPayload {
  product_id: string;
  order_id?: string | null;
  variant_id?: string | null;
  rating: number;
  comment?: string;
  images?: string[];
  review_tags?: string[];
  full_name?: string;
}

/** Delivery channel is explicit: email transport in SMS demo is not verification of a real purchase. */
export interface ReviewOtpChallenge {
  success: boolean;
  challenge_id: string;
  expires_in: number;
  channel: 'sms' | 'sms_demo';
  delivery: 'sms' | 'email';
  demo: boolean;
  masked_email?: string;
}
