import { describe, expect, test } from "bun:test";
import { actionFromArgs, type Action, type ActionParseError } from "../shared/actions";

const isError = (r: Action | ActionParseError): r is ActionParseError => !("action" in r);

describe("actionFromArgs", () => {
  test("click 合法", () => {
    expect(actionFromArgs("click", { ref: 3 })).toEqual({ action: "click", ref: 3 });
    expect(actionFromArgs("click", { ref: 3, button: "right" })).toEqual({ action: "click", ref: 3, button: "right" });
  });

  test("click 缺 ref 或非法 button 拒绝", () => {
    expect(isError(actionFromArgs("click", {}))).toBe(true);
    expect(isError(actionFromArgs("click", { ref: 0 }))).toBe(true);
    expect(isError(actionFromArgs("click", { ref: 1, button: "xx" }))).toBe(true);
  });

  test("type 合法与非法", () => {
    expect(actionFromArgs("type", { ref: 2, text: "hi", clear: true })).toEqual({
      action: "type",
      ref: 2,
      text: "hi",
      clear: true,
    });
    expect(isError(actionFromArgs("type", { ref: 2 }))).toBe(true);
  });

  test("press 合法与非法", () => {
    expect(actionFromArgs("press", { key: "Enter" })).toEqual({ action: "press", key: "Enter" });
    expect(isError(actionFromArgs("press", { key: "Ctrl" }))).toBe(true);
  });

  test("select / hover", () => {
    expect(actionFromArgs("select", { ref: 4, value: "a" })).toEqual({ action: "select", ref: 4, value: "a" });
    expect(actionFromArgs("hover", { ref: 4 })).toEqual({ action: "hover", ref: 4 });
    expect(isError(actionFromArgs("hover", {}))).toBe(true);
  });

  test("scroll 可选参数", () => {
    expect(actionFromArgs("scroll", { dir: "down" })).toEqual({ action: "scroll", dir: "down" });
    expect(actionFromArgs("scroll", { dir: "down", amount: 500, ref: 1 })).toEqual({
      action: "scroll",
      dir: "down",
      amount: 500,
      ref: 1,
    });
    expect(isError(actionFromArgs("scroll", { dir: "sideways" }))).toBe(true);
  });

  test("goto 只允许 http(s)", () => {
    expect(actionFromArgs("goto", { url: "https://a.com" })).toEqual({ action: "goto", url: "https://a.com" });
    expect(isError(actionFromArgs("goto", { url: "javascript:alert(1)" }))).toBe(true);
  });

  test("wait_for 时间/UI 条件二选一,ms 上限 60s", () => {
    expect(actionFromArgs("wait_for", { ms: 2000 })).toEqual({ action: "wait_for", ms: 2000 });
    expect(actionFromArgs("wait_for", { ms: 100_000 })).toEqual({ action: "wait_for", ms: 60_000 });
    expect(actionFromArgs("wait_for", { selector: "#btn" })).toEqual({ action: "wait_for", selector: "#btn" });
    expect(actionFromArgs("wait_for", { text: "加载完成" })).toEqual({ action: "wait_for", text: "加载完成" });
    expect(isError(actionFromArgs("wait_for", {}))).toBe(true);
    expect(isError(actionFromArgs("wait_for", { ms: 500, selector: "#btn" }))).toBe(true);
    expect(isError(actionFromArgs("wait_for", { selector: "#btn", text: "x" }))).toBe(true);
  });

  test("back/refresh 无参", () => {
    expect(actionFromArgs("back", {})).toEqual({ action: "back" });
    expect(actionFromArgs("refresh", {})).toEqual({ action: "refresh" });
  });
});
