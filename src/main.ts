/**
 * 入口 —— DOM 渲染层（替代 Phaser）。
 *
 * 两个视图：夜班列表（菜单）与病房（WardView）。
 * 深链接语义与旧 Boot 场景一致：?level= / ?unlock= / ?dev=。
 *
 * 导航与网址同步：
 * - 菜单进关卡 → pushState 入栈，浏览器前进/后退与页面视图一致；
 * - 病房点「返回」→ 有我们压入的历史就 history.back()（网址同步回上一级），
 *   深链接直达（无历史标记）则清掉 level 参数原地回菜单，不误退出去。
 */
import "./ui/app.css";
import { routeFromParams, renderMenu } from "./ui/menu-view";
import { WardView } from "./ui/ward-view";

const root = document.getElementById("app")!;

function showMenu(): void {
  renderMenu(root, openLevel);
}

function exitToMenu(): void {
  if (history.state?.level) {
    history.back(); // popstate 里统一渲染
  } else {
    history.replaceState(null, "", location.pathname);
    showMenu();
  }
}

function openLevel(levelId: string): void {
  history.pushState({ level: levelId }, "", `?level=${levelId}`);
  new WardView(root, levelId, exitToMenu).mount();
}

window.addEventListener("popstate", () => {
  const r = routeFromParams();
  if (r.levelId) new WardView(root, r.levelId, exitToMenu).mount();
  else showMenu();
});

const route = routeFromParams();
if (route.levelId) {
  // 深链接/刷新直达：不设历史标记，「返回」走原地清参，不会误退出去
  new WardView(root, route.levelId, exitToMenu).mount();
} else {
  showMenu();
}
