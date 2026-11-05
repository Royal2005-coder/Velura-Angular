import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { ApiService, UserIdentity } from '../../core/services/api.service';
import { guestSessionId } from '../../core/utils/guest-session';
import {
  AiCapabilities,
  AiEngineService,
  AiJob,
  AiTask,
  StudioAsset,
} from '../../core/services/ai-engine.service';
export interface VtoScenario {
  id: string;
  label: string;
  icon: string;
  badge: string;
  description: string;
  theme: 'light' | 'dark' | 'warm' | 'cool';
  backgroundGradient: string;
  lightingTone: string;
  vignetteStyle: string;
  podiumStyle: string;
  floorTexture: string;
  wallBackTexture: string;
  wallSideTexture: string;
  ceilingTexture: string;
  spotlightBeam: string;
}

export const VTO_SCENARIOS: VtoScenario[] = [
  {
    id: 'basic',
    label: 'Studio Chuẩn',
    icon: 'studio',
    badge: 'Atelier',
    description: 'Phông nền Trắng ngà Studio Atelier tối giản cao cấp',
    theme: 'light',
    backgroundGradient: 'radial-gradient(circle at 50% 30%, #FFFFFF 0%, #FAF6F0 50%, #ECE4DB 100%)',
    lightingTone: 'rgba(255, 255, 255, 0.4)',
    vignetteStyle: 'radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(122, 40, 60, 0.06) 100%)',
    podiumStyle: 'radial-gradient(ellipse at 50% 50%, rgba(200, 185, 175, 0.45) 0%, rgba(200, 185, 175, 0.15) 50%, transparent 70%)',
    floorTexture: 'linear-gradient(45deg, #E6DDD4 25%, transparent 25%), linear-gradient(-45deg, #E6DDD4 25%, transparent 25%), #F4EDE6',
    wallBackTexture: 'radial-gradient(circle at 50% 45%, #FFFFFF 0%, #FAF6F0 55%, #ECE4DB 100%)',
    wallSideTexture: 'linear-gradient(to right, #ECE4DB, #F5EFE8)',
    ceilingTexture: 'radial-gradient(circle at 50% 50%, #FFFFFF, #E2D9CE)',
    spotlightBeam: 'radial-gradient(ellipse at 50% 0%, rgba(255, 255, 255, 0.45) 0%, transparent 75%)',
  },
  {
    id: 'spring',
    label: 'Mùa Xuân',
    icon: 'flower',
    badge: 'Blossom',
    description: 'Vườn xuân thanh khiết, hoa anh đào & nắng sớm',
    theme: 'warm',
    backgroundGradient: 'radial-gradient(ellipse at 50% 25%, #FFF5F7 0%, #FDE4EB 45%, #F3D2DC 75%, #E5BCC8 100%)',
    lightingTone: 'rgba(255, 215, 225, 0.35)',
    vignetteStyle: 'radial-gradient(ellipse at 50% 45%, transparent 50%, rgba(201, 79, 112, 0.1) 100%)',
    podiumStyle: 'radial-gradient(ellipse at 50% 50%, rgba(220, 170, 185, 0.5) 0%, rgba(220, 170, 185, 0.15) 50%, transparent 70%)',
    floorTexture: 'radial-gradient(circle, #FDE6EC 20%, #F5D3DD 80%)',
    wallBackTexture: 'radial-gradient(ellipse at 50% 40%, #FFF5F7 0%, #FCE2EB 45%, #F0CBD7 80%, #E2B6C5 100%)',
    wallSideTexture: 'linear-gradient(to bottom, #FFF0F4, #F2CBD7)',
    ceilingTexture: 'radial-gradient(circle, #FFF5F8, #EAC3CE)',
    spotlightBeam: 'radial-gradient(ellipse at 50% 0%, rgba(255, 220, 230, 0.4) 0%, transparent 75%)',
  },
  {
    id: 'summer',
    label: 'Mùa Hạ',
    icon: 'sun',
    badge: 'Azure',
    description: 'Ban công ven biển Địa Trung Hải, nắng vàng ấm áp',
    theme: 'warm',
    backgroundGradient: 'radial-gradient(ellipse at 50% 20%, #FFFDF5 0%, #FEF4D8 40%, #E0F2FE 75%, #BAE6FD 100%)',
    lightingTone: 'rgba(254, 240, 138, 0.3)',
    vignetteStyle: 'radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(14, 116, 144, 0.08) 100%)',
    podiumStyle: 'radial-gradient(ellipse at 50% 50%, rgba(180, 205, 220, 0.5) 0%, rgba(180, 205, 220, 0.15) 50%, transparent 70%)',
    floorTexture: 'radial-gradient(circle, #FDF7E7 30%, #E8DFCE 80%)',
    wallBackTexture: 'linear-gradient(to bottom, #BAE6FD 0%, #E0F2FE 45%, #FEF3D6 75%, #FFFDF5 100%)',
    wallSideTexture: 'linear-gradient(to bottom, #93C5FD, #FDE68A)',
    ceilingTexture: 'radial-gradient(circle, #E0F2FE, #93C5FD)',
    spotlightBeam: 'radial-gradient(ellipse at 50% 0%, rgba(254, 240, 138, 0.45) 0%, transparent 75%)',
  },
  {
    id: 'autumn',
    label: 'Mùa Thu',
    icon: 'leaf',
    badge: 'Parisian',
    description: 'Đại lộ Paris mùa thu, lá vàng hổ phách & hoàng hôn ấm',
    theme: 'warm',
    backgroundGradient: 'radial-gradient(ellipse at 50% 28%, #FFF9F2 0%, #FEEAD2 40%, #E8C1A0 75%, #D4A373 100%)',
    lightingTone: 'rgba(245, 158, 11, 0.28)',
    vignetteStyle: 'radial-gradient(ellipse at 50% 45%, transparent 50%, rgba(180, 83, 9, 0.12) 100%)',
    podiumStyle: 'radial-gradient(ellipse at 50% 50%, rgba(200, 160, 130, 0.55) 0%, rgba(200, 160, 130, 0.18) 50%, transparent 70%)',
    floorTexture: 'radial-gradient(circle, #F2E3CE 30%, #D8BE9E 80%)',
    wallBackTexture: 'radial-gradient(ellipse at 50% 40%, #FFF8F0 0%, #FEEAD2 45%, #E8C1A0 75%, #D4A373 100%)',
    wallSideTexture: 'linear-gradient(to bottom, #FEEAD2, #C28B58)',
    ceilingTexture: 'radial-gradient(circle, #FEEBCF, #D29964)',
    spotlightBeam: 'radial-gradient(ellipse at 50% 0%, rgba(245, 158, 11, 0.35) 0%, transparent 75%)',
  },
  {
    id: 'winter',
    label: 'Mùa Đông',
    icon: 'snow',
    badge: 'Crystal',
    description: 'Không gian tiệc mùa đông tuyết trắng, ánh bạc pha lê',
    theme: 'cool',
    backgroundGradient: 'radial-gradient(ellipse at 50% 25%, #F8FAFC 0%, #E2E8F0 50%, #CBD5E1 80%, #94A3B8 100%)',
    lightingTone: 'rgba(148, 163, 184, 0.3)',
    vignetteStyle: 'radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(51, 65, 85, 0.12) 100%)',
    podiumStyle: 'radial-gradient(ellipse at 50% 50%, rgba(148, 163, 184, 0.5) 0%, rgba(148, 163, 184, 0.15) 50%, transparent 70%)',
    floorTexture: 'radial-gradient(circle, #F1F5F9 30%, #CBD5E1 80%)',
    wallBackTexture: 'radial-gradient(ellipse at 50% 40%, #F8FAFC 0%, #E2E8F0 50%, #CBD5E1 80%, #94A3B8 100%)',
    wallSideTexture: 'linear-gradient(to bottom, #F1F5F9, #94A3B8)',
    ceilingTexture: 'radial-gradient(circle, #F8FAFC, #64748B)',
    spotlightBeam: 'radial-gradient(ellipse at 50% 0%, rgba(203, 213, 225, 0.45) 0%, transparent 75%)',
  },
  {
    id: 'work',
    label: 'Công sở',
    icon: 'briefcase',
    badge: 'Executive',
    description: 'Cao ốc kính hiện đại, sảnh lounge sang trọng thanh lịch',
    theme: 'light',
    backgroundGradient: 'radial-gradient(ellipse at 50% 30%, #FFFFFF 0%, #F1F5F9 50%, #E2E8F0 80%, #CBD5E1 100%)',
    lightingTone: 'rgba(255, 255, 255, 0.45)',
    vignetteStyle: 'radial-gradient(ellipse at 50% 45%, transparent 60%, rgba(71, 85, 105, 0.08) 100%)',
    podiumStyle: 'radial-gradient(ellipse at 50% 50%, rgba(160, 175, 190, 0.45) 0%, rgba(160, 175, 190, 0.12) 50%, transparent 70%)',
    floorTexture: 'radial-gradient(circle, #FFFFFF 30%, #E2E8F0 80%)',
    wallBackTexture: 'radial-gradient(ellipse at 50% 40%, #FFFFFF 0%, #F1F5F9 50%, #E2E8F0 80%, #CBD5E1 100%)',
    wallSideTexture: 'linear-gradient(to bottom, #FFFFFF, #CBD5E1)',
    ceilingTexture: 'radial-gradient(circle, #FFFFFF, #94A3B8)',
    spotlightBeam: 'radial-gradient(ellipse at 50% 0%, rgba(255, 255, 255, 0.5) 0%, transparent 75%)',
  },
  {
    id: 'street',
    label: 'Dạo phố',
    icon: 'compass',
    badge: 'Boulevard',
    description: 'Phố thời trang boutique châu Âu, phong cách đương đại',
    theme: 'light',
    backgroundGradient: 'radial-gradient(ellipse at 50% 28%, #FDFBF7 0%, #F4EDE4 45%, #E6DACE 80%, #D8C7B8 100%)',
    lightingTone: 'rgba(240, 230, 220, 0.35)',
    vignetteStyle: 'radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(100, 80, 70, 0.08) 100%)',
    podiumStyle: 'radial-gradient(ellipse at 50% 50%, rgba(185, 170, 160, 0.5) 0%, rgba(185, 170, 160, 0.15) 50%, transparent 70%)',
    floorTexture: 'radial-gradient(circle, #FDFBF7 30%, #D8C7B8 80%)',
    wallBackTexture: 'radial-gradient(ellipse at 50% 40%, #FDFBF7 0%, #F4EDE4 45%, #E6DACE 80%, #D8C7B8 100%)',
    wallSideTexture: 'linear-gradient(to bottom, #FAF5EE, #C8B3A0)',
    ceilingTexture: 'radial-gradient(circle, #FAF5EE, #A8927F)',
    spotlightBeam: 'radial-gradient(ellipse at 50% 0%, rgba(240, 230, 220, 0.4) 0%, transparent 75%)',
  },
  {
    id: 'party',
    label: 'Dạ tiệc',
    icon: 'sparkle',
    badge: 'Gala Night',
    description: 'Dạ hội quý phái lộng lẫy, bokeh champagne & ánh đèn chùm',
    theme: 'dark',
    backgroundGradient: 'radial-gradient(ellipse at 50% 25%, #421827 0%, #2A0816 45%, #18030D 85%, #0D0107 100%)',
    lightingTone: 'rgba(251, 191, 36, 0.22)',
    vignetteStyle: 'radial-gradient(ellipse at 50% 45%, transparent 40%, rgba(0, 0, 0, 0.5) 100%)',
    podiumStyle: 'radial-gradient(ellipse at 50% 50%, rgba(200, 130, 60, 0.35) 0%, rgba(200, 130, 60, 0.1) 50%, transparent 70%)',
    floorTexture: 'radial-gradient(circle, #2A0814 30%, #0F0206 80%)',
    wallBackTexture: 'radial-gradient(ellipse at 50% 35%, #4A1627 0%, #2A0816 45%, #18030D 85%, #0D0107 100%)',
    wallSideTexture: 'linear-gradient(to bottom, #3A1020, #0A0105)',
    ceilingTexture: 'radial-gradient(circle, #3A1020, #000000)',
    spotlightBeam: 'radial-gradient(ellipse at 50% 0%, rgba(251, 191, 36, 0.3) 0%, transparent 75%)',
  },
];

