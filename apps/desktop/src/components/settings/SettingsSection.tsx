import React, { useState } from "react";

export function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      <div className="settings-panel">{children}</div>
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <h4>{title}</h4>
        {description && <p>{description}</p>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

export function SettingsMessage({
  message,
  error,
}: {
  message: string;
  error: boolean;
}) {
  return message ? (
    <p
      className={`settings-message${error ? " is-error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {message}
    </p>
  ) : null;
}

export function useSettingsAction() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  async function run(action: () => Promise<string>) {
    setBusy(true);
    setMessage("");
    setError(false);
    try {
      setMessage(await action());
    } catch (caught) {
      setError(true);
      setMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }
  return { busy, message, error, run };
}
