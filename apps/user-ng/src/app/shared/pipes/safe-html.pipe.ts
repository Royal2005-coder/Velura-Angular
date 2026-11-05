import { Pipe, PipeTransform, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

/**
 * Bypasses Angular's default inline style stripping for server-sanitized editorial HTML.
 * Only use for content verified by `sanitizeBlogHtml`.
 */
@Pipe({
  name: 'safeHtml',
  standalone: true,
})
export class SafeHtmlPipe implements PipeTransform {
  private readonly sanitizer = inject(DomSanitizer);

  transform(value: string | null | undefined): SafeHtml {
    const raw = String(value || '');
    if (!raw.trim()) return '';
    const clean = raw
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
      .replace(/\s+on\w+="[^"]*"/gi, '')
      .replace(/\s+on\w+='[^']*'/gi, '')
      .replace(/\s+on\w+=\S+/gi, '')
      .replace(/\s+(?:src|href)=["']\s*javascript:[^"']*["']/gi, '');
    return this.sanitizer.bypassSecurityTrustHtml(clean);
  }
}