/** Consent-first image workflow with interactive 3D 360 perspective, rich studio scenes, and female-only models. */
@Component({
  selector: 'app-ai-image-workbench',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './ai-image-workbench.html',
  styleUrl: './ai-image-workbench.css',
})
export class AiImageWorkbench {
  readonly titleId = `ai-title-${crypto.randomUUID()}`;
  readonly task = input<AiTask>('virtual_try_on');
  readonly productId = input<string>('');
  readonly variantId = input<string>('');
  readonly hideTrigger = input<boolean>(false);
  /** Published products surviving the catalog's current filters; undefined leaves retrieval unrestricted. */
  readonly candidateProductIds = input<string[] | undefined>();
  readonly matches = output<string[]>();
  private readonly model = inject(AiEngineService);
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly destroy = inject(DestroyRef);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  readonly capabilities = signal<AiCapabilities | null>(null);
  readonly verifiedMember = signal(false);
  private capabilitiesEpoch = 0;
  /**
   * Whether the entry point is shown at all. Virtual try-on is offered only for products the server has
   * verified (flat-lay garment photo, supported category); unsupported items such as accessories get no button.
   * Other tasks are always offered.
   */
  readonly offered = signal(false);
  /** Try-on uses personal photos stored per account, so only signed-in users may use it. */
  readonly memberRequired = computed(
    () => this.task() === 'virtual_try_on' && !this.auth.isLoggedIn(),
  );
  readonly error = signal('');
  readonly consent = signal(false);
  readonly mode = signal<'personal' | 'studio'>('personal');
  readonly studio = signal('');
  readonly studioImage = signal('');
  readonly studioLoading = signal(false);
  private studioGeneration = 0;
  readonly preview = signal('');
  readonly result = signal('');
  /** Studio 3D: blob URLs of the turntable frames, indexed by orbit angle. */
  readonly frames3d = signal<string[]>([]);
  readonly has3d = computed(() => this.frames3d().length >= 12);
  readonly frameSrc = computed(() => {
    const frames = this.frames3d();
    if (!frames.length) return this.result();
    const index = Math.round((((this.orbitAngle() % 360) + 360) % 360) / (360 / frames.length)) % frames.length;
    return frames[index];
  });
  readonly busy = signal(false);
  readonly job = signal<AiJob | null>(null);
  readonly qualityPassed = signal(false);
  readonly qualityWarning = signal<string | null>(null);
  readonly crop = signal({ x: 0, y: 0, width: 100, height: 100 });

