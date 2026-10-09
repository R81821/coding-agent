import React, { memo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { VirtualConversation, useRowState, type ConversationPosition } from "@harness/conversation-ui";
import { ConversationProcessSummary } from "../../desktop/src/components/ConversationProcess";

type Item = { id: string; text: string };
const seed = Array.from({ length: 1000 }, (_, index) => ({ id: `turn-${index}`, text: `消息 ${index}。` + "长会话性能回归测试。".repeat(index % 8 + 1) }));
const key = (item: Item) => item.id;
const renders = new Map<string, number>();
let processRenders = 0;
const Row = memo(function Row({ item }: { item: Item }) {
  renders.set(item.id, (renders.get(item.id) ?? 0) + 1);
  const [note, setNote] = useRowState("note", "");
  return <article style={{ padding: 12, border: "1px solid #ccc", borderRadius: 8 }}>
    <p>{item.id}: {item.text}</p>
    <button data-save-note onClick={() => setNote("保留的续办说明")}>填写续办说明</button><span data-note>{note}</span>
    <ConversationProcessSummary completed durationMs={1200}>{() => { processRenders++; return <p data-heavy>重型执行过程已展开</p>; }}</ConversationProcessSummary>
  </article>;
});
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean) {
  for (let index = 0; index < 200; index++) { if (test()) return; await delay(20); }
  throw new Error("等待渲染超时");
}
function check(ok: unknown, message: string) { if (!ok) throw new Error(message); }
function Harness() {
  const [items, setItems] = useState(seed);
  const [generation, setGeneration] = useState(0);
  const position = useRef<ConversationPosition | undefined>(undefined);
  const [result, setResult] = useState("准备就绪：1000 条消息");
  async function test() {
    setResult("验证中…");
    try {
      await until(() => !!document.querySelector('[data-virtual-row="turn-999"]'));
      const scroller = document.querySelector('[aria-label="虚拟回归会话"]') as HTMLElement;
      const count = () => document.querySelectorAll("[data-virtual-row]").length;
      check(count() < 25, `渲染了 ${count()} 行，未限制 DOM 数量`);
      check(processRenders === 0, "折叠执行过程仍被创建");
      const last = document.querySelector('[data-virtual-row="turn-999"]')!;
      (last.querySelector('[data-save-note]') as HTMLElement).click();
      (last.querySelector('summary') as HTMLElement).click();
      await until(() => !!last.querySelector('[data-heavy]'));
      scroller.scrollTop = 0; await until(() => !document.querySelector('[data-virtual-row="turn-999"]'));
      check(count() < 25, "滚动后未卸载离屏消息");
      (document.querySelector('[aria-label="回到最新消息"]') as HTMLElement).click();
      await until(() => !!document.querySelector('[data-virtual-row="turn-999"]'));
      const restored = document.querySelector('[data-virtual-row="turn-999"]')!;
      check(restored.querySelector('[data-note]')?.textContent === "保留的续办说明", "离屏后续办说明丢失");
      check(!!restored.querySelector('[data-heavy]'), "展开状态未恢复");
      scroller.scrollTop = scroller.scrollHeight / 2;
      await delay(400);
      const bounds = scroller.getBoundingClientRect();
      const anchor = [...document.querySelectorAll('[data-virtual-row]')].find(el => el.getBoundingClientRect().bottom > bounds.top && el.getBoundingClientRect().top < bounds.bottom)!;
      const anchorId = anchor.getAttribute('data-virtual-row');
      const top = anchor.getBoundingClientRect().top;
      setItems(current => [...Array.from({ length: 20 }, (_, i) => ({ id: `older-${i}`, text: "较早消息" })), ...current]);
      await delay(400);
      const anchored = document.querySelector(`[data-virtual-row="${anchorId}"]`);
      check(anchored && Math.abs(anchored.getBoundingClientRect().top - top) < 3, "加载历史导致阅读位置跳动");
      const before = new Map(renders);
      const scrollTop = scroller.scrollTop;
      setItems(current => current.map(item => item.id === "turn-999" ? { ...item, text: item.text + " 新增输出".repeat(100) } : item));
      await delay(300);
      check(Math.abs(scroller.scrollTop - scrollTop) < 3, "离开底部时被流式输出拉走");
      check([...before].every(([id, n]) => id === "turn-999" || renders.get(id) === n), "旧消息随新输出重复渲染");
      check(count() < 25, "追加历史后 DOM 数量失控");
      setGeneration(current => current + 1);
      await delay(500);
      const reopened = document.querySelector(`[data-virtual-row="${anchorId}"]`);
      check(reopened && Math.abs(reopened.getBoundingClientRect().top - top) < 3, "切回会话未恢复测量后的阅读位置");
      (document.querySelector('[aria-label="回到最新消息"]') as HTMLElement).click();
      await until(() => !!document.querySelector('[data-virtual-row="turn-999"]'));
      await delay(300);
      setItems(current => [...current, { id: "new-turn", text: "新一轮回答".repeat(100) }]);
      await delay(500);
      const activeScroller = document.querySelector('[aria-label="虚拟回归会话"]') as HTMLElement;
      check(activeScroller.scrollHeight - activeScroller.clientHeight - activeScroller.scrollTop < 3, "底部未跟随新一轮消息");
      setItems(current => current.map(item => item.id === "new-turn" ? { ...item, text: item.text + "流式增量".repeat(100) } : item));
      await delay(400);
      check(activeScroller.scrollHeight - activeScroller.clientHeight - activeScroller.scrollTop < 3, "底部未跟随动态高度变化");
      setResult(`PASS：1021 条消息，当前仅挂载 ${count()} 行；折叠过程零构建；离屏状态保留；前插锚点稳定；旧消息无重复渲染；历史阅读不被拉走；切回恢复位置；底部跟随追加与流式增量。`);
    } catch (error) { setResult(`FAIL：${String(error)}`); }
  }
  return <main><h1>长会话渲染回归</h1><button onClick={() => void test()} disabled={result !== "准备就绪：1000 条消息"}>运行回归</button><p role="status">{result}</p>
    <div style={{ height: 500, width: 800, border: "1px solid #ddd" }}><VirtualConversation key={generation} initialPosition={position.current} onPosition={value => { position.current = value; }} items={items} itemKey={key} renderItem={item => <Row item={item} />} label="虚拟回归会话" /></div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
