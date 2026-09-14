import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ApprovalContent } from "./ApprovalContent.js";
it("renders literal readable approval content without a JSON envelope or executable HTML",()=>{
 const html=renderToStaticMarkup(<ApprovalContent input={{content:'const x = { ok: true };\n<script>alert(1)</script>',cwd:'D:/project'}}/>);
 expect(html).toContain('const x = { ok: true };\n&lt;script&gt;');
 expect(html).not.toContain('<script>'); expect(html).not.toContain('&quot;content&quot;'); expect(html).toContain('D:/project');
});