  // --- STUDIO PRESETS & FILTERS (LOCKED EXCLUSIVELY TO FEMALE MODELS) ---
  readonly selectedGender = signal<'female'>('female');
  readonly selectedScene = signal<string>('all');
  readonly availableScenarios = VTO_SCENARIOS;

  readonly activeScenario = computed<VtoScenario>(() => {
    const s = this.selectedScene();
    return VTO_SCENARIOS.find((item) => item.id === s) || VTO_SCENARIOS[0];
  });

  readonly filteredStudioAssets = computed(() => {
    const assets: StudioAsset[] = this.capabilities()?.studio_assets || [];
    return assets.filter((asset) => {
      if (asset.gender !== 'female') return false;
      const scene = this.selectedScene();
      if (scene === 'all') return true;
      if (scene === 'basic') return asset.occasion === 'basic';
      if (['spring', 'summer', 'autumn', 'winter'].includes(scene)) return asset.season === scene;
      return asset.occasion === scene;
    });
  });

  switchScene(scene: string): void {
    if (this.busy()) return;
    this.selectedScene.set(scene);
    if (this.mode() === 'studio' && !this.result()) {
      const first = this.filteredStudioAssets()[0];
      if (first) {
        void this.selectStudio(first.id);
      }
    }
  }

  modelDisplayTitle(asset: StudioAsset): string {
    return (
      asset.label
        .replace(/^(Người mẫu\s*)?(Nữ|Nam)\s*[-–]?\s*(Bối cảnh\s*)?/i, '')
        .replace(/\s*\/\s*(Đi làm|Đi học|Đi chơi|Party|Sang trọng)/i, '')
        .trim() || asset.label
    );
  }

  // --- AI RICH LOADING PROGRESS ---
  readonly loadingSeconds = signal<number>(0);
  /** Studio try-on runs the 360° stage after the photo, so the stepper has to admit it exists. */
  readonly expects3d = computed(() => this.task() === 'virtual_try_on' && this.mode() === 'studio');
  readonly loadingStep = computed(() => {
    const s = this.loadingSeconds();
    if (s < 6) return 1;
    if (s < 18) return 2;
    if (s < 34) return 3;
    if (this.expects3d() && s >= 48) return 5;
    return 4;
  });
  readonly loadingMessage = computed(() => {
    const s = this.loadingSeconds();
    if (s < 6) return 'Đang phân tích vóc dáng và đo lường tỷ lệ khung xương...';
    if (s < 18) return 'Khớp mẫu trang phục, đo lường độ rủ và xếp nếp vải...';
    if (s < 34) return 'Mô hình AI Diffusion đang render và hòa phối trang phục lên cơ thể...';
    if (this.expects3d() && s >= 48) return 'Ảnh 2D đã xong. Đang dựng tuần tự 24 góc nhìn 360° trên GPU...';
    return 'Tinh chỉnh ánh sáng, khử răng cưa và hoàn thiện chi tiết trang phục...';
  });
  private loadingTimer: number | undefined;

