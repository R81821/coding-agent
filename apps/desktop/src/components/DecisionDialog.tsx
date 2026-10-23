import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./DecisionDialog.css";
export interface DecisionOptions { title: string; description: string; subject?: string; confirmLabel: string; status: string; destructive?: boolean }
export function DecisionDialog({title,children,status,destructive=false,confirmLabel,cancelLabel="取消",extraAction,onConfirm,onCancel,onDismiss,busy=false}: {
 title:string; children:React.ReactNode; status:string; destructive?:boolean; confirmLabel:string; cancelLabel?:string;
 /** Optional control rendered between the cancel and confirm actions, e.g. a disclosure toggle. */
 extraAction?:React.ReactNode;
 onConfirm:()=>void|Promise<void>; onCancel:()=>void|Promise<void>; onDismiss:()=>void;
 busy?:boolean;
}) {
 const ref=useRef<HTMLDialogElement>(null); const titleId=useId();
 const [pending,setPending]=useState(false); const [error,setError]=useState("");
 const locked=useRef(false);
 useEffect(()=>{const dialog=ref.current;const previous=document.activeElement as HTMLElement|null;dialog?.showModal();return()=>{dialog?.close();if(previous?.isConnected)previous.focus();};},[]);
 async function act(action:()=>void|Promise<void>) {
  if(locked.current||busy)return;locked.current=true;setPending(true);setError("");
  try{await action();}catch(caught){setError(caught instanceof Error?caught.message:String(caught));}finally{locked.current=false;setPending(false);}
 }
 return createPortal(<dialog ref={ref} className="decision-dialog approval-overlay" aria-labelledby={titleId} onCancel={event=>{event.preventDefault();if(!locked.current&&!busy)onDismiss();}}>
  <div className="decision-card"><header><h2 id={titleId}>{title}</h2><button className="decision-close" aria-label="稍后处理" disabled={pending||busy} onClick={onDismiss}>×</button></header>
   <div className="decision-body">{children}{error&&<p role="alert" className="decision-error">{error}</p>}</div>
   <footer><span className={`decision-status${destructive?" is-danger":""}`}><i aria-hidden="true"><b/><b/><b/></i>{status}</span><div className="decision-actions">{extraAction}<button autoFocus className="decision-secondary" disabled={pending||busy} onClick={()=>void act(onCancel)}>{cancelLabel}</button><button className="decision-primary" disabled={pending||busy} onClick={()=>void act(onConfirm)}>{pending||busy?"处理中…":confirmLabel}</button></div></footer>
  </div>
 </dialog>,document.body);
}
export function useConfirmation() {
 const [options,setOptions]=useState<DecisionOptions>();
 const resolver=useRef<((approved:boolean)=>void)|undefined>(undefined);
 useEffect(()=>()=>{resolver.current?.(false);resolver.current=undefined;},[]);
 function confirm(next:DecisionOptions):Promise<boolean>{if(resolver.current)return Promise.resolve(false);setOptions(next);return new Promise(resolve=>{resolver.current=resolve;});}
 function settle(approved:boolean){const resolve=resolver.current;resolver.current=undefined;setOptions(undefined);resolve?.(approved);}
 const confirmationDialog=options?<DecisionDialog title={options.title} status={options.status} destructive={options.destructive??false} confirmLabel={options.confirmLabel} onConfirm={()=>settle(true)} onCancel={()=>settle(false)} onDismiss={()=>settle(false)}><p className="decision-description">{options.description}</p>{options.subject&&<span className="decision-subject">{options.subject}</span>}</DecisionDialog>:null;
 return {confirm,confirmationDialog};
}
