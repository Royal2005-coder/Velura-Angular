import { Injectable } from '@angular/core';
import { BLOG_POSTS, BlogPost } from '../models/blog-post';

@Injectable({ providedIn: 'root' })
export class BlogCatalogService {
  /**
   * Returns the original Velura Journal catalog.
   */
  list(): BlogPost[] {
    return BLOG_POSTS;
  }

  /**
   * Finds one journal article by slug.
   */
  bySlug(slug: string): BlogPost | undefined {
    return BLOG_POSTS.find((post) => post.slug === slug);
  }
}
