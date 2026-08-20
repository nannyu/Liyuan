import assert from "node:assert/strict";
import test from "node:test";
import { isFullInterface, looksLikeHtmlDocument, splitHtmlParts } from "../web/src/htmlEmbed.ts";

test("splitHtmlParts: plain text", () => {
	const p = splitHtmlParts("hello\n\nworld");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
});

test("splitHtmlParts: fenced html", () => {
	const p = splitHtmlParts('前\n```html\n<div class="phone">hi</div>\n```\n后');
	assert.equal(p.length, 3);
	assert.equal(p[0].kind, "text");
	assert.equal(p[1].kind, "html");
	if (p[1].kind === "html") {
		assert.ok(p[1].html.includes("phone"));
		assert.equal(p[1].scripts, false);
	}
	assert.equal(p[2].kind, "text");
});

test("splitHtmlParts: scripts fence", () => {
	const p = splitHtmlParts("```html scripts\n<script>1</script>\n```");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "html");
	if (p[0].kind === "html") assert.equal(p[0].scripts, true);
});

test("looksLikeHtmlDocument", () => {
	assert.equal(looksLikeHtmlDocument("<!DOCTYPE html><html></html>"), true);
	assert.equal(looksLikeHtmlDocument("not html"), false);
});

test("splitHtmlParts: 正文中的顶层 <div> 块切为 html 段(皮肤产物形态)", () => {
	const text = '雨停了。\n<div style="x">\n<status>\nHP: 80\n</status>\n</div>\n她抬头。';
	const p = splitHtmlParts(text);
	assert.equal(p.length, 3);
	assert.equal(p[0].kind, "text");
	assert.equal(p[1].kind, "html");
	if (p[1].kind === "html") {
		assert.ok(p[1].html.startsWith("<div"));
		assert.ok(p[1].html.endsWith("</div>"));
		assert.equal(p[1].scripts, false);
	}
	assert.equal(p[2].kind, "text");
});

test("splitHtmlParts: 嵌套同名 div 深度配平", () => {
	const text = "<div><div>内</div></div>后文";
	const p = splitHtmlParts(text);
	assert.equal(p[0].kind, "html");
	if (p[0].kind === "html") assert.equal(p[0].html, "<div><div>内</div></div>");
	assert.equal(p[1].kind, "text");
});

test("splitHtmlParts: 自定义标签不触发块切分(留给 statusBlocks)", () => {
	const p = splitHtmlParts("<StatusBlock>\nHP: 80\n</StatusBlock>");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
});

test("splitHtmlParts: 行中 <div>(非行首)不切,避免误伤叙事里的尖括号", () => {
	const p = splitHtmlParts("他说 <div> 不是标签");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
});

test("splitHtmlParts: 未闭合 div 当普通文本", () => {
	const p = splitHtmlParts("<div>没有闭合");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
});

test("isFullInterface: 整条消息即界面", () => {
	assert.equal(isFullInterface('<div style="x">全屏界面</div>'), true);
	assert.equal(isFullInterface("<!DOCTYPE html><html><body>x</body></html>"), true);
	assert.equal(isFullInterface("正文\n<div>局部</div>"), false);
	assert.equal(isFullInterface("纯正文"), false);
});

test("splitHtmlParts: 裸整份文档带【开场】前缀——整份进一帧，不被切碎", () => {
	// 梨园自己给开场白加「【开场 · 卡名】\n」(greeting.ts:16)。围栏那条判据一直容忍这个前缀，
	// 裸文档这条原先要求文档落在第 0 位 → 整份文档被按顶层元素切成一堆碎帧（v1.4.1 实锤）。
	const doc = '<html>\n<style>\n.gj-wrap{color:#fff}\n</style>\n<div class="gj-wrap"><p>一</p></div>\n<div class="gj-nav">二</div>\n</html>';
	const p = splitHtmlParts(`【开场 · 某卡】\n${doc}`);
	assert.equal(p.length, 2, "前缀一段文本 + 文档一帧");
	assert.equal(p[0].kind, "text");
	assert.equal(p[1].kind, "html");
	assert.ok(p[1].kind === "html" && p[1].html.includes("<style>"), "<style> 留在帧内");
	assert.ok(p[1].kind === "html" && p[1].html.includes("gj-nav"), "文档尾部也在同一帧里");
});

test("splitHtmlParts: 前缀 + 裸文档 + 文档后的内容——文档一帧，尾巴照常另行认领", () => {
	const doc = "<!doctype html>\n<html><body><p>页</p></body></html>";
	const p = splitHtmlParts(`【开场 · 某卡】\n${doc}\n\n收尾叙事一句。`);
	assert.equal(p.filter((x) => x.kind === "html").length, 1, "只认一份文档");
	const tail = p[p.length - 1];
	assert.equal(tail.kind, "text");
	assert.ok(tail.kind === "text" && tail.text.includes("收尾叙事"), "文档之后的文本不被卷进帧");
});

test("looksLikeHtmlDocument: 带前缀时仍为 false（前缀容忍只做在 splitHtmlParts 里）", () => {
	assert.equal(looksLikeHtmlDocument("【开场 · 某卡】\n<html><body>x</body></html>"), false);
});
