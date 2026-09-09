export interface HomeCarouselOptions {
  label: string;
  scrollRatio?: number;
  autoplay?: 'forward' | 'backward';
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
  section.querySelectorAll('.home-carousel__arrow, .home-carousel__progress').forEach((node) => node.remove());

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'home-carousel__arrow home-carousel__arrow--prev';
  prevBtn.setAttribute('aria-label', `Trượt ${options.label} sang trái`);
  prevBtn.innerHTML = '<span aria-hidden="true">‹</span>';

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'home-carousel__arrow home-carousel__arrow--next';
  nextBtn.setAttribute('aria-label', `Trượt ${options.label} sang phải`);
  nextBtn.innerHTML = '<span aria-hidden="true">›</span>';

  const progress = document.createElement('div');
  progress.className = 'home-carousel__progress';
  progress.setAttribute('aria-hidden', 'true');
  progress.innerHTML = '<span class="home-carousel__progress-bar"></span>';
  section.append(prevBtn, nextBtn, progress);

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
    prevBtn.disabled = !hasOverflow || current <= 4;
    nextBtn.disabled = !hasOverflow || current >= maxScroll - 4;
    if (bar) {
      bar.style.width = `${viewportRatio * 100}%`;
      bar.style.transform = `translateX(${travelRatio * maxTranslate}%)`;
    }
  };

  const onPrev = () => track.scrollBy({ left: -scrollStep(), behavior: 'smooth' });
  const onNext = () => track.scrollBy({ left: scrollStep(), behavior: 'smooth' });
  prevBtn.addEventListener('click', onPrev);
  nextBtn.addEventListener('click', onNext);
  track.addEventListener('scroll', updateState, { passive: true });
  window.addEventListener('resize', updateState, { passive: true });
  requestAnimationFrame(updateState);
  window.setTimeout(updateState, 250);

  let autoplay: number | null = null;
  let hovering = false;
  const startAutoplay = () => {
    if (!options.autoplay) {
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
          track.scrollTo({ left: 0, behavior: 'smooth' });
        } else {
          track.scrollBy({ left: step, behavior: 'smooth' });
        }
      } else if (track.scrollLeft <= 16) {
        track.scrollTo({ left: maxScroll, behavior: 'smooth' });
      } else {
        track.scrollBy({ left: -step, behavior: 'smooth' });
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
  section.addEventListener('mouseenter', onEnter);
  section.addEventListener('mouseleave', onLeave);
  startAutoplay();

  return () => {
    stopAutoplay();
    prevBtn.removeEventListener('click', onPrev);
    nextBtn.removeEventListener('click', onNext);
    track.removeEventListener('scroll', updateState);
    window.removeEventListener('resize', updateState);
    section.removeEventListener('mouseenter', onEnter);
    section.removeEventListener('mouseleave', onLeave);
    prevBtn.remove();
    nextBtn.remove();
    progress.remove();
  };
}
