/**
 * 三档程序卡运行时垫片（对照酒馆助手 JS-Slash-Runner 公开调用面的最小子集）。
 *
 * 设计纪律（docs card-frontend §6/§8）：
 * - 读族/存在性：先给桩，保证卡初始化不炸
 * - 生成族 / 斜杠：可接到梨园聊天总线（App 注册 bridge）
 * - 写正文：不提供
 *
 * 卡实际调用面：
 * - parent.TavernHelper.generate / stopAllGeneration
 * - triggerSlash(`/send …|/trigger`)  ← 某卡 开场表单
 * - eventOn / eventEmit
 * - parent.TheaterAPI / handleTheaterAction
 */

export type TavernGenerateParams = {
	user_input?: string;
	should_stream?: boolean;
	disable_extras?: boolean;
	[k: string]: unknown;
};

/** App 注册：把卡侧 slash / generate 接到输入框与 WS prompt */
export type TavernChatBridge = {
	/** 只填输入框，不发送 */
	setInput: (text: string) => void;
	/** 作为用户消息发送并触发生成（空串 = 发送当前输入框内容） */
	sendPrompt: (text: string) => void;
	/** 可选：执行梨园斜杠命令原文（如 /rewind） */
	runCommand?: (text: string) => void;
};

type BusMap = Map<string, Set<(...args: unknown[]) => void>>;

let chatBridge: TavernChatBridge | null = null;

export function registerTavernChatBridge(bridge: TavernChatBridge | null): void {
	chatBridge = bridge;
}

export function getTavernChatBridge(): TavernChatBridge | null {
	return chatBridge;
}

function getBus(target: object): BusMap {
	const w = target as { __liyuanEventBus?: BusMap };
	if (!w.__liyuanEventBus) w.__liyuanEventBus = new Map();
	return w.__liyuanEventBus;
}

/** 挂 eventOn / eventEmit（iframe 内与父页各一份即可） */
export function installEventBus(target: object = typeof window !== "undefined" ? window : {}): void {
	const t = target as {
		eventOn?: (name: string, cb: (...args: unknown[]) => void) => void;
		eventEmit?: (name: string, ...args: unknown[]) => void;
	};
	if (typeof t.eventOn === "function" && typeof t.eventEmit === "function") return;

	const bus = getBus(target);
	t.eventOn = (name, cb) => {
		if (!bus.has(name)) bus.set(name, new Set());
		bus.get(name)!.add(cb);
	};
	t.eventEmit = (name, ...args) => {
		const set = bus.get(name);
		if (!set) return;
		for (const cb of set) {
			try {
				cb(...args);
			} catch (e) {
				console.error("[liyuan eventEmit]", name, e);
			}
		}
	};
}

/**
 * 解析酒馆式管道斜杠：`/send 文本|/trigger`
 * 分段以 `|` 分隔（ST STscript 同款）。
 */
export function parseSlashPipeline(raw: string): string[] {
	return String(raw ?? "")
		.split("|")
		.map((s) => s.trim())
		.filter(Boolean);
}

export type SlashExecResult = {
	ok: boolean;
	/** 已填入输入框或已发送的正文 */
	text?: string;
	/** 是否触发了生成 */
	triggered?: boolean;
	/** 仅填入输入框未发送 */
	filledOnly?: boolean;
	error?: string;
};

/**
 * 执行 triggerSlash 命令串（纯逻辑，可测）。
 * 支持：/send、/trigger，以及二者管道组合。
 */
