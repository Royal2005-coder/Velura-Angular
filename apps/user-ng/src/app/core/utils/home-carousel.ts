export interface HomeCarouselOptions {
  label: string;
  scrollRatio?: number;
  autoplay?: 'forward' | 'backward';
  hideArrows?: boolean;
}

/**
 * Attaches the original homepage carousel arrows, progress bar, and autoplay.
 */
export function bindHomeCarousel(track: HTMLElement | undefined, options: HomeCarouselOptions): () => void {
  if (!track) {
    return () => undefined;
  }
  const section = track.closest('section');
  if (!section) {
    return () => undefined;
  }

  section.classList.add('home-carousel');
  track.classList.add('home-carousel__track');
  track.setAttribute('tabindex', '0');

  const container = track.parentElement || section;
  container.classList.add('home-carousel__container');
  container.querySelectorAll('.home-carousel__arrow, .home-carousel__progress').forEach((node) => node.remove());
  section.querySelectorAll('.home-carousel__arrow, .home-carousel__progress').forEach((node) => node.remove());

  let prevBtn: HTMLButtonElement | null = null;
  let nextBtn: HTMLButtonElement | null = null;

  if (!options.hideArrows) {
    prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'home-carousel__arrow home-carousel__arrow--prev';
    prevBtn.setAttribute('aria-label', `Trượt ${options.label} sang trái`);
    prevBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>';

    nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'home-carousel__arrow home-carousel__arrow--next';
    nextBtn.setAttribute('aria-label', `Trượt ${options.label} sang phải`);
    nextBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>';

    container.append(prevBtn, nextBtn);
  }

  const progress = document.createElement('div');
  progress.className = 'home-carousel__progress';
  progress.setAttribute('aria-hidden', 'true');
  progress.innerHTML = '<span class="home-carousel__progress-bar"></span>';
  container.append(progress);
  const motionPreference: Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'> =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : {
          matches: false,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        };
  const scrollBehavior = () => motionPreference.matches ? 'auto' as const : 'smooth' as const;

  const scrollStep = () => Math.max(track.clientWidth * (options.scrollRatio || 0.85), 240);

  const updateState = () => {
    const maxScroll = Math.max(track.scrollWidth - track.clientWidth, 0);
    const current = Math.min(Math.max(track.scrollLeft, 0), maxScroll);
    const hasOverflow = maxScroll > 8;
    const bar = progress.querySelector<HTMLElement>('.home-carousel__progress-bar');
    const viewportRatio = hasOverflow ? Math.max(track.clientWidth / track.scrollWidth, 0.18) : 1;
    const travelRatio = hasOverflow ? current / maxScroll : 0;
    const maxTranslate = Math.max((1 / viewportRatio - 1) * 100, 0);
    section.classList.toggle('home-carousel--static', !hasOverflow);
    if (prevBtn) {
      prevBtn.disabled = !hasOverflow || current <= 4;
    }
    if (nextBtn) {
      nextBtn.disabled = !hasOverflow || current >= maxScroll - 4;
    }
    if (bar) {
      bar.style.width = `${viewportRatio * 100}%`;
      bar.style.transform = `translateX(${travelRatio * maxTranslate}%)`;
    }
  };

  const onPrev = () => track.scrollBy({ left: -scrollStep(), behavior: scrollBehavior() });
  const onNext = () => track.scrollBy({ left: scrollStep(), behavior: scrollBehavior() });
  if (prevBtn) {
    prevBtn.addEventListener('click', onPrev);
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', onNext);
  }
  track.addEventListener('scroll', updateState, { passive: true });
  window.addEventListener('resize', updateState, { passive: true });
  requestAnimationFrame(updateState);
  window.setTimeout(updateState, 250);

  let autoplay: number | null = null;
  let hovering = false;
  const startAutoplay = () => {
    if (!options.autoplay || motionPreference.matches) {
      return;
    }
    stopAutoplay();
    autoplay = window.setInterval(() => {
      if (hovering) {
        return;
      }
      const maxScroll = Math.max(track.scrollWidth - track.clientWidth, 0);
      if (maxScroll <= 8) {
        return;
      }
      const step = scrollStep();
      if (options.autoplay === 'forward') {
        if (track.scrollLeft >= maxScroll - 16) {
          track.scrollTo({ left: 0, behavior: scrollBehavior() });
        } else {
          track.scrollBy({ left: step, behavior: scrollBehavior() });
        }
      } else if (track.scrollLeft <= 16) {
        track.scrollTo({ left: maxScroll, behavior: scrollBehavior() });
      } else {
        track.scrollBy({ left: -step, behavior: scrollBehavior() });
      }
    }, 2500);
  };
  const stopAutoplay = () => {
    if (autoplay) {
      window.clearInterval(autoplay);
      autoplay = null;
    }
  };
  const onEnter = () => {
    hovering = true;
  };
  const onLeave = () => {
    hovering = false;
  };
  const onMotionPreferenceChange = () => {
    if (motionPreference.matches) {
      stopAutoplay();
    } else {
      startAutoplay();
    }
  };
  section.addEventListener('mouseenter', onEnter);
  section.addEventListener('mouseleave', onLeave);
  motionPreference.addEventListener('change', onMotionPreferenceChange);
  startAutoplay();

  return () => {
    stopAutoplay();
    if (prevBtn) {
      prevBtn.removeEventListener('click', onPrev);
      prevBtn.remove();
    }
    if (nextBtn) {
      nextBtn.removeEventListener('click', onNext);
      nextBtn.remove();
    }
    track.removeEventListener('scroll', updateState);
    window.removeEventListener('resize', updateState);
    section.removeEventListener('mouseenter', onEnter);
    section.removeEventListener('mouseleave', onLeave);
    motionPreference.removeEventListener('change', onMotionPreferenceChange);
    progress.remove();
  };
}
