/** srcdoc 组装(纯函数,供 HtmlFrame 与测试):seamless 模式样式主权让位给卡(spec §4) */

import { IFRAME_TAVERN_BRIDGE_SNIPPET, IFRAME_TAVERN_GLOBALS_SNIPPET } from "./tavernShim.ts";

/** 程序卡默认高度：约 78vh，夹在 480–2400（fixed 全屏 UI 不能靠内容盒量高） */
export function programViewportHeight(win?: { innerHeight: number } | null): number {
	const vh = win && typeof win.innerHeight === "number" ? win.innerHeight : 800;
	return Math.max(480, Math.min(2400, Math.floor(vh * 0.78)));
}

/**
 * html/body 根级 CSS 是否「视口接管」：同时声明 overflow:hidden 与 height:100%/100*vh。
 * 只认 html/body 选择器块（含 JS 模板串里的，某卡整页在模板串内）；
 * min-height:100vh 不算——那是「至少一屏」的内容流写法，正需要量高覆盖。
 */
function hasRootViewportCss(html: string): boolean {
	const blocks = html.match(/(?:^|[\s,{}>;"'`])(?:html|body)\s*(?:,\s*(?:html|body)\s*)?\{[^{}]*\}/gi);
	if (!blocks) return false;
	const joined = blocks.join(" ");
	return (
		/overflow(?:-y)?\s*:\s*hidden/i.test(joined) && /(?<!min-)height\s*:\s*100(?:%|[dsl]?vh)/i.test(joined)
	);
}

/**
 * 是否「视口接管型程序卡」（某卡主 UI、某卡开局创建器等）——iframe 须锁视口高，
 * 且 **不得** 注入 height:auto/overflow 覆盖、不注入高度上报（见 buildSrcDoc）。
 *
 * **不要**按体积一刀切：某卡 MVU 状态栏 182KB / XML 状态栏 88KB 都是完整 HTML+JS，
 * 却是透明内容流（零 vh、根级无接管 CSS）；按体积锁 78vh 就是「大块黑空 + 抖动」事故本身。
 * 某卡 状态栏（~11KB doctype+script，折叠态 ~200px）同理。
 *
 * 判定（满足其一，均要求 scripts）：
 * - 根级接管 CSS：html/body 同时 overflow:hidden + height:100%（某卡「开局创造角色」126KB 无 fixed，全靠这条）
 * - fixed 铺满 + 视口单位：position:fixed 与 100vh/100dvh 并存（body 内联样式等根级 CSS 缺席的形态）
 */
export function looksLikeProgramApp(html: string, scripts: boolean): boolean {
	if (!scripts || !html) return false;
	if (!/<script[\s>]/i.test(html)) return false;
	if (hasRootViewportCss(html)) return true;
	// fixed 铺满判定：要求 fixed 与 100vh 在同一样式块内（真全屏 UI），
	// 而非文档任意两处各出现一次（某卡欢迎卡有 fixed 装饰 + 某处 100vh，但整体是内容流）
	if (/\bposition\s*:\s*fixed[^}]*100[dsl]?vh|\b100[dsl]?vh[^}]*position\s*:\s*fixed/i.test(html)) return true;
	return false;
}

const LEGACY_BASE_CSS =
	`html,body{margin:0;padding:0;background:transparent;color:#3f3f3f;` +
	`font:13.5px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Noto Sans SC","Segoe UI",sans-serif}` +
	`img,video{max-width:100%;height:auto}` +
	`* {box-sizing:border-box}`;

/**
 * 无痕·片段(状态栏 div 等):透明底 + **保留换行**(纯文本字段一行一项)。
 * 整页文档不可用 pre-wrap，否则 某卡 等 flex/绝对布局会被毁掉。
 */
const SEAMLESS_FRAGMENT_CSS =
	`html,body{margin:0;padding:0;background:transparent;` +
	`white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word}` +
	`img,video{max-width:100%;height:auto;vertical-align:middle}`;

/**
 * 无痕·整页文档:透明兜底。
 * **禁止**让 html/body 吃满 100vh——iframe 量高时 100vh 会跟着父高涨，形成白底无限向下扩的反馈环。
 * 仅用于**内容流**文档；视口接管型（looksLikeProgramApp）绝不可注入：
 * height:auto!important 会打断卡自己的 height:100% 链 → 容器全塌陷只剩 fixed 层（某卡开局创建器事故）。
 */
const SEAMLESS_DOC_CSS =
	`html,body{margin:0;padding:0;background:transparent;` +
	`min-height:0!important;height:auto!important;overflow:visible!important}` +
	`img,video{max-width:100%;height:auto}`;

/**
 * 视口接管型整页文档:只给透明兜底，样式主权完全归卡——
 * iframe 高度由父页按视口锁定（programViewportHeight），不量内容，无需也不能改 height/overflow。
 */
const TAKEOVER_DOC_CSS =
	`html,body{margin:0;padding:0;background:transparent}` + `img,video{max-width:100%;height:auto}`;

/**
 * 高度上报：量「内容盒子」而不是 documentElement.scrollHeight。
 * 后者在 min-height:100vh / height:100% 时会跟着 iframe 外高一起涨（每轮 +4px 白边）。
 * 只报 body 直接子元素的底部；忽略 script/style；稳定后不再 setInterval 狂刷。
 */
export const HEIGHT_REPORTER_SNIPPET =
	`<script>(function(){` +
	`var last=0,stable=0;` +
	`function contentH(){` +
	`var b=document.body;if(!b)return 0;` +
	`var h=0,kids=b.children;` +
	`for(var i=0;i<kids.length;i++){` +
	`var el=kids[i],tag=el.tagName;` +
	`if(tag==="SCRIPT"||tag==="STYLE"||tag==="LINK"||tag==="META")continue;` +
	`var r=el.getBoundingClientRect();` +
	`var bottom=Math.ceil(r.bottom+(window.scrollY||window.pageYOffset||0));` +
	`var oh=el.offsetTop+el.offsetHeight;` +
	`h=Math.max(h,bottom,oh);` +
	`}` +
	`/* 无可见子节点时退回 offsetHeight，仍避免 documentElement 的 100vh */` +
	`if(h<1)h=b.offsetHeight||0;` +
	`return h;` +
	`}` +
	`function post(){` +
	`var h=contentH();` +
	`if(h<1)return;` +
	`if(h===last){stable++;return;}` +
	`last=h;stable=0;` +
	`parent.postMessage({liyuanFrameHeight:h,frameId:window.name},"*");` +
	`}` +
	`if(typeof ResizeObserver!=="undefined"){` +
	`try{new ResizeObserver(post).observe(document.body);` +
	`var kids=document.body?document.body.children:[];` +
	`for(var i=0;i<kids.length;i++){` +
	`var t=kids[i].tagName;if(t==="SCRIPT"||t==="STYLE")continue;` +
	`try{new ResizeObserver(post).observe(kids[i]);}catch(e){}}` +
	`}catch(e){}` +
	`}` +
	`window.addEventListener("load",post);` +
	`/* 前几秒兜底轮询，之后停掉，避免反馈环长期抖动 */` +
	`var n=0,iv=setInterval(function(){post();if(++n>8||stable>3)clearInterval(iv);},400);` +
	`setTimeout(post,0);setTimeout(post,100);setTimeout(post,300);` +
	`})();</script>`;

/**
 * 在脚本正文中找「真正的」</script> 结束位置。
 * 跳过 JS 字符串/模板/注释里的字面量 `</script`（某卡把整页 HTML 塞进模板字符串，
 * 内含 `</script></body></html>`，HTML 解析器会在此截断 → 主脚本只剩 ~36KB → 按钮无监听）。
 */
export function findScriptCloseIndex(html: string, bodyStart: number): number {
	let i = bodyStart;
	type St = "code" | "s" | "d" | "t" | "line" | "block";
	let state: St = "code";
	let escape = false;
	/** template 字面量里 ${...} 的花括号深度；>0 表示仍在表达式中 */
	const exprDepth: number[] = [];

	while (i < html.length) {
		const c = html[i];
		const n = html[i + 1];

		if (state === "line") {
			if (c === "\n" || c === "\r") state = "code";
			i++;
			continue;
		}
		if (state === "block") {
			if (c === "*" && n === "/") {
				state = "code";
				i += 2;
				continue;
			}
			i++;
			continue;
		}

		if (state === "s" || state === "d" || state === "t") {
			if (escape) {
				escape = false;
				i++;
				continue;
			}
			if (c === "\\") {
				escape = true;
				i++;
				continue;
			}
			if (state === "s" && c === "'") {
				state = "code";
				i++;
				continue;
			}
			if (state === "d" && c === '"') {
				state = "code";
				i++;
				continue;
			}
			if (state === "t") {
				if (c === "`") {
					state = "code";
					i++;
					continue;
				}
				if (c === "$" && n === "{") {
					exprDepth.push(1);
					state = "code";
					i += 2;
					continue;
				}
			}
			i++;
			continue;
		}

		// code
		if (c === "/" && n === "/") {
			state = "line";
			i += 2;
			continue;
		}
		if (c === "/" && n === "*") {
			state = "block";
			i += 2;
			continue;
		}
		if (c === "'") {
			state = "s";
			escape = false;
			i++;
			continue;
		}
		if (c === '"') {
			state = "d";
			escape = false;
			i++;
			continue;
		}
		if (c === "`") {
			state = "t";
			escape = false;
			i++;
			continue;
		}
		if (exprDepth.length > 0) {
			if (c === "{") {
				exprDepth[exprDepth.length - 1]!++;
				i++;
				continue;
			}
			if (c === "}") {
				exprDepth[exprDepth.length - 1]!--;
				if (exprDepth[exprDepth.length - 1] === 0) {
					exprDepth.pop();
					state = "t";
				}
				i++;
				continue;
			}
		}
		// 仅在顶层 code（非 template 表达式）认真正的闭合标签
		if (exprDepth.length === 0 && c === "<" && /^<\/script/i.test(html.slice(i))) {
			return i;
		}
		i++;
	}
	return -1;
}

/**
 * 仅转义 **脚本正文** 内的 `</script` → `<\/script`，真实闭合标签不动。
 * 必须在拼我们自己的 bridge/height 垫片 **之前** 对用户 HTML 调用。
 */
export function escapeScriptEndTags(html: string): string {
	const openRe = /<script(\s[^>]*)?>/gi;
	let out = "";
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = openRe.exec(html)) !== null) {
		// 跳过已处理区间内的「脚本串里的 <script」假开口
		if (m.index < last) continue;
		const openEnd = m.index + m[0].length;
		out += html.slice(last, openEnd);
		let closeAt = findScriptCloseIndex(html, openEnd);
		// 状态机失败时：退回「本段最后一个 </script」（整页程序卡常见）
		if (closeAt < 0) {
			const rest = html.toLowerCase();
			const fallback = rest.lastIndexOf("</script");
			closeAt = fallback >= openEnd ? fallback : -1;
		}
		if (closeAt < 0) {
			out += html.slice(openEnd).replace(/<\/script/gi, "<\\/script");
			return out;
		}
		const body = html.slice(openEnd, closeAt);
		out += body.replace(/<\/script/gi, "<\\/script");
		last = closeAt;
		openRe.lastIndex = closeAt;
	}
	out += html.slice(last);
	return out;
}