export function executeTriggerSlash(
	raw: string,
	bridge: TavernChatBridge | null,
): SlashExecResult {
	if (!bridge) {
		return { ok: false, error: "聊天桥未就绪（App 未注册 TavernChatBridge）" };
	}
	const parts = parseSlashPipeline(raw);
	if (!parts.length) return { ok: false, error: "空命令" };

	let pendingSend = "";
	let wantTrigger = false;
	let filledOnly = false;

	for (const part of parts) {
		const cmd = part.startsWith("/") ? part : `/${part}`;
		const mSend = cmd.match(/^\/send(?:as)?(?:\s+name=[^\s]+)?\s*([\s\S]*)$/i);
		if (mSend) {
			pendingSend = (mSend[1] ?? "").trim();
			continue;
		}
		if (/^\/trigger\b/i.test(cmd)) {
			wantTrigger = true;
			continue;
		}
		// 其它斜杠：尽量当梨园命令
		if (cmd.startsWith("/") && bridge.runCommand) {
			try {
				bridge.runCommand(cmd);
			} catch (e) {
				console.warn("[liyuan triggerSlash] runCommand", cmd, e);
			}
			continue;
		}
		console.warn("[liyuan triggerSlash] 未识别命令", cmd);
	}

	if (wantTrigger) {
		// /send X|/trigger → 直接发 X 并生成；仅 /trigger → 发当前输入框
		const text = pendingSend;
		try {
			bridge.sendPrompt(text);
			return { ok: true, text, triggered: true };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	if (pendingSend) {
		try {
			bridge.setInput(pendingSend);
			filledOnly = true;
			return { ok: true, text: pendingSend, filledOnly };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	return { ok: true };
}

/** 父页全局 triggerSlash（iframe 通过 parent 或 postMessage 调用） */
export async function triggerSlash(raw: string): Promise<string> {
	const r = executeTriggerSlash(raw, chatBridge);
	if (!r.ok) {
		console.warn("[liyuan triggerSlash]", r.error, raw?.slice?.(0, 80));
		return r.error || "";
	}
	return r.text || "";
}

/** 父页安装：卡脚本通过 window.parent.TavernHelper / triggerSlash 访问 */
export function installParentTavernShim(): void {
	if (typeof window === "undefined") return;
	const w = window as Window & {
		__liyuanTavernShimInstalled?: boolean;
		TavernHelper?: {
			generate: (params?: TavernGenerateParams) => Promise<string>;
			stopAllGeneration: () => void;
		};
		TheaterAPI?: { call: (method: string, ...args: unknown[]) => Promise<unknown> };
		handleTheaterAction?: (msg: unknown) => void;
		triggerSlash?: (cmd: string) => Promise<string> | string;
	};
	if (w.__liyuanTavernShimInstalled) return;
	w.__liyuanTavernShimInstalled = true;

	installEventBus(w);

	w.triggerSlash = (cmd: string) => triggerSlash(cmd);

	// iframe 无 same-origin 时走 postMessage（测试桩可能没有 addEventListener）
	if (typeof window.addEventListener === "function") {
		window.addEventListener("message", (ev: MessageEvent) => {
			const d = ev.data as { liyuanTriggerSlash?: unknown } | null;
			if (!d || typeof d.liyuanTriggerSlash !== "string") return;
			void triggerSlash(d.liyuanTriggerSlash);
		});
	}

	w.TavernHelper = {
		/**
		 * 对照卡内：await generate({ user_input, should_stream }) → string
		 * 已注册 bridge 时：把 user_input 当用户发言并触发生成。
		 */
		async generate(params) {
			const input = String(params?.user_input ?? "").trim();
			if (chatBridge && input) {
				try {
					chatBridge.sendPrompt(input);
					return input;
				} catch (e) {
					console.warn("[liyuan TavernHelper.generate]", e);
				}
			}
			console.warn("[liyuan TavernHelper.generate] 无 bridge 或空输入", {
				len: input.length,
				stream: params?.should_stream,
			});
			return `（梨园：界面内 AI 生成未接入聊天桥。输入：${input.slice(0, 80) || "（空）"}）`;
		},
		stopAllGeneration() {
			console.warn("[liyuan TavernHelper.stopAllGeneration] no-op");
		},
	};

	w.TheaterAPI = {
		async call(method, ...args) {
			console.warn("[liyuan TheaterAPI.call]", method, args?.length ?? 0);
			return null;
		},
	};

	w.handleTheaterAction = (msg) => {
		console.warn("[liyuan handleTheaterAction]", msg);
	};
}

/**
 * 注入到脚本帧 head 最前：同源下挂 TavernHelper + triggerSlash；
 * 并尽量镜像 parent（双保险）；跨域则 postMessage。
 */
export const IFRAME_TAVERN_BRIDGE_SNIPPET = `<script>(function(){
try{
  var g=typeof window!=="undefined"?window:null;if(!g)return;
  function bus(){if(!g.__liyuanEventBus)g.__liyuanEventBus=new Map();return g.__liyuanEventBus;}
  if(typeof g.eventOn!=="function"){
    g.eventOn=function(name,cb){var b=bus();if(!b.has(name))b.set(name,new Set());b.get(name).add(cb);};
  }
  if(typeof g.eventEmit!=="function"){
    g.eventEmit=function(name){var args=[].slice.call(arguments,1),b=bus(),s=b.get(name);if(!s)return;
      s.forEach(function(cb){try{cb.apply(null,args);}catch(e){console.error(e);}});};
  }
  function parentWin(){try{return g.parent&&g.parent!==g?g.parent:null;}catch(e){return null;}}
  function parentTH(){var p=parentWin();return p&&p.TavernHelper?p.TavernHelper:null;}
  if(typeof g.triggerSlash!=="function"){
    g.triggerSlash=function(cmd){
      var p=parentWin();
      try{
        if(p&&typeof p.triggerSlash==="function"){
          var r=p.triggerSlash(cmd);
          return r&&typeof r.then==="function"?r:Promise.resolve(r);
        }
      }catch(e){}
      try{if(p)p.postMessage({liyuanTriggerSlash:String(cmd||"")},"*");}catch(e2){}
      return Promise.resolve("");
    };
  }
  if(!g.TavernHelper){
    g.TavernHelper={
      generate:function(params){
        var p=parentTH();
        if(p&&typeof p.generate==="function")return p.generate(params);
        console.warn("[liyuan iframe] TavernHelper.generate stub");
        var u=(params&&params.user_input)||"";
        return Promise.resolve("（梨园：界面内 AI 生成尚未接入）"+String(u).slice(0,80));
      },
      stopAllGeneration:function(){
        var p=parentTH();
        if(p&&typeof p.stopAllGeneration==="function")return p.stopAllGeneration();
      }
    };
  }
  try{
    if(g.parent&&g.parent.TheaterAPI)g.TheaterAPI=g.parent.TheaterAPI;
    else if(!g.TheaterAPI)g.TheaterAPI={call:function(){return Promise.resolve(null);}};
  }catch(e){}
  try{
    if(g.parent&&typeof g.parent.handleTheaterAction==="function"){
      g.handleTheaterAction=function(m){return g.parent.handleTheaterAction(m);};
    }
  }catch(e){}
}catch(e){console.error("[liyuan bridge]",e);}
})();</script>`;

import { JQUERY_MIN } from "./vendor/jquery-min.ts";

/**
 * 酒馆全局垫片（脚本帧专用，注入在 bridge 之后、卡脚本之前）。
 *
 * 酒馆页面内置 jQuery/lodash/变量系统/MVU 插件对象，卡界面脚本直接裸用这些全局
 * （模拟修仙2 状态栏 UI 30 处 `$`、`_.get`、`getAllVariables()`、`Mvu`/`eventOn`）——
 * 梨园 srcdoc 沙箱里没有这些，脚本第一行就 ReferenceError，按钮事件永远绑不上
 * （8/05 实弹：状态栏出来了但页签全点不动）。
 *
 * 垫片面（对照酒馆公开调用面）：
 * - `$`/`jQuery`：完整 jQuery 3.7.1（离线内置，MIT）
 * - `_`：lodash 常用子集（get/set/has/each/isArray/isObject/escape 等，按需扩充）
 * - `getAllVariables()`：酒馆变量系统 → 梨园侧变量 JSON（默认空壳 `{stat_data:{}}`，
 *   父页可 postMessage {liyuanVariables} 注入——后续接梨园账本）
 * - `Mvu`：MVU 插件对象壳（事件常量 + 空事件总线，数据刷新联动后置）
 * - `waitGlobalInitialized(name)`：酒馆等待全局就绪 → 目标已存在立即 resolve
 */
export const IFRAME_TAVERN_GLOBALS_SNIPPET = `<script>(function(){
var g=typeof window!=="undefined"?window:null;if(!g)return;
try{
  if(typeof g.jQuery!=="function"){
    ${JQUERY_MIN}
  }
  if(!g._||typeof g._!=="object"){
    function lp(obj,path){if(path==null)return obj;if(!Array.isArray(path))path=String(path).split(".");var o=obj;for(var i=0;i<path.length;i++){if(o==null)return undefined;o=o[path[i]];}return o;}
    g._={
      get:function(obj,path,def){var v=lp(obj,path);return v===undefined?def:v;},
      set:function(obj,path,val){if(path==null)return obj;if(!Array.isArray(path))path=String(path).split(".");var o=obj;for(var i=0;i<path.length-1;i++){if(o[path[i]]==null||typeof o[path[i]]!=="object")o[path[i]]={};o=o[path[i]];}o[path[path.length-1]]=val;return obj;},
      has:function(obj,path){return lp(obj,path)!==undefined;},
      each:function(coll,fn){if(Array.isArray(coll)){for(var i=0;i<coll.length;i++){if(fn(coll[i],i)===false)break;}}else{for(var k in coll){if(Object.prototype.hasOwnProperty.call(coll,k)){if(fn(coll[k],k)===false)break;}}}return coll;},
      forEach:function(coll,fn){return g._.each(coll,fn);},
      isArray:function(v){return Array.isArray(v);},
      isObject:function(v){return v!=null&&typeof v==="object"&&!Array.isArray(v);},
      isString:function(v){return typeof v==="string";},
      isNumber:function(v){return typeof v==="number"&&isFinite(v);},
      isBoolean:function(v){return typeof v==="boolean";},
      isFunction:function(v){return typeof v==="function";},
      isEmpty:function(v){if(v==null)return true;if(Array.isArray(v)||typeof v==="string")return v.length===0;if(typeof v==="object")return Object.keys(v).length===0;return false;},
      escape:function(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});},
      unescape:function(s){return String(s==null?"":s).replace(/&(?:amp|lt|gt|quot|#39);/g,function(m){return {"&amp;":"&","&lt;":"<","&gt;":">","&quot;":'"',"&#39;":"'"}[m];});},
      clone:function(v){if(v==null||typeof v!=="object")return v;return JSON.parse(JSON.stringify(v));},
      debounce:function(fn,wait){var t=null;return function(){var a=arguments,c=this;clearTimeout(t);t=setTimeout(function(){fn.apply(c,a);},wait||100);};},
      now:function(){return Date.now();}
    };
  }
  if(typeof g.getAllVariables!=="function"){
    g.getAllVariables=function(){var v=g.__liyuanVariables||null;return v&&typeof v==="object"?v:{stat_data:{}};};
  }
  if(!g.Mvu){
    g.Mvu={
      isMvuEnabled:true,
      events:{
        VARIABLE_UPDATE_STARTED:"VARIABLE_UPDATE_STARTED",
        VARIABLE_UPDATE_ENDED:"VARIABLE_UPDATE_ENDED",
        VARIABLE_UPDATE_FAILED:"VARIABLE_UPDATE_FAILED"
      },
      state:{}
    };
  }
  if(typeof g.waitGlobalInitialized!=="function"){
    g.waitGlobalInitialized=function(name,timeoutMs){
      return new Promise(function(res){
        var t0=Date.now(),lim=timeoutMs||5000;
        (function poll(){
          try{if(g[name])return res(true);}catch(e){return res(false);}
          if(Date.now()-t0>lim)return res(false);
          setTimeout(poll,50);
        })();
      });
    };
  }
}catch(e){console.error("[liyuan globals]",e);}
})();</script>`;
