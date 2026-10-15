import React from "react";
import { DecisionDialog } from "./DecisionDialog.js";

/**
 * The approval card. It follows the same shape as every other decision in the app — a title, what
 * the decision is about, and a confidence line above the actions — but keeps the operational detail
 * collapsed: a long patch or a profile command matrix should not push the buttons off screen before
 * the reader has decided whether they need it.
 */
export function ApprovalDialog({
  title,
  description,
  subject,
  status,
  destructive,
  alternativesLabel,
  children,
  confirmLabel,
  cancelLabel = "拒绝",
  onConfirm,
  onCancel,
  onDismiss,
  onPause,
}: {
  title: string;
  description: string;
  subject?: string;
  status: string;
  destructive?: boolean;
  /** Label for the disclosure holding the details. Omit when there is nothing to disclose. */
  alternativesLabel?: string;
  children?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void | Promise<void>;
  onDismiss: () => void;
  /** Stop the current round without approving the operation. */
  onPause?: () => void | Promise<void>;
}) {
  const [showAlternatives, setShowAlternatives] = React.useState(false);
  const panelId = React.useId();
  const hasAlternatives = Boolean(children) && Boolean(alternativesLabel);
  return (
    <DecisionDialog
      title={title}
      status={status}
      destructive={destructive ?? false}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      onConfirm={onConfirm}
      onCancel={onCancel}
      onDismiss={onDismiss}
      {...(hasAlternatives || onPause
        ? {
            extraAction: (
              <>
                {onPause && <button type="button" className="decision-secondary" onClick={() => void onPause()}>暂停本轮</button>}
                {hasAlternatives && (
                  <button
                    type="button"
                    className="decision-alternatives"
                    aria-expanded={showAlternatives}
                    aria-controls={panelId}
                    onClick={() => setShowAlternatives((value) => !value)}
                  >
                    {alternativesLabel}
                  </button>
                )}
              </>
            ),
          }
        : {})}
    >
      <p className="decision-description">{description}</p>
      {subject && <span className="decision-subject">{subject}</span>}
      {hasAlternatives && (
        <div id={panelId} className="decision-alternatives-panel" hidden={!showAlternatives}>
          {children}
        </div>
      )}
    </DecisionDialog>
  );
}
