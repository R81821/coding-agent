export const defaultConversationLayout = {
  processExpanded: true,
  reviewExpanded: true,
  inlineReview: true,
} as const;

export function shouldShowHistoryLoading(hasSession: boolean, busy: boolean, turnCount: number): boolean {
  return hasSession && busy && turnCount === 0;
}

export function shouldExpandToolGroup(completed: number, total: number): boolean {
  return completed < total;
}

export function isAwayFromLatest(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight > 96;
}

export function shouldPreviewProcessText(text: string, live = false): boolean {
  return !live && (text.length > 500 || text.split("\n").length > 8);
}

export function summarizeActivityMessage(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 140).trimEnd()}…` : message;
}
