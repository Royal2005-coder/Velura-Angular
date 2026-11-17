  createOrderCarrierLabel(orderId: string): Observable<AdminOrderCarrierLabel> {
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, finalize, shareReplay } from 'rxjs';
import { environment } from '../../environments/environment';
import { AdminListPayload } from './admin-erp-http';
import { AdminAuthMe } from './admin-erp-session.service';
