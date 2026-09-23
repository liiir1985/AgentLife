import { createServer, type Server } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import type { SessionLogEntry } from "./session-trace.js";

const PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentLife Session Log</title>
<style>
:root{font:14px/1.5 system-ui,sans-serif;color:#e5e7eb;background:#111827}*{box-sizing:border-box}
body{margin:0;display:grid;grid-template-columns:250px 1fr;height:100vh}aside{border-right:1px solid #374151;padding:16px;overflow:auto}
main{padding:20px;overflow:auto}h1{font-size:20px;margin:0 0 12px}h2{font-size:17px;margin:16px 0 8px}
button,input{font:inherit;color:inherit;background:#1f2937;border:1px solid #4b5563;border-radius:5px;padding:6px 9px}
button{cursor:pointer;text-align:left;width:100%;margin:3px 0;overflow-wrap:anywhere}button.active{background:#1d4ed8}
input{width:100%;margin:8px 0 14px}details{border:1px solid #374151;border-radius:6px;margin:7px 0;padding:7px 10px;background:#1f2937}
details details{background:#111827}summary{cursor:pointer;font-weight:600}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#030712;padding:10px;border-radius:5px;color:#d1d5db}
.muted{color:#9ca3af}.bad{color:#fca5a5}.row{display:flex;gap:12px;align-items:center}.row button{width:auto}
</style></head><body><aside><h1>Session Log</h1><div id="sessions"></div></aside>
<main><div class="row"><h1 id="title">选择 Session</h1><button id="refresh">刷新</button></div>
<div class="muted" id="meta"></div><input id="filter" placeholder="筛选实体 ID 或事件类型"><div id="content"></div></main>
<script>
const sessions=document.getElementById('sessions'),content=document.getElementById('content'),title=document.getElementById('title');
const filter=document.getElementById('filter'),meta=document.getElementById('meta');
const params=new URLSearchParams(location.search);let selected=params.get('session'),focusedTurn=Number(params.get('turn')),lastSequence=-1;
function node(tag,text,cls){const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n}
const openStates=new Map();
function detail(label,parent,open=false,key=label){const d=document.createElement('details');
  const stateKey=selected+':'+key;d.open=openStates.get(stateKey)??open;
  d.addEventListener('toggle',()=>openStates.set(stateKey,d.open));d.append(node('summary',label));parent.append(d);return d}
function stageOf(e){if(e.kind==='stage')return e.data?.stage||'stage';
  if(e.kind==='cognitive-barrier')return 'cognitive-barrier';
  if(e.kind==='perception-result')return 'perception';if(e.kind==='memory-admission'||e.kind==='memory-consumption')return 'memory';
  if(e.kind.startsWith('cognition-')||e.kind.startsWith('llm-')||e.kind==='player-decision')return 'cognition';
  if(e.kind==='cognitive-demands')return 'cognitive-demand';if(e.kind==='plan-acceptance')return 'fixed / handoff';
  if(e.kind==='world-adjudication')return 'adjudicate';if(e.kind==='propagation-result')return 'propagate';
  if(e.kind==='advance-result')return 'advance';if(e.kind==='behaviour-result')return 'decide';return 'other'}
const order=['fixed','clock','advance','decide','adjudicate','propagate','stability','perception','cognitive-demand','cognitive-barrier','cognition','memory','fixed / handoff','publish','other'];
function eventView(e,parent){const name=e.kind+(e.requestId?' · '+e.requestId.split('/').at(-1):'');const d=detail(name,parent,false,'event:'+e.sequence);
  d.append(node('pre',JSON.stringify(e.data,null,2)));}
function render(rows){content.replaceChildren();const globals=rows.filter(e=>e.turn===null),turns=new Map();
  for(const e of rows){if(e.turn===null)continue;if(!turns.has(e.turn))turns.set(e.turn,[]);turns.get(e.turn).push(e)}
  if(globals.length){const box=detail('Session 事件',content,false,'session');for(const e of globals)eventView(e,box)}
  for(const [turn,events] of [...turns].reverse()){const start=events.find(e=>e.kind==='turn-start');const end=events.find(e=>e.kind==='turn-end');
    const box=detail('Turn '+turn+' · '+(start?.timelineId||'')+' · Tick '+(start?.targetTick??'?')+' · '+(end?.data?.status||'运行中'),content,focusedTurn?turn===focusedTurn:turn===Math.max(...turns.keys()),'turn:'+turn);
    const stages=new Map();for(const e of events){const stage=stageOf(e);if(!stages.has(stage))stages.set(stage,[]);stages.get(stage).push(e)}
    for(const stage of [...stages.keys()].sort((a,b)=>order.indexOf(a)-order.indexOf(b))){const stageBox=detail(stage+' · '+stages.get(stage).length,box,false,'stage:'+turn+':'+stage);
      const entities=new Map();for(const e of stages.get(stage)){const id=e.entityId||'全局';if(!entities.has(id))entities.set(id,[]);entities.get(id).push(e)}
      for(const [id,items] of entities){const entityBox=detail(id+' · '+items.length,stageBox,false,'entity:'+turn+':'+stage+':'+id);
        if(stage==='cognition'){
          const attempts=new Map();for(const e of items){const key=e.requestId||'其他';if(!attempts.has(key))attempts.set(key,[]);attempts.get(key).push(e)}
          for(const [requestId,events] of attempts){const attemptBox=detail(requestId==='其他'?'轮次结果':requestId.split('/').at(-1),entityBox,false,'attempt:'+requestId+':'+turn);
            for(const e of events)eventView(e,attemptBox)}
        }else for(const e of items)eventView(e,entityBox)}}}
}
async function load(force=false){if(!selected)return;const response=await fetch('/api/session/'+encodeURIComponent(selected));if(!response.ok)throw Error(await response.text());
  const rows=await response.json(),latest=rows.at(-1)?.sequence??0;if(!force&&latest===lastSequence)return;lastSequence=latest;
  title.textContent=selected;meta.textContent=rows.length+' 条记录 · 自动刷新';
  const query=filter.value.trim().toLowerCase();render(query?rows.filter(e=>e.kind==='turn-start'||e.kind==='turn-end'||JSON.stringify(e).toLowerCase().includes(query)):rows)}
async function list(){const response=await fetch('/api/sessions');const files=await response.json();if(!files.includes(selected)&&files.length)selected=files[0];sessions.replaceChildren();
  for(const file of files){const b=node('button',file,file===selected?'active':'');b.onclick=()=>{selected=file;focusedTurn=0;lastSequence=-1;list()};sessions.append(b)}
  if(selected)await load(true)}
document.getElementById('refresh').onclick=()=>load(true);filter.oninput=()=>load(true);
list().catch(e=>content.append(node('pre',String(e),'bad')));setInterval(()=>load().catch(e=>{meta.textContent=String(e)}),1500);
</script></body></html>`;

/** A read-only browser for files created by this TUI, bound to loopback only. */
export class SessionInspector {
  private server: Server | undefined;
  private url: string | undefined;

  constructor(private readonly directory: string) {}

  sessions(): readonly string[] {
    try {
      return readdirSync(this.directory)
        .filter((name) => name.endsWith(".jsonl"))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  entries(name: string): readonly SessionLogEntry[] {
    if (name !== basename(name) || !/^[A-Za-z0-9._-]+\.jsonl$/.test(name)) throw new Error("Invalid session name");
    return readFileSync(join(this.directory, name), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as SessionLogEntry];
        } catch {
          return [];
        }
      });
  }

  async open(launch = true, selection?: { readonly session: string; readonly turn: number }): Promise<string> {
    if (this.url === undefined) {
      this.server = createServer((request, response) => this.handle(request.url ?? "/", response));
      await new Promise<void>((resolve, reject) => {
        this.server?.once("error", reject);
        this.server?.listen(0, "127.0.0.1", resolve);
      });
      const address = this.server.address();
      if (address === null || typeof address === "string") throw new Error("无法启动日志审视页");
      this.url = `http://127.0.0.1:${address.port}/`;
    }
    const destination = new URL(this.url);
    if (selection !== undefined) {
      if (!this.sessions().includes(selection.session)) throw new Error("找不到选中的 Session Log");
      destination.searchParams.set("session", selection.session);
      destination.searchParams.set("turn", String(selection.turn));
    }
    if (launch) this.launchBrowser(destination.href);
    return destination.href;
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
    this.url = undefined;
  }

  private handle(url: string, response: import("node:http").ServerResponse): void {
    const pathname = new URL(url, "http://127.0.0.1").pathname;
    if (pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(PAGE);
      return;
    }
    if (pathname === "/api/sessions") {
      this.json(response, this.sessions());
      return;
    }
    if (pathname.startsWith("/api/session/")) {
      const name = decodeURIComponent(pathname.slice("/api/session/".length));
      try {
        this.json(response, this.entries(name));
      } catch {
        response.writeHead(404).end("Session not found");
      }
      return;
    }
    response.writeHead(404).end("Not found");
  }

  private json(response: import("node:http").ServerResponse, data: unknown): void {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(data));
  }

  private launchBrowser(url: string): void {
    const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.on("error", () => {});
      child.unref();
    } catch {
      // The URL is still shown in the TUI if no default browser is available.
    }
  }
}