  // --- REAL 3D 360-DEGREE ORBIT & MULTI-PERSPECTIVE VIEWER ---
  readonly view3D = signal<boolean>(true);
  readonly showOriginal = signal<boolean>(false);
  readonly orbitAngle = signal<number>(0);
  readonly tiltAngle = signal<number>(0);
  readonly zoomLevel = signal<number>(1.0);
  readonly autoSpin = signal<boolean>(false);

  private isDragging3D = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartAngle = 0;
  private dragStartTilt = 0;
  private autoSpinFrame: number | undefined;
  private lastAutoSpinTime = 0;

  readonly normalizedAngle = computed(() => ((this.orbitAngle() % 360) + 360) % 360);

  readonly isBackView = computed(() => {
    const a = this.normalizedAngle();
    return a >= 95 && a <= 265;
  });

  readonly angleDisplayLabel = computed(() => {
    const a = Math.round(((this.orbitAngle() % 360) + 360) % 360);
    if (a <= 25 || a >= 335) return `${a}° · Mặt trước (Chính diện)`;
    if (a > 25 && a < 70) return `${a}° · Góc nghiêng 45° trái`;
    if (a >= 70 && a <= 110) return `${a}° · Cạnh trái (90°)`;
    if (a > 110 && a < 160) return `${a}° · Nghiêng sau trái (135°)`;
    if (a >= 160 && a <= 200) return `${a}° · Mặt sau (180°)`;
    if (a > 200 && a < 250) return `${a}° · Nghiêng sau phải (225°)`;
    if (a >= 250 && a <= 290) return `${a}° · Cạnh phải (270°)`;
    return `${a}° · Góc nghiêng 45° phải`;
  });

  readonly currentDisplayImage = computed(() => {
    if (this.showOriginal()) return this.mode() === 'personal' ? this.preview() : this.studioImage();
    // Real turntable frames replace the single render whenever the 3D stage produced them.
    return this.has3d() ? this.frameSrc() : this.result();
  });

  readonly roomTransform3D = computed(() => {
    const a = this.orbitAngle();
    const t = this.tiltAngle();
    const z = this.zoomLevel();
    return `scale3d(${z.toFixed(2)}, ${z.toFixed(2)}, ${z.toFixed(2)}) rotateX(${t.toFixed(1)}deg) rotateY(${(-a.toFixed(1))}deg)`;
  });

  readonly modelTransform3D = computed(() => {
    const a = this.orbitAngle();
    const t = this.tiltAngle();
    const z = this.zoomLevel();
    return `rotateX(${t.toFixed(1)}deg) rotateY(${a.toFixed(1)}deg) scale3d(${z.toFixed(2)}, ${z.toFixed(2)}, ${z.toFixed(2)})`;
  });

  readonly panoramaParallax = computed(() => {
    const a = ((this.orbitAngle() % 360) + 360) % 360;
    const px = (a / 360) * 120 - 60;
    return `translateX(${px.toFixed(1)}px)`;
  });

  readonly podiumTransform3D = computed(() => {
    const t = this.tiltAngle();
    return `rotateX(${65 + t * 0.4}deg) translateZ(-40px)`;
  });

  readonly glareStyle = computed(() => {
    const a = ((this.orbitAngle() % 360) + 360) % 360;
    const rad = (a * Math.PI) / 180;
    const x = 50 + Math.sin(rad) * 35;
    const y = 35 - Math.cos(rad) * 15;
    return `radial-gradient(circle at ${x.toFixed(1)}% ${y.toFixed(1)}%, rgba(255,255,255,0.3) 0%, transparent 60%)`;
  });

  onStagePointerDown(event: PointerEvent): void {
    if (!this.view3D() || this.busy()) return;
    this.isDragging3D = true;
    this.stopAutoSpin();
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    this.dragStartAngle = this.orbitAngle();
    this.dragStartTilt = this.tiltAngle();
    (event.currentTarget as HTMLElement)?.setPointerCapture?.(event.pointerId);
  }

  onStagePointerMove(event: PointerEvent): void {
    if (!this.isDragging3D || !this.view3D()) return;
    const deltaX = event.clientX - this.dragStartX;
    const deltaY = event.clientY - this.dragStartY;
    const newAngle = ((this.dragStartAngle - deltaX * 0.65) % 360 + 360) % 360;
    const newTilt = Math.max(-20, Math.min(20, this.dragStartTilt + deltaY * 0.25));
    this.orbitAngle.set(newAngle);
    this.tiltAngle.set(newTilt);
  }

  onStagePointerUp(event: PointerEvent): void {
    if (!this.isDragging3D) return;
    this.isDragging3D = false;
    try {
      (event.currentTarget as HTMLElement)?.releasePointerCapture?.(event.pointerId);
    } catch {}
  }

  setAnglePreset(angle: number): void {
    this.stopAutoSpin();
    this.orbitAngle.set((angle % 360 + 360) % 360);
    this.tiltAngle.set(0);
  }

  setTiltPreset(tilt: number): void {
    this.stopAutoSpin();
    this.tiltAngle.set(Math.max(-20, Math.min(20, tilt)));
  }

  toggleAutoSpin(): void {
    if (this.autoSpin()) {
      this.stopAutoSpin();
    } else {
      this.startAutoSpin();
    }
  }

