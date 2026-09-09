import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface AdminCatalogRow {
  product_id: string;
  sku?: string;
  name: string;
  category_name?: string | null;
  base_price?: number;
  sale_price?: number | null;
  status?: string;
  images?: string[];
  collection?: string | null;
  updated_at?: string | null;
  is_combo?: boolean;
}

@Injectable({ providedIn: 'root' })
export class AdminCatalogService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiUrl;

  /**
   * Reads the public lite catalog for the admin product table.
   */
  listProducts(): Observable<AdminCatalogRow[]> {
    return this.http.get<AdminCatalogRow[]>(`${this.baseUrl}/api/user/products?lite=1`);
  }
}
