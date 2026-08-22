/**
 * Dialog — adapted from shadcn/ui's Base UI dialog (MIT), in `ui-reference/shadcn-vite`.
 *
 * The app had **one** hand-built overlay class left: `modal-backdrop` + `.af-relic-modal`, portalled
 * by hand and kept accessible by `useModalA11y`. That worked, but it meant the layering rule
 * ("overlays come from the primitives") had an exception, and every future modal had a precedent to
 * copy. This closes it.
 *
 * Changes from the source:
 * - `lucide-react` swapped for our Tabler icon font — one icon system per app.
 * - `z-50` replaced with the `--z-modal` layering token, and the backdrop with `--z-overlay`.
 *   A literal z-index is what produced twenty-one hand-picked values before the migration.
 * - Colours on our tokens. The popup uses `--color-bg-overlay` and a `white/12` border, like the
 *   tooltip and popover: an overlay has to read as *above* the page, and `bg-elevated` sits at
 *   1.04:1 against `bg-panel`, which is invisible as a surface change.
 * - `sm:max-w-sm` dropped from the base. This is a desktop app and its dialogs carry tables;
 *   callers set their own width rather than fighting a mobile-first default.
 * - **`tw-animate-css` utility classes replaced with our `data-ws-overlay` keyframes**, matching
 *   the tooltip and popover. That plugin is deliberately not installed, so `animate-out` and
 *   friends generate nothing — and Base UI keeps a closing popup mounted until its exit animation
 *   reports finishing. With no animation to finish, the dialog closed logically (`data-closed` was
 *   set) and then sat on screen forever, unclosable. Keyframes fire a real `animationend`, so the
 *   lifecycle completes. They are also neutralised by the global `prefers-reduced-motion` block.
 *
 * `useModalA11y` stays for the screenshot-import modals until they migrate; Base UI handles focus
 * trapping, Escape and focus restoration itself, so a `Dialog` must not also use that hook.
 */
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      data-ws-overlay=""
      className={cn('fixed inset-0 z-(--z-overlay) bg-black/70', className)}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & { showCloseButton?: boolean }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        data-ws-overlay=""
        className={cn(
          'fixed top-1/2 left-1/2 z-(--z-modal) flex max-h-[85vh] w-full max-w-lg -translate-x-1/2',
          '-translate-y-1/2 flex-col gap-3 overflow-hidden rounded-xl border border-white/12',
          'bg-bg-overlay p-4 text-ink shadow-float outline-none',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            aria-label="Close"
            render={<Button variant="ghost" size="icon-sm" className="absolute top-3 right-3" />}
          >
            <i className="ti ti-x" aria-hidden="true" />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex shrink-0 flex-col gap-1 pr-8', className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex shrink-0 items-center justify-end gap-2', className)}
      {...props}
    />
  );
}

/** Inter 14/600 — the same step as `PanelTitle variant="heading"`, so a dialog's title and a
 *  panel's read as the same level of thing. */
function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('truncate font-sans text-sm font-semibold text-ink', className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-[11px] text-ink-dim', className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