  private startAutoSpin(): void {
    this.stopAutoSpin();
    this.autoSpin.set(true);
    this.lastAutoSpinTime = performance.now();
    const step = (now: number) => {
      if (!this.autoSpin()) return;
      const dt = Math.min(100, Math.max(1, now - this.lastAutoSpinTime));
      this.lastAutoSpinTime = now;
      const deltaDeg = dt * 0.036;
      this.orbitAngle.update((a) => (a + deltaDeg) % 360);
      this.autoSpinFrame = requestAnimationFrame(step);
    };
    this.autoSpinFrame = requestAnimationFrame(step);
  }

  stopAutoSpin(): void {
    this.autoSpin.set(false);
    if (this.autoSpinFrame) {
      cancelAnimationFrame(this.autoSpinFrame);
      this.autoSpinFrame = undefined;
    }
  }

  zoomIn(): void {
    this.zoomLevel.update((z) => Math.min(1.8, +(z + 0.2).toFixed(1)));
  }

  zoomOut(): void {
    this.zoomLevel.update((z) => Math.max(1.0, +(z - 0.2).toFixed(1)));
  }

  reset3DView(): void {
    this.stopAutoSpin();
    this.orbitAngle.set(0);
    this.tiltAngle.set(0);
    this.zoomLevel.set(1.0);
  }

  toggleView3D(): void {
    this.view3D.update((v) => !v);
    if (!this.view3D()) {
      this.stopAutoSpin();
    }
  }

