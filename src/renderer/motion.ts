const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const RIPPLE_TARGETS = '.btn, .about-link, .settings-tabs button';
const SPOTLIGHT_TARGETS = '.quick-control-item, .about-link';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function playRipple(event: PointerEvent): void {
  if (reducedMotion.matches || event.button !== 0) return;
  const target = (event.target as HTMLElement).closest<HTMLElement>(RIPPLE_TARGETS);
  if (!target || target.matches(':disabled')) return;

  const rect = target.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const radius = Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y));

  // Обрезает волну своя обёртка: overflow на самой кнопке срезал бы её тень и свечение
  const host = document.createElement('span');
  host.className = 'ripple-host';
  host.setAttribute('aria-hidden', 'true');
  const wave = document.createElement('span');
  wave.className = 'ripple-wave';
  wave.style.cssText = `left:${x - radius}px;top:${y - radius}px;width:${radius * 2}px;height:${radius * 2}px`;
  host.append(wave);
  if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
  target.append(host);

  wave
    .animate(
      [
        { transform: 'scale(0)', opacity: 0.22 },
        { transform: 'scale(1)', opacity: 0 },
      ],
      { duration: 620, easing: EASE }
    )
    .finished.catch(() => undefined)
    .finally(() => host.remove());
}

let spotlightFrame = 0;

function moveSpotlight(event: PointerEvent): void {
  if (spotlightFrame || event.pointerType === 'touch') return;
  const { clientX, clientY } = event;
  const target = (event.target as HTMLElement).closest<HTMLElement>(SPOTLIGHT_TARGETS);
  if (!target) return;
  spotlightFrame = requestAnimationFrame(() => {
    spotlightFrame = 0;
    const rect = target.getBoundingClientRect();
    target.style.setProperty('--spot-x', `${clientX - rect.left}px`);
    target.style.setProperty('--spot-y', `${clientY - rect.top}px`);
  });
}

const detailsAnimations = new WeakMap<HTMLDetailsElement, Animation>();
const closingDetails = new WeakSet<HTMLDetailsElement>();

function closedDetailsHeight(details: HTMLDetailsElement, summary: HTMLElement): number {
  const style = getComputedStyle(details);
  const frame = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'] as const;
  return summary.getBoundingClientRect().height + frame.reduce((sum, key) => sum + parseFloat(style[key]), 0);
}

function animateDetails(details: HTMLDetailsElement, summary: HTMLElement): void {
  const opening = !details.open || closingDetails.has(details);
  const from = details.getBoundingClientRect().height;
  detailsAnimations.get(details)?.cancel();
  closingDetails.delete(details);

  details.open = true;
  const to = opening ? details.getBoundingClientRect().height : closedDetailsHeight(details, summary);
  if (!opening) closingDetails.add(details);

  details.style.overflow = 'hidden';
  details.style.boxSizing = 'border-box';
  const animation = details.animate([{ height: `${from}px` }, { height: `${to}px` }], {
    duration: Math.min(420, 220 + Math.abs(to - from) * 0.5),
    easing: EASE,
  });
  detailsAnimations.set(details, animation);
  animation.onfinish = () => {
    if (closingDetails.delete(details)) details.open = false;
    details.style.overflow = '';
    details.style.boxSizing = '';
    detailsAnimations.delete(details);
  };
}

function onDetailsClick(event: MouseEvent): void {
  const clicked = event.target as HTMLElement;
  const summary = clicked.closest<HTMLElement>('summary');
  const details = summary?.parentElement;
  if (!summary || !(details instanceof HTMLDetailsElement)) return;
  if (event.defaultPrevented || reducedMotion.matches) return;
  if (clicked.closest('a, button, input, select, textarea')) return;
  event.preventDefault();
  animateDetails(details, summary);
}

/** Плашка переезжает к выбранной вкладке настроек; на скрытой странице размеров нет */
export function moveTabPill(): void {
  const tabs = document.querySelector<HTMLElement>('.settings-tabs');
  const current = tabs?.querySelector<HTMLElement>('button.is-current');
  if (!tabs || !current || current.offsetWidth === 0) return;

  let pill = tabs.querySelector<HTMLElement>('.settings-tab-pill');
  if (!pill) {
    pill = document.createElement('span');
    pill.className = 'settings-tab-pill';
    pill.setAttribute('aria-hidden', 'true');
    tabs.append(pill);
  }
  pill.style.transform = `translate(${current.offsetLeft}px, ${current.offsetTop}px)`;
  pill.style.width = `${current.offsetWidth}px`;
  pill.style.height = `${current.offsetHeight}px`;
  // Первое появление — без переезда из угла
  requestAnimationFrame(() => pill?.classList.add('is-placed'));
}

/** Круг расходится от кнопки, когда обход запустился */
export function playPowerWave(stack: HTMLElement | null): void {
  if (!stack || reducedMotion.matches) return;
  const wave = document.createElement('span');
  wave.className = 'power-wave';
  wave.setAttribute('aria-hidden', 'true');
  stack.append(wave);
  wave
    .animate(
      [
        { transform: 'scale(0.75)', opacity: 0.7 },
        { transform: 'scale(2)', opacity: 0 },
      ],
      { duration: 1100, easing: EASE }
    )
    .finished.catch(() => undefined)
    .finally(() => wave.remove());
}

export function initMotion(): void {
  document.addEventListener('pointerdown', playRipple);
  document.addEventListener('pointermove', moveSpotlight, { passive: true });
  document.addEventListener('click', onDetailsClick);
  window.addEventListener('resize', moveTabPill);
}
