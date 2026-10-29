import { AlertCircle, ChevronDown, LoaderCircle, X } from 'lucide-react';
import {
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type CSSProperties,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { useGlow as usePointerGlow } from '../../hooks/useGlow';
import './ui.css';

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';

function toneOf(status: unknown): Tone {
  const text = String(status ?? 'unknown');
  if (/failed|error|deprecated|rejected/i.test(text)) return 'bad';
  if (/warning|partial|needs_review|stale|queued|running/i.test(text)) return 'warn';
  if (/approved|succeeded|verified|ready|healthy|accepted/i.test(text)) return 'ok';
  return 'neutral';
}

function statusLabel(status: unknown): string {
  const text = String(status ?? 'unknown').replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface GlassPanelProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  children?: ReactNode;
  useGlow?: boolean;
}
export function GlassPanel({ className = '', children, useGlow = false, ...props }: GlassPanelProps) {
  if (!useGlow) return <div className={`ui-glass ${className}`.trim()} {...props}>{children}</div>;
  return <GlassPanelWithGlow className={className} {...props}>{children}</GlassPanelWithGlow>;
}

function GlassPanelWithGlow({ className = '', children, ...props }: Omit<GlassPanelProps, 'useGlow'>) {
  const glowRef = usePointerGlow<HTMLDivElement>();
  return <div ref={glowRef} className={`ui-glass ui-glass-glow ${className}`.trim()} {...props}>{children}</div>;
}

export type ButtonVariant = 'primary' | 'accent' | 'ghost' | 'danger';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
  size?: 'sm' | 'md';
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className = '', variant = 'primary', loading = false, size = 'md', disabled, children, ...props },
  ref,
) {
  return <button ref={ref} className={`ui-button ui-button-${variant} ${size === 'sm' ? 'ui-button-sm' : ''} ${className}`.trim()} disabled={disabled || loading} {...props}>
    {loading ? <LoaderCircle className="ui-spinner" aria-hidden="true" /> : null}{children}
  </button>;
});

export interface IconButtonProps extends ButtonProps {
  'aria-label': string;
}
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className = '', variant = 'ghost', size = 'md', ...props }, ref,
) {
  return <Button ref={ref} className={`ui-icon-button ${className}`.trim()} variant={variant} size={size} {...props} />;
});

export interface FieldProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  required?: boolean;
  children: ReactNode;
}
interface FieldControlProps {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}
export function Field({ label, hint, error, htmlFor, required, children, className = '', ...props }: FieldProps) {
  const generatedId = useId();
  const controlId = htmlFor ?? `${generatedId}-control`;
  const describedBy = [hint ? `${generatedId}-hint` : '', error ? `${generatedId}-error` : ''].filter(Boolean).join(' ') || undefined;
  const child = isValidElement<FieldControlProps>(children)
    ? cloneElement(children as ReactElement<FieldControlProps>, { id: controlId, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })
    : children;
  return <div className={`ui-field ${className}`.trim()} {...props}>
    {label ? <label className="ui-field-label" htmlFor={controlId}>{label}{required ? ' *' : ''}</label> : null}
    <span className="ui-field-control">{child}</span>
    {hint ? <span id={`${generatedId}-hint`} className="ui-field-hint">{hint}</span> : null}
    {error ? <span id={`${generatedId}-error`} className="ui-field-error" role="alert">{error}</span> : null}
  </div>;
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> { error?: boolean; }
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className = '', error, ...props }, ref) {
  return <input ref={ref} className={`ui-control ${className}`.trim()} aria-invalid={error || props['aria-invalid'] ? true : undefined} {...props} />;
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options?: Array<{ value: string; label: string; disabled?: boolean }>;
  error?: boolean;
}
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ className = '', error, options, children, ...props }, ref) {
  return <span className="ui-select-wrap">
    <select ref={ref} className={`ui-control ${className}`.trim()} aria-invalid={error || props['aria-invalid'] ? true : undefined} {...props}>
      {options ? options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>) : children}
    </select>
    <ChevronDown className="ui-select-icon" size={16} aria-hidden="true" />
  </span>;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> { error?: boolean; }
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className = '', error, ...props }, ref) {
  return <textarea ref={ref} className={`ui-control ${className}`.trim()} aria-invalid={error || props['aria-invalid'] ? true : undefined} {...props} />;
});

