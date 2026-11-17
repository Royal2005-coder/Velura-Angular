import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

/** Curated editorial gradient preset for Velura lookbooks. */
export interface AdminGradientSwatch {
  readonly id: string;
  readonly label: string;
  readonly css: string;
  readonly dark: boolean;
}

export const VELURA_GRADIENT_SWATCHES: readonly AdminGradientSwatch[] = [
  {
    id: 'pastel-soft',
    label: 'Pastel Soft',
    css: 'linear-gradient(115deg, #D9D7C8 0%, #EEE6D9 48%, #E9D4CE 100%)',
    dark: false,
  },
  {
    id: 'urban-taupe',
    label: 'Urban Taupe',
    css: 'linear-gradient(115deg, #C9C2B8 0%, #E4DDD3 48%, #BBB7AD 100%)',
    dark: false,
  },
  {
    id: 'sage-mist',
    label: 'Sage Mist',
    css: 'linear-gradient(115deg, #B5C4B1 0%, #DCE5D8 48%, #C8D5C4 100%)',
    dark: false,
  },
  {
    id: 'midnight-slate',
    label: 'Midnight Slate',
    css: 'linear-gradient(115deg, #2D2F36 0%, #3D414B 48%, #525866 100%)',
    dark: true,
  },
  {
    id: 'afterglow-rose',
    label: 'Rose Afterglow',
    css: 'linear-gradient(115deg, #C9A998 0%, #DCBDB0 48%, #E8D3C9 100%)',
    dark: false,
  },
  {
    id: 'velvet-wine',
    label: 'Velvet Wine',
    css: 'linear-gradient(115deg, #4A1D2F 0%, #6D2944 48%, #3B1625 100%)',
    dark: true,
  },
  {
    id: 'champagne-silk',
    label: 'Champagne Silk',
    css: 'linear-gradient(115deg, #E6DDD0 0%, #F5EFE6 48%, #DFCBB8 100%)',
    dark: false,
  },
  {
    id: 'pearl-minimal',
    label: 'Pearl Minimal',
    css: 'linear-gradient(115deg, #E2E8F0 0%, #F8FAFC 48%, #CBD5E1 100%)',
    dark: false,
  },
];

const ANGLES: readonly { deg: number; label: string }[] = [
  { deg: 115, label: 'Chéo 115°' },
  { deg: 90, label: 'Ngang 90°' },
  { deg: 135, label: 'Chéo sâu 135°' },
  { deg: 180, label: 'Dọc 180°' },
];

const SIMPLE_GRADIENT_RE =
  /^linear-gradient\(\s*(\d+)deg\s*,\s*(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})\s+\d+%\s*,\s*(?:(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})\s+\d+%\s*,\s*)?(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})\s+\d+%\s*\)$/;

interface ParsedGradient {
  readonly matched: boolean;
  readonly angle: number;
  readonly start: string;
  readonly mid: string;
  readonly end: string;
}

/**
 * Visual gradient picker for Collection heroes (`5 người mẫu`), replacing raw CSS code with curated swatches,
 * safe `#rrggbb` color stops, direction pills, and an optional advanced CSS disclosure.
 */
