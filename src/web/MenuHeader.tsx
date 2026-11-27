import type { ReactNode } from 'react';

export interface MenuNavigation {
  onClose(): void;
  onBack?(): void;
  backLabel?: string;
}

export function MenuHeader({ title, id, onClose, onBack, backLabel, disabled, closeHint, children }: MenuNavigation & {
  title: string; id?: string; disabled?: boolean; closeHint?: string; children?: ReactNode;
}) {
  return <header className="menu-header">
    {onBack && <button type="button" className="menu-back" disabled={disabled} onClick={onBack}>
      <span aria-hidden="true">‹ </span>返回{backLabel}
    </button>}
    <div className="menu-heading"><h2 id={id} tabIndex={-1}>{title}</h2>
      <button type="button" className="menu-close" disabled={disabled} aria-label="收起看板菜单" title={closeHint ?? '收起菜单'} onClick={onClose}>×</button>
    </div>
    {children}
  </header>;
}

export function MenuPage({ title, children, ...navigation }: MenuNavigation & { title: string; children: ReactNode }) {
  return <section className="menu-page panel-shell" aria-label={title}>
    <MenuHeader title={title} {...navigation} />
    <div className="panel-scroll">{children}</div>
  </section>;
}
