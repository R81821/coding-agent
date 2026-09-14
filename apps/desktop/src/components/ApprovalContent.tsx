import React from "react";
import { approvalFields } from "../approval-content.js";
export function ApprovalContent({ input }: { input: unknown }) {
 return <div className="approval-readable" aria-label="审批内容">{approvalFields(input).map((field, index) => <section key={index}><small>{field.label}</small><pre>{field.text}</pre></section>)}</div>;
}