@Component({
  selector: 'app-erp-gradient-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (deemphasized() && !expandedWhenCover()) {
      <div class="grad-collapsed">
        <span class="grad-collapsed__swatch" [style.background]="previewCss()"></span>
        <span class="grad-collapsed__text">Đang chọn chế độ Ảnh bìa — màu nền chỉ hiện làm lớp lót khi tải ảnh.</span>
        <button type="button" class="erp-btn erp-btn--sm" data-testid="grad-expand-cover" (click)="expandedWhenCover.set(true)">
          Đổi màu lót
        </button>
      </div>
    } @else {
      <div class="grad-picker">
        <div class="grad-swatches" role="radiogroup" aria-label="Bảng màu gợi ý">
          @for (swatch of swatches; track swatch.id) {
            <button
              type="button"
              class="grad-swatch"
              [class.is-dark]="swatch.dark"
              [class.is-selected]="isSameGradient(swatch.css)"
              [style.background]="swatch.css"
              [attr.data-testid]="'grad-swatch-' + swatch.id"
              (click)="selectSwatch(swatch.css)"
            >
              <span class="grad-swatch__name">{{ swatch.label }}</span>
              @if (isSameGradient(swatch.css)) {
                <span class="grad-swatch__check" aria-hidden="true">✓</span>
              }
            </button>
          }
        </div>

        <div class="grad-custom">
          <div class="grad-stops">
            <label class="grad-stop">
              <span>Màu đầu</span>
              <span class="grad-stop__well">
                <input
                  type="color"
                  data-testid="grad-color-start"
                  [value]="parsed().start"
                  (input)="onStopChange('start', $event)"
                />
                <code>{{ parsed().start }}</code>
              </span>
            </label>
            <label class="grad-stop">
              <span>Màu chuyển</span>
              <span class="grad-stop__well">
                <input
                  type="color"
                  data-testid="grad-color-mid"
                  [value]="parsed().mid"
                  (input)="onStopChange('mid', $event)"
                />
                <code>{{ parsed().mid }}</code>
              </span>
            </label>
            <label class="grad-stop">
              <span>Màu cuối</span>
              <span class="grad-stop__well">
                <input
                  type="color"
                  data-testid="grad-color-end"
                  [value]="parsed().end"
                  (input)="onStopChange('end', $event)"
                />
                <code>{{ parsed().end }}</code>
              </span>
            </label>
          </div>

          <div class="grad-angles" role="group" aria-label="Hướng chuyển màu">
            @for (a of angles; track a.deg) {
              <button
                type="button"
                class="grad-angle"
                [class.is-active]="parsed().angle === a.deg"
                (click)="onAngleChange(a.deg)"
              >
                {{ a.label }}
              </button>
            }
          </div>
        </div>

        <div class="grad-preview" [style.background]="previewCss()">
          <span>Xem trước dải chuyển sắc Hero</span>
          <button type="button" class="grad-adv-btn" data-testid="grad-advanced-toggle" (click)="toggleAdvanced()">
            {{ showRawCss() ? 'Ẩn mã CSS' : 'Tùy chỉnh CSS nâng cao' }}
          </button>
        </div>

        @if (showRawCss()) {
          <input
            class="erp-input grad-raw-input"
            type="text"
            data-testid="grad-raw-input"
            [value]="value()"
            (input)="onRawInput($event)"
            (blur)="blurred.emit()"
            placeholder="linear-gradient(115deg, #D9D7C8 0%, #EEE6D9 48%, #E9D4CE 100%)"
          />
        }
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .grad-collapsed {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        border: 1px solid var(--erp-line);
        border-radius: var(--erp-radius-md);
        background: var(--erp-surface-muted);
      }
      .grad-collapsed__swatch {
        width: 28px;
        height: 28px;
        flex-shrink: 0;
        border-radius: 6px;
        border: 1px solid rgba(15, 23, 42, 0.14);
      }
      .grad-collapsed__text {
        flex: 1;
        min-width: 0;
        font-size: 12px;
        color: var(--erp-muted);
      }
      .grad-picker {
        display: grid;
        gap: 10px;
      }
      .grad-swatches {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
      }
      .grad-swatch {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-height: 38px;
        padding: 0 10px;
        border: 1px solid rgba(15, 23, 42, 0.14);
        border-radius: var(--erp-radius-md);
        color: #1e293b;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease;
      }
      .grad-swatch.is-dark {
        color: #f8fafc;
      }
      .grad-swatch:hover {
        transform: translateY(-1px);
        box-shadow: var(--erp-shadow-sm);
      }
      .grad-swatch.is-selected {
        border: 2px solid var(--erp-accent);
        box-shadow: 0 0 0 2px rgba(190, 24, 93, 0.15);
      }
      .grad-swatch__name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .grad-swatch__check {
        font-size: 12px;
        font-weight: 700;
      }
      .grad-custom {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 12px;
        border: 1px solid var(--erp-line);
        border-radius: var(--erp-radius-md);
        background: var(--erp-surface-muted);
      }
      .grad-stops {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .grad-stop {
        display: grid;
        gap: 4px;
        font-size: 11.5px;
        font-weight: 600;
        color: var(--erp-muted);
      }
      .grad-stop__well {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 32px;
        padding: 0 8px 0 4px;
        border: 1px solid var(--erp-control-border);
        border-radius: var(--erp-radius-sm);
        background: var(--erp-surface);
      }
      .grad-stop__well input[type='color'] {
        width: 22px;
        height: 22px;
        padding: 0;
        border: 0;
        border-radius: 4px;
        background: transparent;
        cursor: pointer;
      }
      .grad-stop__well code {
        font-family: var(--erp-font-mono);
        font-size: 11.5px;
        color: var(--erp-ink);
        text-transform: uppercase;
      }
      .grad-angles {
        display: inline-flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .grad-angle {
        min-height: 30px;
        padding: 0 9px;
        border: 1px solid var(--erp-line-strong);
        border-radius: var(--erp-radius-sm);
        background: var(--erp-surface);
        color: var(--erp-muted);
        font-size: 11.5px;
        font-weight: 600;
        cursor: pointer;
      }
      .grad-angle.is-active {
        border-color: var(--erp-accent);
        background: var(--erp-accent-soft);
        color: var(--erp-accent-strong);
      }
      .grad-preview {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        min-height: 38px;
        padding: 6px 12px;
        border: 1px solid rgba(15, 23, 42, 0.12);
        border-radius: var(--erp-radius-md);
      }
      .grad-preview span {
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.82);
        color: #0f172a;
        font-size: 11px;
        font-weight: 600;
      }
      .grad-adv-btn {
        padding: 3px 9px;
        border: 1px solid rgba(15, 23, 42, 0.18);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.9);
        color: #0f172a;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
      }
      .grad-raw-input {
        font-family: var(--erp-font-mono);
        font-size: 12px;
      }
      @media (max-width: 760px) {
        .grad-swatches {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
    `,
  ],
})
export class AdminErpGradientPicker {
  readonly value = input('linear-gradient(115deg, #D9D7C8 0%, #EEE6D9 48%, #E9D4CE 100%)');
  readonly deemphasized = input(false);
  readonly valueChange = output<string>();
  readonly blurred = output<void>();

  protected readonly swatches = VELURA_GRADIENT_SWATCHES;
  protected readonly angles = ANGLES;
  protected readonly expandedWhenCover = signal(false);
  private readonly rawOpenOverride = signal<boolean | null>(null);

  protected readonly parsed = computed<ParsedGradient>(() => parseGradientCss(this.value()));
  protected readonly previewCss = computed(() =>
    this.value().trim() || 'linear-gradient(115deg, #D9D7C8 0%, #EEE6D9 48%, #E9D4CE 100%)',
  );
  protected readonly showRawCss = computed(() => {
    const manual = this.rawOpenOverride();
    if (manual !== null) return manual;
    return Boolean(this.value().trim()) && !this.parsed().matched;
  });

  protected selectSwatch(css: string): void {
    this.valueChange.emit(css);
  }

  protected onStopChange(stop: 'start' | 'mid' | 'end', event: Event): void {
    const hex = expandHex((event.target as HTMLInputElement).value);
    const current = this.parsed();
    const start = stop === 'start' ? hex : current.start;
    const mid = stop === 'mid' ? hex : current.mid;
    const end = stop === 'end' ? hex : current.end;
    this.valueChange.emit(composeGradientCss(current.angle, start, mid, end));
  }

  protected onAngleChange(angle: number): void {
    const current = this.parsed();
    this.valueChange.emit(composeGradientCss(angle, current.start, current.mid, current.end));
  }

  protected toggleAdvanced(): void {
    this.rawOpenOverride.set(!this.showRawCss());
  }

  protected onRawInput(event: Event): void {
    this.valueChange.emit((event.target as HTMLInputElement).value);
  }

  protected isSameGradient(swatchCss: string): boolean {
    return normalizeWs(this.value()) === normalizeWs(swatchCss);
  }
}

function normalizeWs(css: string): string {
  return css.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Expands 3-digit `#rgb` to 6-digit `#rrggbb` so HTML5 `<input type="color">` never resets to `#000000`. */
export function expandHex(raw: string): string {
  const clean = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(clean)) {
    return `#${clean[1]}${clean[1]}${clean[2]}${clean[2]}${clean[3]}${clean[3]}`;
  }
  if (/^#[0-9a-f]{6}$/.test(clean)) {
    return clean;
  }
  return '#d9d7c8';
}

function mixHex(a: string, b: string): string {
  const pa = Number.parseInt(a.slice(1), 16);
  const pb = Number.parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) + (pb >> 16)) / 2);
  const g = Math.round((((pa >> 8) & 0xff) + ((pb >> 8) & 0xff)) / 2);
  const bl = Math.round(((pa & 0xff) + (pb & 0xff)) / 2);
  return `#${[r, g, bl].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function parseGradientCss(raw: string): ParsedGradient {
  const m = raw.trim().match(SIMPLE_GRADIENT_RE);
  if (!m) {
    return { matched: false, angle: 115, start: '#d9d7c8', mid: '#eee6d9', end: '#e9d4ce' };
  }
  const angle = Number.parseInt(m[1], 10);
  const start = expandHex(m[2]);
  const end = expandHex(m[4]);
  const mid = m[3] ? expandHex(m[3]) : mixHex(start, end);
  return { matched: true, angle: Number.isFinite(angle) ? angle : 115, start, mid, end };
}

function composeGradientCss(angle: number, start: string, mid: string, end: string): string {
  return `linear-gradient(${angle}deg, ${start.toUpperCase()} 0%, ${mid.toUpperCase()} 48%, ${end.toUpperCase()} 100%)`;
}