export interface DropzoneProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'onChange' | 'defaultValue'> {
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  value?: File[];
  defaultValue?: File[];
  onChange?: (files: File[]) => void;
  children?: ReactNode;
}
export function Dropzone({ accept, multiple = true, disabled = false, value, defaultValue = [], onChange, children, className = '', ...props }: DropzoneProps) {
  const [internalFiles, setInternalFiles] = useState<File[]>(defaultValue);
  const [active, setActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const files = value ?? internalFiles;
  const update = useCallback((next: File[]) => { if (value === undefined) setInternalFiles(next); onChange?.(next); }, [onChange, value]);
  const addFiles = useCallback((incoming: FileList | File[]) => {
    const accepted = Array.from(incoming);
    update(multiple ? [...files, ...accepted] : accepted.slice(0, 1));
  }, [files, multiple, update]);
  const onInput = (event: ChangeEvent<HTMLInputElement>) => { if (event.target.files) addFiles(event.target.files); event.target.value = ''; };
  return <div className={`ui-dropzone ${active ? 'ui-dropzone-active' : ''} ${disabled ? 'ui-dropzone-disabled' : ''} ${className}`.trim()} onClick={() => !disabled && inputRef.current?.click()} onDragEnter={event => { event.preventDefault(); if (!disabled) setActive(true); }} onDragOver={event => event.preventDefault()} onDragLeave={() => setActive(false)} onDrop={event => { event.preventDefault(); setActive(false); if (!disabled) addFiles(event.dataTransfer.files); }} {...props}>
    <input ref={inputRef} type="file" accept={accept} multiple={multiple} disabled={disabled} onChange={onInput} />
    {children ?? <><strong>Choose files</strong><span>or drag and drop them here</span></>}
    {files.length > 0 ? <ul className="ui-file-list" onClick={event => event.stopPropagation()}>{files.map((file, index) => <li className="ui-file-item" key={`${file.name}-${file.lastModified}-${index}`}><span>{file.name}</span><IconButton aria-label={`Remove ${file.name}`} size="sm" onClick={() => update(files.filter((_, fileIndex) => fileIndex !== index))}><X size={14} aria-hidden="true" /></IconButton></li>)}</ul> : null}
  </div>;
}

export type BadgeTone = 'neutral' | 'mint' | 'sun' | 'coral' | 'iris';
export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> { tone?: BadgeTone; children: ReactNode; }
export function Badge({ tone = 'neutral', className = '', children, ...props }: BadgeProps) { return <span className={`ui-badge ${tone === 'neutral' ? '' : `ui-badge-${tone}`} ${className}`.trim()} {...props}>{children}</span>; }

export interface StatusPillProps extends HTMLAttributes<HTMLSpanElement> { status: unknown; tone?: Tone; }
export function StatusPill({ status, tone = toneOf(status), className = '', ...props }: StatusPillProps) { return <span className={`ui-status ui-status-${tone} ${className}`.trim()} {...props}><span className="ui-status-dot" aria-hidden="true" />{statusLabel(status)}</span>; }

export interface SegmentedBarProps extends HTMLAttributes<HTMLDivElement> { imported?: number; skipped?: number; failed?: number; }
export function SegmentedBar({ imported = 0, skipped = 0, failed = 0, className = '', ...props }: SegmentedBarProps) {
  const total = Math.max(1, imported + skipped + failed);
  return <div className={`ui-segmented ${className}`.trim()} role="img" aria-label={`${imported} imported, ${skipped} skipped, ${failed} failed`} {...props}><span className="ui-segment ui-segment-imported" style={{ flexGrow: imported / total }} /><span className="ui-segment ui-segment-skipped" style={{ flexGrow: skipped / total }} /><span className="ui-segment ui-segment-failed" style={{ flexGrow: failed / total }} /></div>;
}

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> { title: ReactNode; description?: ReactNode; actions?: ReactNode; tabs?: ReactNode; section?: string; }
export function PageHeader({ title, description, actions, tabs, className = '', section: _section, ...props }: PageHeaderProps) { return <header className={`ui-page-header ${className}`.trim()} {...props}><div><h1>{title}</h1>{description ? <p className="ui-page-header-description">{description}</p> : null}{tabs ? <div className="ui-page-tabs">{tabs}</div> : null}</div>{actions ? <div className="ui-page-header-actions">{actions}</div> : null}</header>; }

export interface DataTableColumn<Row> { key: string; header: ReactNode; render?: (row: Row) => ReactNode; className?: string; }
export interface DataTableProps<Row> extends HTMLAttributes<HTMLDivElement> { columns: Array<DataTableColumn<Row>>; rows: Row[]; rowKey?: (row: Row, index: number) => string; onRowClick?: (row: Row) => void; selectedRowKey?: string; }
export function DataTable<Row>({ columns, rows, rowKey, onRowClick, selectedRowKey, className = '', ...props }: DataTableProps<Row>) {
  return <div className={`ui-glass ui-data-table ${className}`.trim()} {...props}><div className="ui-data-scroll"><table><thead><tr>{columns.map(column => <th key={column.key} className={column.className}>{column.header}</th>)}</tr></thead><tbody>{rows.map((row, index) => { const key = rowKey?.(row, index) ?? String(index); return <tr key={key} className={`${onRowClick ? 'ui-data-row-clickable' : ''} ${selectedRowKey === key ? 'ui-data-row-selected' : ''}`.trim()} onClick={() => onRowClick?.(row)}>{columns.map(column => <td key={column.key} data-label={typeof column.header === 'string' ? column.header : undefined} className={column.className}>{column.render ? column.render(row) : String((row as Record<string, unknown>)[column.key] ?? '')}</td>)}</tr>; })}</tbody></table></div></div>;
}

export interface PaginationProps extends HTMLAttributes<HTMLElement> { page: number; total: number; limit: number; onPageChange: (page: number) => void; }
export function Pagination({ page, total, limit, onPageChange, className = '', ...props }: PaginationProps) { const pageCount = Math.max(1, Math.ceil(total / Math.max(1, limit))); const from = total === 0 ? 0 : (page - 1) * limit + 1; const to = Math.min(total, page * limit); return <nav className={`ui-pagination ${className}`.trim()} aria-label="Pagination" {...props}><span className="ui-pagination-count">Showing {from} to {to} of {total}</span><span className="ui-pagination-actions"><Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>Previous</Button><Button size="sm" variant="ghost" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)}>Next</Button></span></nav>; }

