import { TestBed } from '@angular/core/testing';
import { AdminErpImageCropper, type AdminMediaFraming } from './admin-image-cropper';

describe('AdminErpImageCropper', () => {
  it('pans focal coordinates on pointer drag, adjusts zoom, and applies framing presets + reset', () => {
    TestBed.configureTestingModule({ imports: [AdminErpImageCropper] });
    const fixture = TestBed.createComponent(AdminErpImageCropper);
    fixture.componentRef.setInput('src', 'https://cdn.velura.vn/midnight-mirage.jpg');
    fixture.componentRef.setInput('posX', 50);
    fixture.componentRef.setInput('posY', 50);
    fixture.componentRef.setInput('zoom', 1);
    fixture.componentRef.setInput('defaultPosY', 16);

    const emitted: AdminMediaFraming[] = [];
    fixture.componentInstance.framingChange.subscribe((f) => emitted.push(f));
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const stage = root.querySelector<HTMLElement>('[data-testid="cropper-stage"]')!;
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
      width: 600,
      height: 200,
      top: 0,
      left: 0,
      right: 600,
      bottom: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    // Dragging downward (clientY: 100 -> 140) pulls the top of the image into view (posY decreases < 50).
    stage.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 0, clientX: 300, clientY: 100 }));
    stage.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 300, clientY: 140 }));
    stage.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 300, clientY: 140 }));

    expect(emitted.length).toBe(1);
    expect(emitted[0].posY).toBeLessThan(50);

    // Zoom step + preset + reset
    fixture.componentInstance.stepZoom(0.25);
    expect(emitted.at(-1)?.zoom).toBe(1.25);

    fixture.componentRef.setInput('zoom', 1.25);
    fixture.detectChanges();
    const img = root.querySelector<HTMLImageElement>('img.cropper__media')!;
    expect(img.style.transform).toBe('scale(1.25)');

    root.querySelector<HTMLButtonElement>('[data-testid="cropper-preset-head"]')?.click();
    expect(emitted.at(-1)).toEqual({ posX: 50, posY: 14, zoom: 1.25 });

    root.querySelector<HTMLButtonElement>('[data-testid="cropper-reset"]')?.click();
    expect(emitted.at(-1)).toEqual({ posX: 50, posY: 16, zoom: 1 });
  });

  it('nudges coordinates via arrow keys without intercepting Escape', () => {
    TestBed.configureTestingModule({ imports: [AdminErpImageCropper] });
    const fixture = TestBed.createComponent(AdminErpImageCropper);
    fixture.componentRef.setInput('src', 'https://cdn.velura.vn/cover.jpg');
    fixture.componentRef.setInput('posX', 50);
    fixture.componentRef.setInput('posY', 20);
    fixture.componentRef.setInput('zoom', 1);

    const emitted: AdminMediaFraming[] = [];
    fixture.componentInstance.framingChange.subscribe((f) => emitted.push(f));
    fixture.detectChanges();

    const stage = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-testid="cropper-stage"]')!;
    stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true }));
    expect(emitted.at(-1)).toEqual({ posX: 50, posY: 18, zoom: 1 });

    const esc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    stage.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(false);
    expect(emitted.length).toBe(1);
  });
});
