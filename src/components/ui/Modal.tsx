"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { IconX } from "./Icons";

/**
 * Dialóg. Na mobile sa správa ako bottom sheet, na desktope ako centrovaný modal.
 * Používa natívny `<dialog>` — dostane focus trap a Esc zadarmo.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  const widths = { sm: "sm:max-w-sm", md: "sm:max-w-lg", lg: "sm:max-w-2xl" };

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        "m-0 max-h-none w-full max-w-none bg-transparent p-0 backdrop:bg-ink/28",
        "fixed inset-0 h-full",
      )}
      aria-labelledby="modal-title"
    >
      <div className="flex min-h-full items-end justify-center sm:items-center sm:p-4">
        <div
          className={cn(
            "flex max-h-[92vh] w-full flex-col rounded-t-20 bg-surface animate-(--animate-crew-in) sm:rounded-20 sm:border sm:border-line",
            widths[size],
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line p-5">
            <div className="min-w-0">
              <h2 id="modal-title" className="text-lg font-extrabold tracking-[-0.03em] text-ink">
                {title}
              </h2>
              {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex size-10 shrink-0 items-center justify-center rounded-10 bg-subtle-2 text-ink transition-colors hover:bg-subtle"
              aria-label="Zavrieť"
            >
              <IconX />
            </button>
          </div>
          {children ? <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div> : null}
          {footer ? (
            <div className="safe-bottom flex flex-wrap justify-end gap-2.5 border-t border-line p-5">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </dialog>
  );
}

/** Potvrdzovací dialóg pred nebezpečnou akciou (§42). */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Potvrdiť",
  tone = "danger",
  pending,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  tone?: "danger" | "primary";
  pending?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="touch cursor-pointer rounded-12 border border-line-strong bg-surface px-[18px] text-[15px] font-semibold text-ink hover:bg-hover"
          >
            Zrušiť
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className={cn(
              "touch cursor-pointer rounded-12 px-[18px] text-[15px] font-semibold text-white disabled:opacity-60",
              tone === "danger" ? "bg-bad-fg hover:opacity-90" : "bg-ink hover:bg-body",
            )}
          >
            {pending ? "Pracujem…" : confirmLabel}
          </button>
        </>
      }
    />
  );
}