function focusableElements(container: HTMLElement): HTMLElement[] { return Array.from(container.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')); }
function useFocusTrap(open: boolean, containerRef: RefObject<HTMLElement>, onClose: () => void) {
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const container = containerRef.current;
    const focusTarget = container ? focusableElements(container)[0] ?? container : null;
    const frame = requestAnimationFrame(() => focusTarget?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab' || !container) return;
      const elements = focusableElements(container);
      if (elements.length === 0) { event.preventDefault(); container.focus(); return; }
      const first = elements[0]; const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', onKeyDown); previousFocus.current?.focus(); previousFocus.current = null; };
  }, [containerRef, onClose, open]);
}

export interface DialogProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'title'> { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; wide?: boolean; closeOnOverlay?: boolean; busy?: boolean; }
export function Dialog({ open, onClose, title, description, children, footer, wide = false, closeOnOverlay = true, busy = false, className = '', ...props }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null); const titleId = useId();
  const close = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);
  useFocusTrap(open, ref, close);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(<div className="ui-overlay" onMouseDown={event => { if (closeOnOverlay && event.target === event.currentTarget) close(); }}><div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={`ui-glass ui-dialog ${wide ? 'ui-dialog-wide' : ''} ${className}`.trim()} {...props}><h2 id={titleId} className="ui-dialog-title">{title}</h2>{description ? <p className="ui-dialog-description">{description}</p> : null}{children ? <div className="ui-dialog-body">{children}</div> : null}{footer ? <div className="ui-dialog-footer">{footer}</div> : null}</div></div>, document.body);
}

export interface ConfirmDialogProps { open: boolean; onClose: () => void; title: ReactNode; description: ReactNode; confirmLabel: string; tone?: 'primary' | 'danger'; requireReason?: boolean; onConfirm: (reason?: string) => void | Promise<void>; }
export function ConfirmDialog({ open, onClose, title, description, confirmLabel, tone = 'primary', requireReason = false, onConfirm }: ConfirmDialogProps) {
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!open) { setReason(''); setBusy(false); setError(null); } }, [open]);
  const confirm = async () => { if (requireReason && reason.trim() === '') return; setBusy(true); setError(null); try { await onConfirm(requireReason ? reason.trim() : undefined); onClose(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The action could not be completed. Try again.'); } finally { setBusy(false); } };
  return <Dialog open={open} onClose={onClose} title={title} description={description} busy={busy} footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button variant={tone === 'danger' ? 'danger' : 'primary'} loading={busy} disabled={requireReason && reason.trim() === ''} onClick={() => void confirm()}>{confirmLabel}</Button></>}><div>{requireReason ? <Field label="Reason" hint="Recorded in the audit log" required><Textarea value={reason} onChange={event => setReason(event.target.value)} required /></Field> : null}{error ? <p className="ui-dialog-error" role="alert">{error}</p> : null}</div></Dialog>;
}

export interface DrawerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'title'> { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; }
export function Drawer({ open, onClose, title, description, children, footer, className = '', ...props }: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null); const titleId = useId(); const close = useCallback(() => onClose(), [onClose]); useFocusTrap(open, ref, close);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(<><div className="ui-drawer-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }} /><aside ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={`ui-drawer ${className}`.trim()} {...props}><header className="ui-drawer-header"><div><h2 id={titleId} className="ui-drawer-title">{title}</h2>{description ? <p className="ui-page-header-description">{description}</p> : null}</div><IconButton aria-label="Close" onClick={close}><X size={18} aria-hidden="true" /></IconButton></header><div className="ui-drawer-content">{children}</div>{footer ? <footer className="ui-drawer-footer">{footer}</footer> : null}</aside></>, document.body);
}

export interface PopoverProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> { open: boolean; onClose: () => void; anchorRef: RefObject<HTMLElement>; children?: ReactNode; }
export function Popover({ open, onClose, anchorRef, children, className = '', ...props }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null); const [style, setStyle] = useState<CSSProperties>({});
  useEffect(() => { if (!open) return; const update = () => { const rect = anchorRef.current?.getBoundingClientRect(); if (rect) setStyle({ top: rect.bottom + 8, left: Math.min(rect.left, window.innerWidth - 340) }); }; update(); window.addEventListener('resize', update); window.addEventListener('scroll', update, true); const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; const onPointer = (event: PointerEvent) => { const target = event.target as Node; if (!ref.current?.contains(target) && !anchorRef.current?.contains(target)) onClose(); }; document.addEventListener('keydown', onKey); document.addEventListener('pointerdown', onPointer); return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer); }; }, [anchorRef, onClose, open]);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(<div ref={ref} className={`ui-popover ${className}`.trim()} style={style} {...props}>{children}</div>, document.body);
}

