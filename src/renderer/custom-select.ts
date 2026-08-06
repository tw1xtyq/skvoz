export interface CustomSelectHandle {
  rebuild(): void;
  setDisabled(disabled: boolean): void;
  close(): void;
}

let openSelect: { close: () => void } | null = null;

function closeOpenSelect(): void {
  openSelect?.close();
  openSelect = null;
}

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (!target.closest('.custom-select') && !target.closest('.custom-select-menu')) {
    closeOpenSelect();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeOpenSelect();
});

export function enhanceSelect(select: HTMLSelectElement): CustomSelectHandle {
  if (select.dataset.enhanced === 'true') {
    return {
      rebuild: () => select.dispatchEvent(new CustomEvent('custom-select-rebuild')),
      setDisabled: (disabled) => {
        select.disabled = disabled;
      },
      close: closeOpenSelect,
    };
  }

  select.dataset.enhanced = 'true';
  select.classList.add('native-select-hidden');

  const wrap = document.createElement('div');
  wrap.className = 'custom-select';
  select.parentNode?.insertBefore(wrap, select);
  wrap.appendChild(select);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'custom-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');

  const valueEl = document.createElement('span');
  valueEl.className = 'custom-select-value';

  const chevron = document.createElement('span');
  chevron.className = 'custom-select-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '▾';

  trigger.append(valueEl, chevron);

  const menu = document.createElement('div');
  menu.className = 'custom-select-menu hidden';
  menu.setAttribute('role', 'listbox');

  wrap.append(trigger, menu);

  let isOpen = false;

  function positionMenu(): void {
    const rect = trigger.getBoundingClientRect();
    const maxHeight = Math.min(280, window.innerHeight * 0.42);
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;

    menu.style.position = 'fixed';
    menu.style.left = `${Math.max(8, rect.left)}px`;
    menu.style.width = `${rect.width}px`;
    menu.style.right = 'auto';
    menu.style.maxHeight = `${Math.min(maxHeight, openUp ? spaceAbove : spaceBelow)}px`;

    if (openUp) {
      menu.style.top = 'auto';
      menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
      wrap.classList.add('drop-up');
    } else {
      menu.style.top = `${rect.bottom + 6}px`;
      menu.style.bottom = 'auto';
      wrap.classList.remove('drop-up');
    }
  }

  function onViewportChange(): void {
    if (isOpen) positionMenu();
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    wrap.classList.remove('open', 'drop-up');
    menu.classList.add('hidden');
    menu.classList.remove('is-portaled');
    trigger.setAttribute('aria-expanded', 'false');
    wrap.appendChild(menu);
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange);
    if (openSelect?.close === close) openSelect = null;
  }

  function open(): void {
    if (select.disabled || select.options.length === 0) return;
    closeOpenSelect();
    isOpen = true;
    openSelect = { close };
    wrap.classList.add('open');
    menu.classList.remove('hidden');
    menu.classList.add('is-portaled');
    document.body.appendChild(menu);
    positionMenu();
    trigger.setAttribute('aria-expanded', 'true');
    markSelected();
    const active = menu.querySelector<HTMLElement>('.custom-select-option.selected');
    active?.scrollIntoView({ block: 'nearest' });
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
  }

  function updateTrigger(): void {
    const selected = select.options[select.selectedIndex];
    valueEl.textContent = selected?.textContent ?? '—';
    trigger.disabled = select.disabled;
    trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  }

  function markSelected(): void {
    Array.from(menu.querySelectorAll<HTMLElement>('.custom-select-option')).forEach((el) => {
      el.classList.toggle('selected', el.dataset.value === select.value);
    });
  }

  function rebuild(): void {
    menu.innerHTML = '';
    Array.from(select.options).forEach((opt) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'custom-select-option';
      option.dataset.value = opt.value;
      option.setAttribute('role', 'option');
      option.textContent = opt.textContent;
      option.addEventListener('click', (event) => {
        event.stopPropagation();
        if (opt.value === select.value) {
          close();
          return;
        }
        select.value = opt.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        updateTrigger();
        markSelected();
        close();
      });
      menu.appendChild(option);
    });
    updateTrigger();
    markSelected();
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    if (isOpen) close();
    else open();
  });

  select.addEventListener('change', () => {
    updateTrigger();
    markSelected();
  });

  select.addEventListener('custom-select-rebuild', rebuild);

  rebuild();

  return {
    rebuild,
    setDisabled(disabled) {
      select.disabled = disabled;
      trigger.disabled = disabled;
      if (disabled) close();
    },
    close,
  };
}