export function buildSrcDoc(html: string, scripts: boolean, seamless: boolean): string {
	// 先修用户 HTML 内脚本截断，再注入带真实 </script> 的垫片
	const trimmed = escapeScriptEndTags(html.trim());
	const isFull = /^\s*<(!doctype|html[\s>])/i.test(trimmed);
	// 与 HtmlFrame 的高度策略同源：同一函数、同一入参，保证 CSS 注入与定高策略永不打架
	const takeover = seamless && looksLikeProgramApp(html, scripts);
	// 程序卡需拉 CDN(dexie/echarts 等) + 内联脚本；connect 放宽到 https
	const csp = scripts
		? `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: http: data: blob:; style-src 'unsafe-inline' https: http: data:; img-src data: blob: https: http:; font-src data: https: http:; media-src data: blob: https: http:; connect-src https: http: ws: wss: data: blob:; worker-src blob: data:; frame-src 'none'`
		: `default-src 'none'; style-src 'unsafe-inline' https: http: data:; img-src data: blob: https: http:; font-src data: https: http:; media-src data: blob: https: http:`;
	const seamlessCss = isFull ? (takeover ? TAKEOVER_DOC_CSS : SEAMLESS_DOC_CSS) : SEAMLESS_FRAGMENT_CSS;
	// 脚本帧：垫片桥必须先于卡脚本，保证 eventOn / TavernHelper / jQuery / 变量系统在初始化时已存在
	const bridge = scripts ? IFRAME_TAVERN_BRIDGE_SNIPPET + IFRAME_TAVERN_GLOBALS_SNIPPET : "";
	const head =
		`<meta charset="utf-8">` +
		`<meta http-equiv="Content-Security-Policy" content="${csp}">` +
		`<style>${seamless ? seamlessCss : LEGACY_BASE_CSS}</style>` +
		bridge;
	// 高度：脚本+seamless 用 postMessage；接管型不上报——父页锁视口高不收内容量高，
	// 上报器与卡内 ResizeObserver 互踩正是「收拢/涨高」乒乓抖动的源头
	const tail = scripts && seamless && !takeover ? HEIGHT_REPORTER_SNIPPET : "";
	if (isFull) {
		let withHead: string;
		if (/<head[\s>]/i.test(trimmed)) {
			// 只改第一个 <head>（文档真 head；脚本字符串里的 <head> 通常更靠后）
			withHead = trimmed.replace(/<head([^>]*)>/i, `<head$1>${head}`);
		} else if (/<html[\s>]/i.test(trimmed)) {
			// 缺 head 时插入，保证 CSP/量高用 CSS（含打断 100vh）能生效
			withHead = trimmed.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`);
		} else {
			withHead = `<!doctype html><html><head>${head}</head><body>${trimmed}</body></html>`;
		}
		// 高度脚本必须插在**最后一个** </body> 前。
		// 某卡主脚本模板里有 `</body></html>` 字符串；replace 第一个会把
		// <script>height...</script> 插进 JS 模板 → 主脚本在 ~36KB 被截断 → 按钮无监听。
		if (tail) {
			const lower = withHead.toLowerCase();
			const lastBody = lower.lastIndexOf("</body>");
			if (lastBody >= 0) {
				return withHead.slice(0, lastBody) + tail + withHead.slice(lastBody);
			}
			return withHead + tail;
		}
		return withHead;
	}
	return `<!doctype html><html><head>${head}</head><body>${trimmed}${tail}</body></html>`;
}
