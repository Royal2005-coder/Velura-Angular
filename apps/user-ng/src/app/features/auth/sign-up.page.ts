import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { catchError, combineLatest, debounceTime, map, of, startWith, switchMap, tap } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { WishlistStore } from '../../core/services/wishlist.store';
import { showToast } from '../../core/utils/toast';
import { AuthOtpModal, AuthOtpResult } from '../../shared/auth-otp-modal/auth-otp-modal';

@Component({
  selector: 'app-sign-up-page',
  imports: [ReactiveFormsModule, RouterLink, AuthOtpModal],
  host: { class: 'velura-auth-page' },
  templateUrl: './sign-up.page.html',
})
export class SignUpPage {
  private readonly forms = inject(FormBuilder);
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly wishlist = inject(WishlistStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly errorMessage = signal<string | null>(null);
  readonly showPassword = signal(false);
  readonly showConfirm = signal(false);
  readonly submitting = signal(false);
  readonly otpOpen = signal(false);
  readonly otpIdentity = signal('');
  readonly otpDevelopmentCode = signal('');
  readonly checkingIdentity = signal(false);
  readonly duplicateEmail = signal(false);
  readonly duplicatePhone = signal(false);

  readonly form = this.forms.nonNullable.group({
    fullname: ['', Validators.required],
    phone: ['', [Validators.required, Validators.pattern(/^\+?[\d\s-]{8,24}$/)]],
    email: ['', Validators.email],
    password: ['', [Validators.required, Validators.minLength(8)]],
    password_confirm: ['', Validators.required],
    referral_code: [this.route.snapshot.queryParamMap.get('referral') || ''],
  });

  constructor() {
    combineLatest([
      this.form.controls.email.valueChanges.pipe(startWith(this.form.controls.email.value)),
      this.form.controls.phone.valueChanges.pipe(startWith(this.form.controls.phone.value)),
    ]).pipe(
      tap(() => {
        this.checkingIdentity.set(true);
        this.duplicateEmail.set(false);
        this.duplicatePhone.set(false);
      }),
      debounceTime(450),
      map(([email, phone]) => ({ email: email.trim().toLowerCase(), phone: this.normalizePhone(phone) })),
      switchMap((identity) => {
        if (this.form.controls.email.invalid || this.form.controls.phone.invalid) {
          this.checkingIdentity.set(false);
          return of(null);
        }
        return this.api.post<SignupAvailability>('/api/user/auth/signup-availability', identity).pipe(
          catchError(() => of(null)),
        );
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((availability) => {
      this.checkingIdentity.set(false);
      this.duplicateEmail.set(Boolean(availability?.emailExists));
      this.duplicatePhone.set(Boolean(availability?.phoneExists));
    });
  }

  /**
   * Creates a member account through the original signup API.
   */
  submit(): void {
    this.errorMessage.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.errorMessage.set('Vui lòng nhập đầy đủ thông tin bắt buộc và kiểm tra định dạng email, số điện thoại.');
      return;
    }
    if (this.checkingIdentity() || this.duplicateEmail() || this.duplicatePhone()) {
      this.errorMessage.set('Email hoặc số điện thoại đã có tài khoản. Vui lòng kiểm tra lại.');
      return;
    }
    if (this.form.controls.password.value !== this.form.controls.password_confirm.value) {
      this.errorMessage.set('Mật khẩu xác nhận chưa khớp.');
      return;
    }
    this.submitting.set(true);
    const normalizedEmail = this.form.controls.email.value.trim().toLowerCase();
    const normalizedPhone = this.normalizePhone(this.form.controls.phone.value);
    const identity = normalizedEmail || normalizedPhone;
    this.api
      .post<{ token?: string; user?: Record<string, unknown>; otp_required?: boolean; development_otp?: string }>('/api/user/auth/signup', {
        full_name: this.form.controls.fullname.value,
        phone: normalizedPhone,
        email: normalizedEmail,
        password: this.form.controls.password.value,
        referral_code: this.form.controls.referral_code.value.trim().toUpperCase() || undefined,
      })
      .subscribe({
        next: (response) => {
          this.submitting.set(false);
          if (response.otp_required) {
            this.otpIdentity.set(identity);
            this.otpDevelopmentCode.set(response.development_otp || '');
            this.otpOpen.set(true);
            return;
          }
          this.finishAuth(response);
        },
        error: (error: Error) => {
          this.submitting.set(false);
          this.errorMessage.set(error.message);
        },
      });
  }

  /**
   * Completes signup after the original OTP dialog verifies.
   */
  onOtpVerified(result: AuthOtpResult): void {
    this.otpOpen.set(false);
    this.finishAuth(result);
  }

  /**
   * Closes the original OTP dialog without creating a session.
   */
  onOtpCancelled(): void {
    this.otpOpen.set(false);
  }

  private finishAuth(response: { token?: string; user?: Record<string, unknown> }): void {
    this.auth.applySession(response.token, response.user);
    this.wishlist.refresh();
    showToast('Đăng ký tài khoản thành công! Chào mừng bạn đến với Velura 🎉');
    void this.router.navigateByUrl('/');
  }

  private normalizePhone(phone: string): string {
    return phone.trim().replace(/[^\d+]/g, '');
  }
}

interface SignupAvailability {
  emailExists: boolean;
  phoneExists: boolean;
  pairExists: boolean;
}
