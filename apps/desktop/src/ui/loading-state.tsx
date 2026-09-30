import "./loading-state.css";

export function BuiLoadingState({ label = "正在运行" }: { label?: string }) {
  return (
    <div className="conversation-loading" role="status" aria-live="polite" title={label}>
      <span className="sr-only">{label}</span>
      <span className="xiaohuiga-walk" aria-hidden="true" />
    </div>
  );
}