  toggleShowOriginal(): void {
    this.showOriginal.update((v) => !v);
  }
  downloadResult(): void {
    const res = this.result();
    if (!res) return;
    const a = document.createElement('a');
    a.href = res;
    a.download = `velura-virtual-tryon-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /** Selects the desired garment region as percentages of the original image. */
  setCrop(event: Event, field: 'x' | 'y' | 'width' | 'height'): void {
    this.crop.update((current) => ({
      ...current,
      [field]: Number((event.target as HTMLInputElement).value),
    }));
  }

  /** Applies a local crop and requires consent again for the final selected image. */
  async applyCrop(): Promise<void> {
    if (!this.file || this.busy()) return;
    try {
      const cropped = await this.model.crop(this.file, this.crop());
      this.select({ target: { files: [cropped], value: '' } } as unknown as Event);
      this.crop.set({ x: 0, y: 0, width: 100, height: 100 });
    } catch {
      this.error.set('Vùng chọn chưa hợp lệ. Kiểm tra vị trí và kích thước vùng ảnh.');
    }
  }

  /** Quality validation for tests or explicit quality gate checks. */
  async validate(): Promise<void> {
    await this.start('image_quality');
  }
  /** Availability requires enabled task and, for virtual try-on, supported product and exact variant. */
   readonly available = computed(
     () =>
      this.capabilities()?.enabled === true &&
      this.capabilities()?.tasks.some((t) => t.task === this.task() && t.enabled === true) === true &&
       (this.task() !== 'virtual_try_on' ||
        (this.capabilities()?.product_supported === true && this.capabilities()?.variant_supported === true)),
   );

  readonly title = computed(() =>
    this.task() === 'image_embedding' ? 'Tìm sản phẩm bằng ảnh' : 'Phòng thử đồ thông minh AI 3D',
  );

  /** Consent belongs to the selected photo and is never enabled by default. */
  setConsent(event: Event): void {
    if (this.mode() === 'studio' && (!this.studioImage() || this.studioLoading())) return;
    this.consent.set((event.target as HTMLInputElement).checked);
  }
  /** Studio selection must be an explicit choice from server assets. */
  async selectStudio(idOrEvent: string | Event): Promise<void> {
    const id = typeof idOrEvent === 'string' ? idOrEvent : (((idOrEvent as Event).target as HTMLSelectElement | null)?.value || '');
    const epoch = ++this.studioGeneration;
    this.release(this.studioImage());
    this.studioImage.set('');
    this.studio.set(id);
    this.consent.set(false);
    this.studioLoading.set(false);
    this.release(this.result());
    this.result.set('');
    this.job.set(null);
    if (!id || !this.capabilities()?.studio_assets?.some((asset) => asset.id === id)) return;
    this.studioLoading.set(true);
    this.error.set('');
    try {
      const blob = await firstValueFrom(this.model.studioPreview(id));
      if (epoch !== this.studioGeneration) return;
      this.studioImage.set(URL.createObjectURL(blob));
    } catch {
      if (epoch === this.studioGeneration)
        this.error.set('Chưa tải được ảnh người mẫu. Chọn lại hoặc thử sau.');
    } finally {
      if (epoch === this.studioGeneration) this.studioLoading.set(false);
    }
  }

  /** Changing input mode requires clean state; personal identity is never merged with a studio model. */
  chooseMode(mode: 'personal' | 'studio'): void {
    if (this.busy()) return;
    this.mode.set(mode);
    this.release(this.result());
    this.result.set('');
    this.job.set(null);
    this.qualityWarning.set(null);
    if (mode === 'studio' && !this.studio() && this.filteredStudioAssets().length) {
      void this.selectStudio(this.filteredStudioAssets()[0].id);
    }
  }

  /** An unreadable image is not accepted as a completed preview. */
  studioPreviewFailed(): void {
    this.release(this.studioImage());
    this.studioImage.set('');
    this.consent.set(false);
    this.error.set('Ảnh người mẫu chưa hiển thị được. Vui lòng chọn lại.');
  }

  private clearStudio(): void {
    this.studioGeneration++;
    this.release(this.studioImage());
    this.studioImage.set('');
    this.studio.set('');
    this.studioLoading.set(false);
  }

  /** Displays job lifecycle without claiming a failed gate succeeded. */
  statusLabel(job: AiJob): string {
    if (job.status === 'queued') return 'Đang xếp hàng tính toán trên GPU';
    if (job.status === 'running') return 'AI đang phối đồ và render theo góc chụp...';
    if (job.status === 'success')
      return job.task === 'image_quality'
        ? job.gate?.valid === true
          ? 'Ảnh đạt tiêu chuẩn thử đồ.'
          : 'Ảnh có lưu ý nhỏ nhưng vẫn có thể tiếp tục thử đồ.'
        : 'Thử đồ thành công! Xem góc nhìn 3D bên dưới.';
    if (job.status === 'validation_failed')
      return 'Ảnh chưa nhận diện được dáng người. Bạn nên chọn Người mẫu Studio bên dưới.';
    return job.status === 'cancelled' ? 'Đã hủy' : 'Chưa xử lý được ảnh. Vui lòng thử lại.';
  }

  /** Converts measured gate codes to actionable guidance without blocking users. */
  reasonLabel(reason: string): string {
    const labels: Record<string, string> = {
      LOW_RESOLUTION: 'Ảnh độ phân giải hơi thấp. Bạn nên chọn ảnh sắc nét hơn để xem rõ chất vải.',
      TOO_DARK: 'Ảnh thiếu sáng. Thử chụp lại ở nơi có ánh sáng rõ hơn.',
      OVEREXPOSED: 'Ảnh có độ sáng cao. Bạn nên giảm nguồn sáng chói.',
      BLURRY: 'Ảnh hơi mờ. Giữ điện thoại cố định khi chụp.',
      PERSON_NOT_DETECTED: 'Không nhận diện được người. Vui lòng chụp rõ phần thân hoặc chọn Người mẫu Studio.',
      POSE_CHECK_UNAVAILABLE: 'Dáng người chưa rõ. Bạn có thể chọn Người mẫu Studio bên dưới.',
      BODY_NOT_VISIBLE: 'Chưa thấy rõ cơ thể. Chọn ảnh đứng rõ phần thân người.',
      BODY_CROPPED_OR_OCCLUDED: 'Vùng cơ thể cần mặc đồ bị che. Chọn ảnh chụp rộng hơn một chút.',
      MULTIPLE_PEOPLE: 'Ảnh có nhiều người. Hãy chọn ảnh một người để AI nhận dạng đúng.',
      POSE_NOT_FRONTAL: 'Gợi ý: Đứng hướng chính diện sẽ cho form dáng trang phục chuẩn xác nhất.',
      BACKGROUND_TOO_COMPLEX: 'Nền ảnh có cảnh vật thực tế - AI sẽ tự động phân tách trang phục và bảo toàn cảnh quan xung quanh.',
      BACKGROUND_NOT_VISIBLE: 'Người hơi sát mép ảnh. AI vẫn sẽ thử đồ nhưng chụp rộng hơn sẽ đẹp hơn.',
      BACKGROUND_CHECK_UNAVAILABLE: 'Chưa phân tích được nền ảnh. Tiếp tục thử đồ bình thường.',
    };
    return labels[reason] || 'Gợi ý: Chọn ảnh rõ nét và thẳng người để trang phục lên form đẹp nhất.';
  }

  private file: File | null = null;
  private asset = '';
  private generation = 0;
  private pendingKey = '';
  private pendingFingerprint = '';
  private timer: number | undefined;

   constructor() {
     effect(() => {
      const session = this.auth.session();
       untracked(() => {
         this.generation++;
        this.verifiedMember.set(false);
        if (session?.userId && session?.role === 'member') {
          void this.verifyMemberIdentity();
        }
         this.clearTimer();
         this.stopLoadingTimer();
         this.stopAutoSpin();
         this.release(this.result());
         this.preview.set('');
         this.result.set('');
         this.job.set(null);
         this.busy.set(false);
         this.consent.set(false);
         this.qualityPassed.set(false);
         this.qualityWarning.set(null);
         this.file = null;
         this.asset = '';
         this.pendingKey = '';
         this.clearStudio();
       });
     });
     effect(() => {
       const task = this.task();
       const productId = this.productId();
      const variantId = this.variantId();
       untracked(() => {
         if (task !== 'virtual_try_on') {
           this.offered.set(true);
           return;
         }
         this.offered.set(false);
        if (!productId || !variantId) return;
        const epoch = ++this.capabilitiesEpoch;
        void firstValueFrom(this.model.capabilities(productId, variantId))
           .then((caps) => {
            if (epoch === this.capabilitiesEpoch && productId === this.productId() && variantId === this.variantId()) {
              this.offered.set(caps.product_supported === true && caps.variant_supported === true);
            }
           })
           .catch(() => {
            if (epoch === this.capabilitiesEpoch) this.offered.set(false);
           });
       });
     });
     effect(() => {
       this.productId();
       this.variantId();
       untracked(() => {
         this.capabilities.set(null);
         this.clearTimer();
         this.stopLoadingTimer();
         this.stopAutoSpin();
         this.result.set('');
         this.job.set(null);
         this.busy.set(false);
         this.clearStudio();
         this.pendingKey = '';
         this.pendingFingerprint = '';
         if (this.dialog()?.nativeElement.open) void this.open();
       });
     });
    this.destroy.onDestroy(() => {
      this.generation++;
      this.clearTimer();
      this.stopLoadingTimer();
      this.stopAutoSpin();
      this.release(this.preview());
      this.release(this.result());
      this.clearStudio();
    });
  }

  /** Opens a keyboard-accessible modal and reads readiness before uploading anything. */
  async open(): Promise<void> {
    this.auth.refresh();
    if (this.memberRequired()) {
      this.openGateModal();
      return;
    }
     const dialog = this.dialog()?.nativeElement;
     if (dialog && !dialog.open) dialog.showModal?.();
     const epoch = this.generation;
     this.capabilities.set(null);
     this.error.set('');
     try {
       const capabilities = await firstValueFrom(
         this.model.capabilities(
           this.task() === 'virtual_try_on' ? this.productId() : undefined,
           this.task() === 'virtual_try_on' ? this.variantId() : undefined,
         ),
       );
       if (epoch === this.generation) {
         this.capabilities.set(capabilities);
        if (this.mode() === 'studio' && !this.studio() && this.filteredStudioAssets().length) {
          void this.selectStudio(this.filteredStudioAssets()[0].id);
        }
        const savedId = sessionStorage.getItem(this.storageKey());
          const savedPending = sessionStorage.getItem(`${this.storageKey()}_pending`);
          if (savedId || savedPending) {
            try {
              const recovered = await firstValueFrom(savedId ? this.model.job(savedId) : this.model.recover(savedPending!));
              const job = recovered.job;
              const sameSelection = this.task() !== 'virtual_try_on' ||
                ((!job.product_id || job.product_id === this.productId()) &&
                  (!job.variant_id || !this.variantId() || job.variant_id === this.variantId()));
              if (epoch === this.generation && sameSelection) {
                this.job.set(job);
                if (job.status === 'queued' || job.status === 'running') {
                  this.busy.set(true);
                  this.startLoadingTimer();
                }
                await this.poll(epoch);
              }
            } catch {
              sessionStorage.removeItem(this.storageKey());
              sessionStorage.removeItem(`${this.storageKey()}_pending`);
            }
          }
        }
      } catch {
      if (epoch === this.generation)
        this.error.set('Chưa kết nối được dịch vụ AI. Vui lòng thử lại sau.');
    }
  }

  /** Native close restores focus to the opener. Work stays resumable within the owner session. */
  close(): void {
    this.stopLoadingTimer();
    this.stopAutoSpin();
    this.dialog()?.nativeElement.close?.();
  }

  /** Validates local file envelope; smart validation accepts personal photos without blocking. */
  async select(event: Event): Promise<void> {
    const el = event.target as HTMLInputElement;
     const file = el.files?.[0];
     el.value = '';
     if (!file || this.busy()) return;
    if (this.task() === 'virtual_try_on') {
      const isMember = await this.verifyMemberIdentity();
      if (!isMember) {
        this.openGateModal();
        return;
      }
    }
     const max = this.capabilities()?.max_upload_bytes || 8 * 1024 * 1024;
     if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > max) {
       this.error.set('Chọn ảnh JPG, PNG hoặc WebP dưới 8MB.');
       return;
     }
    this.release(this.preview());
    this.release(this.result());
    this.preview.set(URL.createObjectURL(file));
    this.result.set('');
    this.file = file;
    this.asset = '';
    this.pendingKey = '';
    this.pendingFingerprint = '';
    this.job.set(null);
    this.qualityPassed.set(false);
    this.qualityWarning.set(null);
    this.consent.set(false);
    this.error.set('');
  }

  /** Requires explicit confirmation to generate try-on. */
   /** Fetch turntable frames as blob URLs; a missing 3D stage simply leaves them empty. */
  private async load3dArtifacts(job: AiJob): Promise<void> {
    this.frames3d().forEach((url) => URL.revokeObjectURL(url));
    this.frames3d.set([]);
    const names = (job.frames3d ?? []).map((path) => path.split('/').pop() ?? '');
    if (!names.length) return;
    const epoch = this.generation;
    try {
      const blobs = await Promise.all(
        names.map((name) => firstValueFrom(this.model.resultFile(job.id, name))),
      );
      if (epoch !== this.generation) {
        blobs.forEach((b) => URL.revokeObjectURL(URL.createObjectURL(b)));
        return;
      }
      this.frames3d.set(blobs.map((b) => URL.createObjectURL(b)));
    } catch {
      // The 2D result stays valid; the viewer falls back to the tilt presentation.
    }
  }

   async generate(): Promise<void> {
    if (this.task() === 'virtual_try_on') {
      const isMember = await this.verifyMemberIdentity();
      if (!isMember) {
        this.openGateModal();
        return;
      }
    }
     if (
       this.task() === 'virtual_try_on' &&
      (!this.productId() || !this.variantId() || !this.available())
     ) {
       this.error.set('Chọn màu và cỡ sản phẩm trước khi thử đồ.');
       return;
     }
    if (this.task() === 'virtual_try_on' && this.mode() === 'personal' && !this.qualityPassed())
      return;
    if (this.mode() === 'studio' && (!this.studio() || !this.studioImage() || this.studioLoading()))
      return;
    if (this.mode() === 'personal' && !this.preview()) return;
    await this.start(this.task());
  }

  /** Cancels the authoritative server job; late poll responses cannot change the UI. */
  async cancel(): Promise<void> {
    const id = this.job()?.id;
    this.generation++;
    this.clearTimer();
    this.stopLoadingTimer();
    this.busy.set(true);
    if (id) {
      const epoch = this.generation;
      try {
        await firstValueFrom(this.model.cancel(id));
        const response = await firstValueFrom(this.model.job(id));
        if (epoch !== this.generation) return;
        this.job.set(response.job);
        await this.poll(epoch);
      } catch {
        if (epoch === this.generation) {
          this.busy.set(false);
          this.error.set('Chưa xác nhận được thao tác hủy. Thử lại sau.');
        }
      }
    } else {
      this.busy.set(false);
    }
  }

  private startLoadingTimer(): void {
    this.stopLoadingTimer();
    this.loadingSeconds.set(0);
    this.loadingTimer = window.setInterval(() => {
      this.loadingSeconds.update((s) => s + 1);
    }, 1000);
  }

  private stopLoadingTimer(): void {
    window.clearInterval(this.loadingTimer);
    this.loadingTimer = undefined;
  }
  private async start(task: AiTask): Promise<void> {
    if (this.busy() || !this.consent() || !this.available()) return;
    if (this.mode() === 'personal' && !this.file) return;
    if (this.task() === 'virtual_try_on') {
      const isMember = await this.verifyMemberIdentity();
      if (!isMember) {
        this.openGateModal();
        return;
      }
    }
    const epoch = ++this.generation;
    this.busy.set(true);
    this.error.set('');
    this.startLoadingTimer();
    try {
      if (this.mode() === 'personal' && this.file && !this.asset) {
        const uploaded = await firstValueFrom(this.model.upload(this.file));
        if (epoch !== this.generation) return;
        this.asset = uploaded.asset_id;
      }
      const body = {
        task,
        filters: task === 'image_embedding' && this.candidateProductIds() !== undefined
          ? { product_ids: this.candidateProductIds()! } : undefined,
        person_check: task === 'image_quality' && this.task() === 'virtual_try_on',
        image_asset_id: this.mode() === 'personal' ? this.asset || undefined : undefined,
        person_asset_id: this.mode() === 'personal' ? this.asset || undefined : undefined,
        product_id: this.productId() || undefined,
        variant_id: this.variantId() || undefined,
        mode: this.mode(),
        studio_asset_id: this.mode() === 'studio' ? this.studio() : undefined,
        render3d: this.mode() === 'studio',
        consent: true as const,
        confirmed: true as const,
        idempotency_key: '',
      };
      const fingerprint = JSON.stringify(body);
      if (!this.pendingKey || this.pendingFingerprint !== fingerprint) {
        this.pendingKey = crypto.randomUUID();
        this.pendingFingerprint = fingerprint;
      }
      body.idempotency_key = this.pendingKey;
      sessionStorage.setItem(`${this.storageKey()}_pending`, this.pendingKey);
      const response = await firstValueFrom(this.model.create(body));
      if (epoch !== this.generation) return;
      this.job.set(response.job);
      this.remember(response.job.id);
      await this.poll(epoch);
    } catch (err: unknown) {
      if (epoch === this.generation) {
        this.busy.set(false);
        this.stopLoadingTimer();
        let message = 'Yêu cầu AI chưa hoàn tất. Ảnh gốc vẫn được giữ nguyên.';
        if (err instanceof Error && err.message) {
          message = err.message;
        }
        this.error.set(message);
      }
    }
  }

  private async poll(epoch: number): Promise<void> {
    const current = this.job();
    if (!current || epoch !== this.generation) return;
    if (current.status === 'queued' || current.status === 'running') {
      if (!Number.isFinite(Date.parse(current.expires_at)) || Date.parse(current.expires_at) <= Date.now()) {
        this.busy.set(false);
        this.stopLoadingTimer();
        this.error.set('Tác vụ đã vượt thời gian lưu tạm. Vui lòng thử lại.');
        return;
      }
      this.timer = window.setTimeout(async () => {
        try {
          const response = await firstValueFrom(this.model.job(current.id));
          if (epoch !== this.generation) return;
          this.job.set(response.job);
          await this.poll(epoch);
        } catch {
          if (epoch === this.generation) {
            this.busy.set(false);
            this.stopLoadingTimer();
            this.error.set('Mất kết nối máy chủ AI. Đang kiểm tra lại...');
          }
        }
      }, 1500);
      return;
    }
    this.busy.set(false);
    this.stopLoadingTimer();
    if (
      current.status === 'failed' ||
      current.status === 'cancelled' ||
      current.status === 'validation_failed'
    )
      this.pendingKey = '';
    if (current.status === 'failed' || current.status === 'validation_failed') {
      this.error.set(this.statusLabel(current));
    }
    if (current.status !== 'success') return;
    if (current.task === 'image_quality') {
      this.qualityPassed.set(current.gate?.valid === true);
      if (current.gate?.reasons?.includes('BACKGROUND_TOO_COMPLEX')) {
        this.qualityWarning.set('Nền ảnh có cảnh vật thực tế - AI sẽ tự động phân tách trang phục và bảo toàn không gian xung quanh.');
      }
      return;
    }
    if (current.task === 'image_embedding') {
      this.matches.emit((current.matches || []).map((match) => match.product_id));
      return;
    }
    if (
      current.task === 'virtual_try_on' &&
      ((current.product_id && current.product_id !== this.productId()) ||
        (current.variant_id && this.variantId() && current.variant_id !== this.variantId()))
    ) {
      return;
    }
    try {
      const blob = await firstValueFrom(this.model.result(current.id));
      if (epoch !== this.generation) return;
      this.release(this.result());
      this.result.set(URL.createObjectURL(blob));
      this.showOriginal.set(false);
      await this.load3dArtifacts(current);
    } catch {
      if (epoch !== this.generation) return;
      this.release(this.result());
      this.result.set('');
      this.error.set('Không thể tải kết quả thử đồ hoặc sản phẩm không còn khả dụng. Vui lòng thử lại.');
    }
  }

  private storageKey(): string {
    return `velura_ai_job_${this.auth.session()?.userId || guestSessionId()}_${this.task()}_${this.productId()}_${this.variantId()}`;
  }

  private remember(id: string): void {
    sessionStorage.setItem(this.storageKey(), id);
  }

  private clearTimer(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
  }

   private release(url: string): void {
     if (url.startsWith('blob:')) URL.revokeObjectURL(url);
   }

  /** Opens the guest signin/signup modal without mounting any file input or photo workbench. */
  private openGateModal(): void {
    const gate = this.dialog()?.nativeElement;
    if (gate && !gate.open) gate.showModal?.();
  }

  /** Verifies an active authenticated identity against the authoritative server endpoint before personal data entry. */
  async verifyMemberIdentity(): Promise<boolean> {
    if (!this.auth.isLoggedIn()) {
      this.verifiedMember.set(false);
      return false;
    }
    try {
      const identity = await firstValueFrom(this.api.me());
      const valid = Boolean(
        identity?.user?.id &&
        identity?.profile?.user_id &&
        identity.user.id === identity.profile.user_id &&
        identity.profile.is_active === true,
      );
      this.verifiedMember.set(valid);
      return valid;
    } catch {
      // The AI API re-checks the live identity and active state on every request.
      // Keep a live session usable when /me is transiently unavailable.
      const hasSession = this.auth.isLoggedIn();
      this.verifiedMember.set(hasSession);
      return hasSession;
    }
  }
}