export interface TooltipProps { content: ReactNode; children: ReactNode; delay?: number; }
export function Tooltip({ content, children, delay = 250 }: TooltipProps) {
  const triggerRef = useRef<HTMLSpanElement>(null); const [visible, setVisible] = useState(false); const [position, setPosition] = useState<CSSProperties>({}); const timer = useRef<number | undefined>(undefined);
  const show = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => { const rect = triggerRef.current?.getBoundingClientRect(); if (rect) setPosition({ top: rect.bottom + 8, left: Math.min(rect.left, window.innerWidth - 300) }); setVisible(true); }, delay); }; const hide = () => { window.clearTimeout(timer.current); setVisible(false); };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return <><span ref={triggerRef} tabIndex={0} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>{children}</span>{visible && typeof document !== 'undefined' ? createPortal(<span role="tooltip" className="ui-tooltip" style={position}>{content}</span>, document.body) : null}</>;
}

type ToastTone = 'success' | 'error' | 'info';
interface ToastItem { id: number; tone: ToastTone; text: string; }
interface ToastContextValue { success: (text: string) => void; error: (text: string) => void; info: (text: string) => void; }
const ToastContext = createContext<ToastContextValue | null>(null);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]); const nextId = useRef(0);
  const add = useCallback((tone: ToastTone, text: string) => { const id = nextId.current++; setItems(current => [...current, { id, tone, text }]); if (tone !== 'error') window.setTimeout(() => setItems(current => current.filter(item => item.id !== id)), 4000); }, []);
  const dismiss = (id: number) => setItems(current => current.filter(item => item.id !== id));
  return <ToastContext.Provider value={{ success: text => add('success', text), error: text => add('error', text), info: text => add('info', text) }}>{children}<div className="ui-toast-region" aria-live="polite">{items.map(item => <div key={item.id} className={`ui-glass ui-toast ui-toast-${item.tone}`} role={item.tone === 'error' ? 'alert' : 'status'}><span className="ui-toast-text">{item.text}</span><IconButton aria-label="Dismiss notification" size="sm" onClick={() => dismiss(item.id)}><X size={14} aria-hidden="true" /></IconButton></div>)}</div></ToastContext.Provider>;
}
export function useToast(): ToastContextValue { const context = useContext(ToastContext); if (!context) throw new Error('useToast must be used within ToastProvider'); return context; }

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> { width?: string | number; height?: string | number; }
export function Skeleton({ width, height, style, className = '', ...props }: SkeletonProps) { return <div className={`ui-skeleton ${className}`.trim()} style={{ width, height, ...style }} aria-hidden="true" {...props} />; }
export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> { title: ReactNode; description: ReactNode; action?: ReactNode; }
export function EmptyState({ title, description, action, className = '', ...props }: EmptyStateProps) { return <div className={`ui-glass ui-empty-state ${className}`.trim()} {...props}><h2>{title}</h2><p>{description}</p>{action}</div>; }
export interface ErrorStateProps extends HTMLAttributes<HTMLDivElement> { message?: ReactNode; description?: ReactNode; onRetry?: () => void; }
export function ErrorState({ message = 'Something went wrong.', description = 'Try again, or check your connection before retrying.', onRetry, className = '', ...props }: ErrorStateProps) { return <div className={`ui-glass ui-empty-state ${className}`.trim()} {...props}><AlertCircle className="ui-error-icon" size={22} aria-hidden="true" /><h2>{message}</h2><p>{description}</p>{onRetry ? <Button variant="ghost" onClick={onRetry}>Retry</Button> : null}</div>; }
