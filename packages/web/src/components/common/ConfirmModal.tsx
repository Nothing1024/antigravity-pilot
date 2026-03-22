import type { ReactNode } from "react";

import { useI18n } from "../../i18n";

type Props = {
  /** Optional icon/title row rendered above the message */
  header?: ReactNode;
  /** Descriptive message shown in the modal body */
  message: string;
  /** Label for the confirm button */
  confirmLabel: string;
  /** Visual variant: "destructive" uses the destructive color scheme */
  variant?: "default" | "destructive";
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Reusable confirmation modal with backdrop blur overlay.
 *
 * Clicking the backdrop or the Cancel button dismisses the modal.
 * Only the Confirm button triggers the `onConfirm` callback.
 */
export function ConfirmModal({
  header,
  message,
  confirmLabel,
  variant = "default",
  onConfirm,
  onCancel,
}: Props) {
  const t = useI18n();

  const confirmClasses =
    variant === "destructive"
      ? "rounded-lg bg-destructive px-4 py-1.5 text-[13px] font-medium text-destructive-foreground transition-colors hover:bg-destructive/90"
      : "rounded-lg bg-primary px-4 py-1.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90";

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="mx-4 w-full max-w-sm rounded-xl border border-border bg-background p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {header && <div className="mb-1">{header}</div>}
        <p className="mb-4 mt-2 text-[13px] leading-relaxed text-muted-foreground">
          {message}
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-border px-4 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted/60"
            onClick={onCancel}
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            className={confirmClasses}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
