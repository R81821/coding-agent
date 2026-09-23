export const defaultConversationLayout = {
  processExpanded: true,
  reviewExpanded: true,
  inlineReview: true,
} as const;

export function shouldShowHistoryLoading(hasSession: boolean, busy: boolean, turnCount: number): boolean {
  return hasSession && busy && turnCount === 0;
}
