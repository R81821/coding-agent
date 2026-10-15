import React from "react";
import { BuiButton } from "../ui/button.js";
import "./unlock.css";

export function Unlock(props: {
  passphrase: string;
  setPassphrase: (value: string) => void;
  rememberDevice: boolean;
  setRememberDevice: (value: boolean) => void;
  error: string;
  onUnlock: () => void;
}) {
  return (
    <div className="unlock unlock-screen">
      <section className="unlock-panel" aria-labelledby="unlock-heading">
        <div className="unlock-brand-mark" aria-hidden="true">H</div>
        <small className="unlock-brand-name">HARNESS AGENT</small>
        <h1 id="unlock-heading">解锁本地运行时</h1>
        <p className="unlock-description">
          口令用于解密会话、记忆、工具记录和图片。它不会发送给模型服务。
        </p>
        <input
          autoFocus
          type="password"
          className="unlock-passphrase"
          aria-label="应用口令"
          value={props.passphrase}
          onChange={(event) => props.setPassphrase(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void props.onUnlock();
          }}
          placeholder="应用口令（至少 10 个字符）"
        />
        <label className="unlock-remember">
          <input
            type="checkbox"
            checked={props.rememberDevice}
            onChange={(event) => props.setRememberDevice(event.target.checked)}
          />
          <span>记住此设备（使用 Windows DPAPI）</span>
        </label>
        {props.error && <div className="unlock-error" role="alert">{props.error}</div>}
        <BuiButton variant="primary" className="unlock-submit" onClick={() => void props.onUnlock()}>
          解锁并启动 agentd
        </BuiButton>
      </section>
    </div>
  );
}
